# Agent 感知架构设计

> 基于 unity-mcp-server v2.30.0 研究，为 godot-mcp-enhanced 引入多 Agent 并发支持、多实例路由、状态持久化、懒加载。

**状态**：已批准
**版本**：1.0
**日期**：2026-06-10
**影响版本**：v0.18.0 → v0.20.0

---

## 背景

godot-mcp-enhanced 当前为单 Agent 设计，随着 Claude Cowork 等多 Agent 客户端普及，需要：

1. **多 Agent 并发**：多个 Agent 同时操作同一或不同 Godot 实例
2. **多实例路由**：补全已有的实例发现框架，实现实际路由分发
3. **状态持久化**：跨进程重启保持连接状态和配置
4. **懒加载**：新增 Godot 端工具无需 MCP 侧代码改动

### 与 unity-mcp-server 的关键差异

| 维度 | unity-mcp-server | godot-mcp-enhanced 本设计 |
|------|-----------------|-------------------------|
| 工具数 | 288（双层元工具） | 39（Profile/Group + 元工具） |
| 引擎特性 | 编辑器 HTTP REST | Headless + Editor WS + TCP Bridge |
| 队列策略 | C# 插件内公平轮转 | TS 侧 FIFO + 引擎/IO 分离 |
| 类型安全 | 纯 JS | TypeScript 全程类型化 |

### 现有代码基础

- **34 工具模块**，39 MCP 工具，16 工具组，6 配置文件
- **多实例发现**：`InstanceManager` 已有注册表读取 + stale 检测；`InstanceRouter` 通过 DI 接收 `sendToInstance`，但 `GodotServer` 注入的实现尚未完成实际的 HTTP 请求逻辑
- **重连管理**：`ReconnectionManager` 已有指数退避（10 次，800ms-30s，50-100% jitter）
- **无 Agent 跟踪、无状态持久化、无动态工具发现**

---

## Phase 1（v0.18.0）：Agent 基础 + 状态持久化

### 1.1 Agent 上下文管理器

**新增文件**：`src/core/agent-context.ts`

#### 类型定义

```typescript
interface InstanceRef {
  type: 'port' | 'path';
  value: string;  // "65001" 或 "D:/projects/CardGame"
}

interface ProjectContext {
  sceneTree: SceneSnapshot | null;
  scriptPaths: string[];
  lastValidation: number;
}

interface AgentState {
  agentId: string;
  selectedInstance: InstanceRef | null;
  activeProfile: string;
  contextCache: Map<string, ProjectContext>;
  lastSeen: number;
  isEphemeral: boolean;  // true = 子代理，用完即清
}
```

#### AgentContextManager

```typescript
const DEFAULT_AGENT_ID = '__default__';
const EPHEMERAL_AGENT_TTL = 30 * 60 * 1000; // 30 分钟

class AgentContextManager {
  private agents: Map<string, AgentState>;
  private cleanupInterval: ReturnType<typeof setInterval> | null;

  // 引擎操作队列（Godot 单线程 → 全部串行）
  private engineQueue: Array<{
    agentId: string;
    op: () => Promise<unknown>;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }>;
  private engineRunning: boolean;

  getOrCreate(agentId: string | undefined): AgentState;
  remove(agentId: string): void;

  // 引擎操作 — FIFO 串行（Godot 主线程单线程）
  enqueueEngine<T>(op: () => Promise<T>): Promise<T>;

  // 文件/缓存操作 — 可并发
  enqueueIO<T>(op: () => Promise<T>): Promise<T>;

  // 定期清理过期 ephemeral agent
  private cleanup(): void;
}
```

#### 关键决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 引擎操作 vs IO | 引擎全部串行，IO 可并发 | Godot 主线程单线程 |
| 队列策略 | FIFO | Phase 1 够用，Phase 2 再加优先级 |
| Agent 生命周期 | ephemeral 30 分钟 TTL | 子代理用完即清，避免内存泄漏 |
| 无 agentId 时 | 回退 `__default__` | 兼容直接 MCP 客户端调用 |

