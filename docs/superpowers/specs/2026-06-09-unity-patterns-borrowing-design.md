# Unity MCP 模式借鉴设计

> 日期：2026-06-09
> 状态：设计确认
> 关联：UnrealMCPBridge 剩余项（P1/P2）与本设计完全独立，可并行实施

## 背景

对 [AnkleBreaker Unity MCP Server](https://github.com/AnkleBreaker/unity-mcp-server) v2.30.0 进行深度研究后，识别出 7 个可借鉴模式。用户选定 4 个：

| 编号 | 模式 | 价值 | 来源 |
|------|------|------|------|
| B1 | 两阶工具系统 | 降低客户端暴露工具数 | `tool-tiers.js` |
| B3 | 状态持久化 | MCP host 重启后恢复配置 | `state-persistence.js` |
| B4 | 响应截断保护 | 大场景树超限截断 | `index.js` truncateResponseIfNeeded |
| B6 | 懒加载路由 | 新工具无需重启 MCP 服务端 | `tool-tiers.js` toolNameToRoute |

**方案选择**：方案 C（运行时自举）——核心工具始终暴露 + 元工具目录发现 + 代理调用高级工具。

## 当前状态

- 52 个工具通过 48 个模块注册
- 已有 16 组 + 6 Profile 系统（full/lite/minimal/slim/bridge_dev/3d_dev）
- 已有 `godot_advanced_tool` 代理（slim 模式下调用停用工具）
- 已有响应截断 `response-limiter.ts`（双阈值 2MB/4MB + cursor 分页），但需 feature flag 启用
- 已有组动态管理 `manage_tools`

## 设计

### B1 + B6：两阶工具系统 + 懒加载路由

#### 核心原则

```
ListTools 返回：~35 核心工具 + 2 元工具（目录 + 代理）
高级工具：通过 godot_list_tools 发现 schema，通过 godot_advanced_tool 调用
```

#### 核心/高级划分

**核心层（~35 个，始终暴露）**：

| 组 | 工具 |
|---|------|
| 基础 | project, scene, script, runtime, validation |
| 游戏调试 | game, screenshot |
| 动画 | animation, animation_track |
| 视觉 | material, particles |
| 物理 | physics, node_create_3d |
| 导航 | nav |
| UI | ui |
| TileMap | tilemap |
| 信号 | signal |
| 音频 | audio |
| 测试 | test |
| 性能 | profiler |
| 工作流 | workflow |
| 代码 | docs, templates |
| 交付 | verify_delivery |
| 元工具 | manage_tools, confirm_and_execute, godot_list_tools, godot_advanced_tool |

**高级层（~17 个，按需发现）**：

| 工具 | 归组 | 原因 |
|------|------|------|
| animtree | animation | 特化场景 |
| ik | physics | 特化场景 |
| recording | recording | 依赖 Bridge 连接 |
| editor | editor | 依赖编辑器连接 |
| batch | code | 低频使用 |
| scene_commit | tilemap | 低频使用 |
| game_design | code | 特化场景 |
| godot_list_instances | multi_instance | 低频使用 |
| godot_select_instance | multi_instance | 低频使用 |

#### 新文件：`src/tools/tool-catalog.ts`

`godot_list_tools` 元工具——目录发现。

**输入 schema**：

```typescript
{
  type: 'object',
  properties: {
    group: {
      type: 'string',
      description: '按组过滤（animation/bridge/profiler 等）',
    },
    search: {
      type: 'string',
      description: '按工具名称搜索',
    },
    detailed: {
      type: 'boolean',
      description: '是否返回完整 inputSchema（默认 false，只返回名称+描述+组）',
    },
  },
}
```

**行为**：

1. 从 `tool-registry` 获取所有已注册工具定义
2. 过滤出不在 `CORE_TOOLS` 集合中的工具
3. 按 `group` / `search` 过滤
4. `detailed=true`：返回完整 `inputSchema`
5. `detailed=false`：只返回 `name` + `description` + `group`

#### 增强：`src/tools/advanced-proxy.ts`

现有 `godot_advanced_tool` 增加：

1. **schema 验证**：调用前用 `getToolDefinitions()` 查找目标工具的 schema，验证必填参数存在
2. **命名约定路由**：如果 `tool_name` 不在注册表中，尝试推导：
   ```
   animation_play → animation 模块的 handleTool('animation_play')
   physics_raycast → physics 模块的 handleTool('physics_raycast')
   ```
3. **升级提示**：首次通过代理调用某高级工具后，返回中附带：
   ```
   "提示：此工具可通过 manage_tools activate group:xxx 永久启用"
   ```

#### 增强：`src/core/tool-registry.ts`

新增：

```typescript
/** 核心工具集 — 始终暴露给 MCP 客户端 */
export const CORE_TOOLS: Set<string> = new Set([
  // 基础
  'project', 'scene', 'script', 'runtime', 'validation',
  // 游戏调试
  'game', 'screenshot',
  // 动画
  'animation', 'animation_track',
  // 视觉
  'material', 'particles',
  // 物理/3D
  'physics', 'node_create_3d',
  // 导航
  'nav',
  // UI
  'ui',
  // TileMap
  'tilemap',
  // 信号
  'signal',
  // 音频
  'audio',
  // 测试
  'test',
  // 性能
  'profiler',
  // 工作流
  'workflow',
  // 代码
  'docs', 'templates',
  // 交付
  'verify_delivery',
  // 元工具
  'manage_tools', 'confirm_and_execute',
  'godot_list_tools', 'godot_advanced_tool',
]);

export function isCoreTool(name: string): boolean {
  return CORE_TOOLS.has(name);
}

export function getAdvancedToolDefinitions(): Tool[] {
  return getAllToolDefinitions().filter(t => !CORE_TOOLS.has(t.name));
}
```

#### 增强：`src/core/ToolDispatcher.ts`

`getFilteredTools()` 在 full 模式下也应用核心过滤：

```typescript
getFilteredTools(): Tool[] {
  let allTools = getAllToolDefinitions();

  // ... 现有内联工具注册 ...

  // READ_ONLY / LITE / MINIMAL / PROFILE 过滤（不变）
  // ...

  // activeGroups 过滤（不变）
  // ...

  // ── 新增：核心/高级分层 ──
  // full 模式下也只暴露核心工具 + 元工具
  // 用户可通过 godot_list_tools 发现高级工具
  // slim/minimal/lite 模式不受影响（它们已有更严格的过滤）
  if (this.options.mode === 'full' || this.options.mode === 'slim') {
    allTools = allTools.filter(t => CORE_TOOLS.has(t.name));
  }

  return allTools;
}
```

#### 变更文件清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/core/tool-registry.ts` | 修改 | 新增 `CORE_TOOLS` Set + `isCoreTool()` + `getAdvancedToolDefinitions()` |
| `src/core/ToolDispatcher.ts` | 修改 | `getFilteredTools()` 增加核心过滤 |
| `src/tools/advanced-proxy.ts` | 修改 | 增加 schema 验证 + 命名约定路由 |
| `src/tools/tool-catalog.ts` | **新文件** | `godot_list_tools` 目录发现元工具 |
| `src/core/module-loader.ts` | 修改 | 注册 tool-catalog 模块 |
| `test/tools/tool-catalog.test.ts` | **新文件** | 目录发现测试 |
| `test/tools/advanced-proxy.test.ts` | 修改 | 更新代理测试 |

---

### B3：状态持久化

#### 持久化内容

```typescript
interface SessionState {
  version: 1;
  savedAt: number;          // Date.now()
  activeGroups: string[];   // 当前激活的组
  connectionMode: 'headless' | 'editor';
  lastProjectPath?: string;
  editorPort?: number;
}
```

#### 机制

- **文件位置**：`{os.tmpdir()}/godot-mcp-session-state.json`
  - Windows: `%TEMP%\godot-mcp-session-state.json`
  - macOS/Linux: `/tmp/godot-mcp-session-state.json`
- **TTL**：2 小时，过期自动忽略
- **写入时机**：
  - `manage_tools` 的 activate/deactivate 操作后
  - `connectionMode` 变更时
- **读取时机**：MCP 服务端启动时（`GodotServer` 构造函数中）
- **原子写入**：先写临时文件，再 `fs.renameSync`（POSIX 原子操作；Windows 上 rename 不保证原子但足够安全）

#### 变更文件清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/core/state-persistence.ts` | **新文件** | `saveState()` + `loadState()` + TTL 检查 |
| `src/GodotServer.ts` | 修改 | 启动时 `loadState()` 恢复组/模式 |
| `src/tools/manage-tools.ts` | 修改 | 组变更后调用 `saveState()` |
| `test/core/state-persistence.test.ts` | **新文件** | 持久化测试 |

---

### B4：响应截断毕业

#### 变更内容

1. **默认开启**：移除 `isFeatureEnabled('RESPONSE_LIMIT')` 门控
2. **工具特定分页提示**：截断时根据来源工具给出具体的替代命令
3. **env 覆盖保留**：`GODOT_MCP_RESPONSE_LIMIT=false` 仍可关闭（改为直接检查 env）

#### 分页提示模板

截断时根据 `toolName` 追加建议：

| 工具 | 建议 |
|------|------|
| query_scene_tree | `Use max_depth=2 and specific parent_node_path` |
| validate_scripts | `Use directory filter to validate in batches` |
| profiler get_data | `Use frame_count=60 for smaller samples` |
| find_nodes | `Use limit parameter to cap results` |
| 默认 | `Consider using pagination parameters for smaller chunks` |

#### API 变更

```typescript
// 之前
export function truncateResponse(response: ToolResult): ToolResult;

// 之后
export function truncateResponse(response: ToolResult, toolName?: string): ToolResult;
```

#### 变更文件清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/core/response-limiter.ts` | 修改 | 移除 feature flag + 增加 toolName 参数 + 工具特定提示 |
| `src/core/ToolDispatcher.ts` | 修改 | 传递 `toolName` 给 `truncateResponse()` |
| `test/core/response-limiter.test.ts` | 修改 | 移除 feature flag mock |

---

## 与 UnrealMCP 剩余项的关系

| 项目 | 文件影响 | 与本设计的依赖 |
|------|---------|---------------|
| Unreal P1（属性快捷） | `scene/helpers.ts`, `scene/index.ts` | **无** |
| Unreal P1（相机控制） | `game-bridge.ts`, bridge autoload | **无** |
| Unreal P2（多人参数） | `runtime.ts` | **无** |

所有 7 项变更（4 个 B 端 + 3 个 Unreal）互不依赖，可并行或任意顺序实施。

## 实施顺序建议

| 优先级 | 项目 | 工作量 | 原因 |
|--------|------|--------|------|
| 1 | B4 响应截断毕业 | 0.5 天 | 最简单，改动最少 |
| 2 | B3 状态持久化 | 0.5 天 | 独立，新文件 |
| 3 | B1+B6 两阶+懒加载 | 1.5 天 | 核心变更，影响面最大 |
| 4 | Unreal P1 属性快捷 | 0.5 天 | 参考已有 spec |
| 5 | Unreal P1 相机控制 | 0.5 天 | 参考已有 spec |
| 6 | Unreal P2 多人参数 | 0.5 天 | 参考已有 spec |

**总计约 4 天**。

## 测试策略

- 每个变更独立测试
- B1+B6：核心工具列表稳定性测试 + 代理调用链测试 + 目录发现测试
- B3：持久化/恢复/过期/原子写入测试
- B4：移除 feature flag 后的回归测试
- 全量测试运行确保无回归（当前 ~2253 测试）

## 风险

| 风险 | 概率 | 缓解 |
|------|------|------|
| 核心工具遗漏导致常用功能需代理调用 | 中 | 核心列表保守选择，后续可调整 |
| `ListTools` 响应仍过大（schema 本身很大） | 低 | 35 工具的 schema 总量远小于 52 |
| 状态文件在多 MCP 实例间冲突 | 低 | 使用 tmpdir（每用户独立） |
| 命名约定路由推断错误 | 低 | 仅作为 fallback，优先用注册表查找 |
