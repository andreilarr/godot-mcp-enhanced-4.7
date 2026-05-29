# I-01: 提取 ToolDispatcher 类

**日期:** 2026-05-30
**状态:** 已批准
**上下文:** v0.15.1 审查报告 I-01（GodotServer 大拆分）

## 背景

GodotServer.ts 当前 386 行，架构已比早期版本好很多（31 个工具模块独立、tool-registry 模块化、EditorConnection 分离）。但 `setupHandlers()` 方法（~163 行）仍然混合了多个横切关注点：

1. 工具列表收集 + readOnly/lite 过滤
2. 工具上下文构建 (ctx)
3. CallTool 路由（参数归一化、guard、confirm、dispatch、editor fallback）
4. Editor fallback 警告管理

这些逻辑耦合在一个匿名函数里，难以单独测试和演进。

## 目标

- 将工具调用管道提取为独立的 `ToolDispatcher` 类
- GodotServer 只负责 MCP 协议连接 + Resource 处理
- 不破坏现有 API 和测试
- 新增 ToolDispatcher 单元测试

## 架构

```
Before:                              After:
┌─────────────────────┐             ┌─────────────────────┐
│    GodotServer      │             │    GodotServer      │
│  - MCP 协议连接      │             │  - MCP 协议连接      │
│  - 工具列表过滤      │             │  - Resource 处理器   │
│  - ctx 构建         │             │  - detectProjectPath │
│  - readOnlyGuard    │             │  - run() / close()   │
│  - confirm 令牌     │             └──────────┬───────────┘
│  - editor 分发      │                        │ uses
│  - headless 分发    │             ┌──────────▼───────────┐
│  - Resource 处理器   │             │   ToolDispatcher     │
│  - detectProjectPath│             │  - 工具列表过滤       │
│  - run() / close()  │             │  - ctx 构建          │
└─────────────────────┘             │  - readOnlyGuard     │
                                    │  - confirm 令牌      │
                                    │  - editor 分发       │
                                    │  - headless 分发     │
                                    │  - fallback 警告     │
                                    └──────────────────────┘
```

## 新文件: `src/core/ToolDispatcher.ts`

### 接口

```typescript
export interface DispatcherOptions {
  readOnlyGuard: ReadOnlyGuard;
  editorExecutor?: EditorToolExecutor;
  connectionMode: 'headless' | 'editor';
  noFallback: boolean;
}

export class ToolDispatcher {
  constructor(options: DispatcherOptions);

  /** 返回过滤后的工具列表（含 confirm_and_execute 内联工具） */
  getFilteredTools(): ToolDefinition[];

  /** 处理 CallTool 请求 — 完整管道（归一化→guard→confirm→dispatch） */
  handleCall(request: { params: { name: string; arguments?: Record<string, unknown> } }): Promise<ToolResult>;

  /** 运行时切换连接模式（editor fallback 时使用） */
  setConnectionMode(mode: 'headless' | 'editor'): void;

  /** 设置/清除编辑器执行器 */
  setEditorExecutor(executor: EditorToolExecutor | null): void;
}
```

### 内部方法

```typescript
/** 参数归一化: camelCase → snake_case */
private normalizeArgs(rawArgs: Record<string, unknown> | undefined): Record<string, unknown>;

/** 路径白名单验证 */
private validatePathArgs(args: Record<string, unknown>): ToolResult | null;

/** 分发到工具模块 */
private dispatchTool(toolName: string, args: Record<string, unknown>, ctx: ToolContext, startTime: number): Promise<ToolResult>;

/** Editor fallback 警告（仅首次） */
private attachFallbackWarning(result: ToolResult): ToolResult;
```

### ctx 构建

`ctx` 对象（ToolContext）的构建也搬到 ToolDispatcher 内部，通过构造函数注入 `opsScript` 和 `findGodot` 等依赖。

## 修改文件: `src/GodotServer.ts`

### setupHandlers 简化后

```typescript
private setupHandlers(): void {
  const dispatcher = new ToolDispatcher({
    readOnlyGuard: this.readOnlyGuard,
    connectionMode: this.connectionMode,
    noFallback: this.noFallback,
  });
  this.dispatcher = dispatcher;

  this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: dispatcher.getFilteredTools(),
  }));

  this.server.setRequestHandler(CallToolRequestSchema, (request) =>
    dispatcher.handleCall(request)
  );

  // Resource handlers 不变（留在 GodotServer）
  this.server.setRequestHandler(ListResourcesRequestSchema, ...);
  this.server.setRequestHandler(ListResourceTemplatesRequestSchema, ...);
  this.server.setRequestHandler(ReadResourceRequestSchema, ...);
}
```

### 新增字段

```typescript
private dispatcher: ToolDispatcher | null = null;
```

### run() 调整

Editor fallback 时调用 `dispatcher.setConnectionMode('headless')` 和 `dispatcher.setEditorExecutor(null)`。
Editor 连接成功时调用 `dispatcher.setEditorExecutor(executor)`。

### close() 调整

无需变化（cleanup 逻辑不涉及 dispatcher）。

## 不变的部分

- **31 个工具模块的 import + registerModule 循环**：保留在 GodotServer.ts 顶层（启动时一次性操作）
- **Resource 处理器**：留在 GodotServer（逻辑简单，~17 行）
- **detectProjectPath()**：留在 GodotServer（Resource 和 Editor 连接都用）
- **dispatchTool 函数**：搬到 ToolDispatcher 作为私有方法
- **validatePathArgs 函数**：搬到 ToolDispatcher 作为私有方法
- **log / DEBUG**：搬到 ToolDispatcher 内部

## 测试策略

1. **新增** `test/core/ToolDispatcher.test.ts`：单元测试
   - getFilteredTools: readOnly 过滤、lite 过滤、confirm_and_execute 内联
   - handleCall: 参数归一化、guard 阻断、confirm 令牌流程、dispatch 分发
   - attachFallbackWarning: 仅首次附加、多次不重复
   - setConnectionMode: 模式切换

2. **保留** `test/GodotServer.test.js`：集成测试
   - 确保 MCP 协议层仍然工作
   - 可能需要微调 mock 路径（因为 GodotServer 不再直接包含 dispatch 逻辑）

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/core/ToolDispatcher.ts` | **新建** | 工具分发器类 |
| `src/GodotServer.ts` | 修改 | 提取逻辑到 dispatcher，setupHandlers 简化 |
| `test/core/ToolDispatcher.test.ts` | **新建** | Dispatcher 单元测试 |
| `test/GodotServer.test.js` | 可能修改 | 适配新的内部结构 |

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| ctx 对象循环依赖（ToolDispatcher 需要 ToolContext，但 ctx 依赖 process-state） | ctx 在 ToolDispatcher 内部构建，注入依赖（opsScript、findGodot） |
| 现有测试回归 | 先运行全量测试确认基线，实施后重新运行 |
| 过度拆分导致增加复杂度 | ToolDispatcher 是唯一的新类，不引入新的抽象层 |