#### 与现有代码的集成点

- `ToolDispatcher.dispatch()` 提取 `_meta.agentId`，传入 AgentContextManager
- `ToolRegistry.getFilteredTools(agentId)` 按 agent 的 activeProfile 返回工具
- `InstanceRouter` 使用 agent 的 `selectedInstance` 路由请求

### 1.2 状态持久化

**新增文件**：`src/core/state-store.ts`

#### 持久化数据结构

```typescript
interface PersistedState {
  version: 1;
  savedAt: number;  // Unix ms

  agents: Record<string, {
    selectedInstance: InstanceRef | null;
    activeProfile: string;
    contextMeta: { scenePath: string; fetchedAt: number } | null;
  }>;

  globalProfile: string;
  lastConnectedPort: number | null;
}
```

#### FileStateStore

```typescript
class FileStateStore {
  private filePath: string;
  private dirty: boolean;
  private flushTimer: ReturnType<typeof setTimeout> | null;

  constructor(projectPath?: string);

  // 加载 — 启动时调用一次
  load(): PersistedState | null;

  // 保存 — 传入 getter 而非值，确保 flush 时取最新
  markDirty(getState: () => PersistedState): void;

  // 立即刷盘 — 进程退出时
  flush(): void;

  // 验证加载的数据
  private validate(state: PersistedState): PersistedState;
}
```

#### 存储位置

| 场景 | 路径 |
|------|------|
| 有项目 | `{project}/.godot/mcp-state.json`（跟随项目） |
| 无项目 | `$HOME/.godot-mcp/state.json`（全局回退） |

`mcp-state.json` 自动追加到 `.gitignore`。

#### 不持久化的内容

| 数据 | 原因 |
|------|------|
| contextCache 内容 | 可能数百 KB，场景变化后立即过期 |
| ephemeral agent 状态 | 30 分钟 TTL 的子代理不写入文件 |
| 引擎连接状态 | 重启后必须重新连接 |

#### 启动恢复流程

```
FileStateStore.load()
  → 如果有持久化数据
  → 丢弃 savedAt > 24 小时的非活跃持久 agent
  → 恢复每个存活 agent 的实例选择和 profile
  → AgentContextManager 从恢复数据初始化
```

#### 关闭流程

```
process.on('SIGTERM' / 'exit')
  → flush() 立即刷盘
```

#### 运行中写入

```
AgentContextManager 状态变更
  → markDirty(() => currentSnapshot()) 防抖 2 秒
```

---

## Phase 2（v0.19.0）：多实例路由补全

### 2.1 实例管理增强

**修改文件**：`src/core/instance-manager.ts`

#### 显式状态信号（扩展现有 InstanceInfo）

```typescript
// 现有字段保持不变，仅追加 Phase 2 新增字段
interface InstanceInfo {
  // 现有字段（来自 src/core/instance-manager.ts）
  id: string;
  port: number;
  pid: number;
  lastSeen: string;        // 保持 ISO 8601（现有格式）
  godotVersion: string;
  projectName: string;
  projectPath: string;
  capabilities: string[];

  // Phase 2 新增（可选，旧插件不写此字段）
  status?: 'ready' | 'compiling' | 'unresponsive';
  registeredAt?: number;
}
```

**Godot 端职责**：
- `EditorPlugin._build()` 钩子捕获编译开始，写入 `status: 'compiling'`
- 编译结束写回 `status: 'ready'`
- 每 30 秒心跳更新 `lastSeen`

**MCP 端判定逻辑**：
- `status === 'compiling'` → 保持选择，不触发重新发现
- `status === 'ready'` && `Date.parse(lastSeen)` 距今 > 70 秒 → 判定崩溃
- `status === 'unresponsive'` → 需重新发现

### 2.2 实例路由补全

**修改文件**：`src/core/instance-router.ts`

将 `sendToInstance` 从 `NOT_IMPLEMENTED` 补全为实际路由。

#### resolvePort 优先级链

```typescript
async resolvePort(agentId: string): Promise<number | null> {
  const state = agentCtx.getOrCreate(agentId);
  if (!state.selectedInstance) return null;

  // 1. 原端口仍可达 → 直接用
  // 2. 同 projectPath 多实例 → 选最近心跳的（最活跃）
  // 3. 唯一实例 → 用它
  // 4. 无匹配 → null，触发重新选择
}
```

#### 多实例选择交互

```typescript
// 多实例时的返回结构
return {
  content: [{
    type: 'text',
    text: '检测到多个 Godot 实例，请选择：\n1. CardGame (port 65001)\n2. CardGame (port 65003)'
  }],
  _meta: { requiresSelection: true, instances: [...] }
};
```

### 2.3 路由总流程

```
ToolDispatcher.dispatch(toolName, args, agentId)
  │
  ├─ 是否需要引擎连接？
  │   ├─ 否（如 hub-tools, context-tools）→ 本地执行
  │   └─ 是 ↓
  │
  ▼
AgentContextManager.getOrCreate(agentId)
  → selectedInstance
  │
  ├─ null → 自动选择（单实例直选 / 多实例提示选择）
  └─ InstanceRef ↓
  │
  ▼
InstanceRouter.resolvePort(agentId)
  → 实际端口号（可能因端口亲和性变化）
  │
  ▼
InstanceRouter.sendToInstance(port, toolName, args)
  │
  ├─ 成功 → 返回结果
  ├─ 瞬态错误 → 重试（复用 ReconnectionManager 指数退避）
  └─ 不可达 → 触发重新发现 + 提示用户重新选择
```

### 2.4 与 Phase 1 Agent 隔离的交互

- 每个 Agent 独立选择实例（per-agent `selectedInstance`）
- Agent A 操作实例 X 时，不阻塞 Agent B 操作实例 Y
- 同一实例上的多 Agent 操作通过 `enqueueEngine()` 串行化

---

## Phase 3（v0.20.0）：懒加载 + 动态发现

### 3.1 动态路由推导

**修改文件**：`src/tools/godot-advanced-tool.ts`

```typescript
// 命名约定 → 路由映射
// godot_custom_light_bake → custom/light-bake
// godot_terrain_sculpt → terrain/sculpt
function toolNameToRoute(toolName: string): string {
  const ROUTE_OVERRIDES: Record<string, string> = {
    // 已知的不规则映射
  };
  if (ROUTE_OVERRIDES[toolName]) return ROUTE_OVERRIDES[toolName];

  const withoutPrefix = toolName.replace(/^godot_/, '');
  const parts = withoutPrefix.split('_');
  const category = parts[0];
  const action = parts.slice(1).join('-');
  return `${category}/${action}`;
}
```

### 3.2 godot_advanced_tool 增强

```typescript
async function handleAdvancedTool(params: {
  tool: string;
  params?: Record<string, unknown>;
}, agentId: string): Promise<ToolResult> {
  const { tool, params: toolParams } = params;

  // 1. 查找已注册工具
  const registered = registry.findTool(tool);
  if (registered) {
    return registered.handler(toolParams);
  }

  // 2. Profile 权限检查（动态工具归入 'dynamic' 组，检查该组是否在当前 profile 中）
  const profile = agentCtx.getOrCreate(agentId).activeProfile;
  if (!profile.hasGroup('dynamic')) {
    return { error: 'FORBIDDEN', message: `Profile '${profile}' 不允许动态调用工具` };
  }

  // 3. 可达性预检
  const instancePort = await resolveActivePort(agentId);
  if (!instancePort) {
    return { error: 'NO_INSTANCE', message: '无可用 Godot 实例' };
  }

  // 4. 调用 Godot 端路由
  const route = toolNameToRoute(tool);
  return sendToInstance(instancePort, route, toolParams);
}
```

#### Profile 对动态工具的控制

- 所有现有 Profile 追加 `dynamic` 组
- `full` → 包含 dynamic（自动继承：`PROFILES.full = Object.keys(TOOL_GROUPS)`，新增 dynamic 组时自动包含）
- `bridge_dev` → 包含 dynamic（Bridge 调试需要）
- `minimal`/`slim` → 不包含 dynamic（保守）
- 动态工具不受 Profile 已有 group 成员关系约束，仅检查 `dynamic` 组权限

### 3.3 错误分类

```typescript
function classifyError(status: number): 'permanent' | 'transient' {
  if (status >= 400 && status < 500) return 'permanent';  // 客户端错误
  if (status >= 500) return 'transient';                   // 服务端错误，可重试
  return 'permanent';                                      // 未知
}
```

瞬态错误复用 Phase 2 的 `ReconnectionManager` 指数退避重试。

### 3.4 新增工具：godot_list_dynamic_routes

查询 Godot 端已注册但 MCP 侧未定义的工具。

```typescript
async function listDynamicRoutes(params?: {
  category?: string;
}, agentId?: string): Promise<ToolResult> {
  // 1. 向 Godot 请求 _meta/routes
  const routes = await sendToInstance(port, '_meta/routes', params);

  // 2. 与已注册工具名对比，过滤出新增的
  const known = registry.getAllToolNames();
  const dynamic = routes.filter(r => !known.includes(r.name));

  // 3. 按类别分组返回
  return {
    categories: groupBy(dynamic, r => r.category),
    totalDynamic: dynamic.length,
    totalKnown: known.length,
  };
}
```

### 3.5 安全保障

| 机制 | 说明 |
|------|------|
| 命名前缀 | 只接受 `godot_` 前缀的工具名，防止任意路由调用 |
| 可达性预检 | 先确认有活跃实例，避免盲调用超时 |
| Profile 约束 | 动态工具受 `dynamic` 组权限控制 |
| 参数透传 | `toolParams` 原样传递，不做推断/转换 |
| 错误分类 | permanent 不重试，transient 指数退避重试 |

---

## 文件变更总览

### Phase 1（v0.18.0）

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/core/agent-context.ts` | 新增 | Agent 上下文管理器 + 请求队列 |
| `src/core/state-store.ts` | 新增 | 文件状态持久化 |
| `src/core/ToolDispatcher.ts` | 修改 | 提取 agentId，注入 AgentContext；`getFilteredTools(agentId)` 支持 per-agent profile |
| `src/core/tool-registry.ts` | 修改 | Agent profile 解析支持 |
| `src/GodotServer.ts` | 修改 | 启动恢复 + 关闭刷盘 + `_meta` 传递 |

### Phase 2（v0.19.0）

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/core/instance-manager.ts` | 修改 | 显式 status 字段 + 编译期弹性 |
| `src/core/instance-router.ts` | 修改 | `sendToInstance` 实际路由 + resolvePort |
| `src/core/agent-context.ts` | 修改 | per-agent 实例选择 |
| Godot 端插件 | 修改 | `_build()` 钩子写入 status |

### Phase 3（v0.20.0）

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/tools/godot-advanced-tool.ts` | 修改 | 动态路由推导 + Profile 检查 + 错误分类 |
| `src/core/tool-registry.ts` | 修改 | `TOOL_GROUPS` 追加 `dynamic` 组；`PROFILES` 更新（`full` 自动继承） |
| Godot 端插件 | 修改 | `_meta/routes` 端点 |

---

## 测试策略

### Phase 1

- `AgentContextManager` 单元测试：创建/获取/清理/队列行为
- `FileStateStore` 单元测试：读写/防抖/验证/过期清理
- 集成测试：`_meta.agentId` 端到端传递
- 压力测试：多 Agent 并发引擎操作（FIFO 串行验证）

### Phase 2

- `InstanceRouter` 单元测试：resolvePort 优先级链
- `InstanceManager` 单元测试：status 信号判定
- 集成测试：多实例选择 + 路由 + 端口亲和性

### Phase 3

- `toolNameToRoute` 单元测试：命名约定覆盖
- `classifyError` 单元测试：HTTP 状态码分类
- 集成测试：动态工具发现 + 调用 + Profile 约束
