# 竞品借鉴改进设计文档

> 日期：2026-06-08
> 来源：game-engine-mcp-cross-analysis.md 竞品深度对比分析
> 策略：方案 A — 渐进增强（复用已有 16 组 + 5 Profile 架构）
> 竞品参考：UnrealMCPBridge、unity-mcp-server (AnkleBreaker)、Unreal_mcp (ChiR24)、unity-mcp (CoplayDev)

---

## 总览

### 调整后 Phase 顺序

```
Phase 1   → Tag 过滤动态管理（工具分组 + manage_tools 元工具）
Phase 2   → 基础安全模块（sanitizePath + CommandValidator）
            + 多实例发现（注册表 + 端口扫描 + 实例选择）
Phase 3a  → 懒加载代理（godot_advanced_tool + 路由派生）
Phase 3b  → 响应控制（截断 2MB/4MB + 分页 page_size/cursor）
Phase 4   → 剩余安全 + 优雅降级（健康监控 + 自动重连 + 离线模式）
Phase 5   → Resources 扩展 + Prompts + Elicitation + Context 注入
```

### 最终中间件链

```
ToolDispatcher.dispatch() 中间件执行顺序：

1. contextNotify      — Phase 5d（启动时通知，非强制注入）
2. groupFilter        — Phase 1（isToolAllowed 组过滤）
3. pathSecurity       — Phase 2a（sanitizePath 路径校验）
4. connectionCheck    — Phase 4c（离线/连接分级）
5. elicitation        — Phase 5c（缺参数时询问）
6. executeTool        — 执行
7. responseLimiter    — Phase 3b（截断/分页）
8. healthSample       — Phase 4a（健康采样埋点）
```

---

## Phase 1：Tag 过滤动态管理

### 现状

`tool-registry.ts` 已有 `TOOL_GROUPS`（16 组）和 `ToolDispatcher.getFilteredTools()`（按 Profile 过滤），但：
- 过滤仅在启动时生效，运行时不能动态切换
- 没有暴露给客户端的 `manage_tools` 元工具
- 没有 `notifications/tools/list_changed` 通知

### 设计

#### 1. 工具定义加 Tag

`module-loader.ts` 注册时自动注入 `annotations.tags`，37 个工具模块零改动：

```typescript
// 自动注入，不改工具模块代码
{ name: 'scene_read_scene', description: '...', inputSchema: {...},
  annotations: { tags: ['group:core'] } }
```

组标签映射复用现有 `TOOL_GROUPS`。

#### 2. TOOL_GROUPS 增加 requires 字段

```typescript
export const TOOL_GROUPS: Record<string, {
  description: string;
  tools: string[];
  requires: ('bridge' | 'editor' | 'headless')[];
  protected?: boolean;
}> = {
  core:       { description: '核心工具', tools: [...], requires: [], protected: true },
  bridge:     { description: 'Game Bridge', tools: ['game'], requires: ['bridge'] },
  editor:     { description: '编辑器', tools: ['editor'], requires: ['editor'] },
  animation:  { description: '动画系统', tools: ['animation','animtree','animation_track'], requires: [] },
  physics:    { description: '物理/导航', tools: ['physics','node_create_3d','nav'], requires: [] },
  visual:     { description: '视觉', tools: ['material','screenshot','particles'], requires: [] },
  audio:      { description: '音频', tools: ['audio'], requires: [] },
  ui:         { description: 'UI', tools: ['ui'], requires: [] },
  tilemap:    { description: 'TileMap', tools: ['tilemap','scene_commit'], requires: [] },
  signal:     { description: '信号', tools: ['signal'], requires: [] },
  profiler:   { description: '性能分析', tools: ['profiler','workflow'], requires: [] },
  test:       { description: '测试', tools: ['test','verify_delivery'], requires: [] },
  code:       { description: '代码工具', tools: ['docs','templates','batch','game_design'], requires: [] },
  ik:         { description: 'IK', tools: ['ik'], requires: [] },
  recording:  { description: '录制', tools: ['recording'], requires: ['bridge'] },
};
```

#### 3. manage_tools 元工具

始终可用（不可被禁用），支持 5 个操作，使用 discriminated union inputSchema：

| 操作 | 说明 |
|------|------|
| `list_groups` | 返回所有组名、描述、启用状态 |
| `activate` | 启用指定组（支持组名数组） |
| `deactivate` | 停用指定组（core 组不可停用） |
| `sync` | 遍历所有组，检查 `requires` 条件与当前连接状态匹配，自动启用/停用 |
| `reconnect` | 手动触发重连（Phase 4 扩展） |

批量操作（activate/deactivate 多个组）触发 1 次 `notifications/tools/list_changed`，在 `setGroups()` 完成所有变更后统一发送。

#### 4. 运行时动态过滤

`ToolDispatcher` 维护 `activeGroups: Set<string>`（默认从 Profile 初始化）。`getFilteredTools()` 实时按 `activeGroups` 过滤。

#### 5. 运行时拦截

`ToolDispatcher.dispatch()` 入口加 `isToolAllowed(name)` 检查：
- in-flight 请求不中断，正常完成
- 新请求被拒绝，返回"XX 组已停用"错误

#### 6. 生命周期

- `activeGroups` 连接级，不持久化
- 每次 MCP server 启动回到 Profile 默认值
- 多实例场景的跨实例状态同步留给后续考虑

### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/core/tool-registry.ts` | 添加 `activeGroups` 管理、`setGroups()`/`getGroups()`、`requires` 字段 |
| `src/core/ToolDispatcher.ts` | `getFilteredTools()` 实时按 Tag 过滤 + `isToolAllowed()` 拦截 |
| `src/tools/manage-tools.ts` | **新建**，manage_tools 元工具 |
| `src/core/module-loader.ts` | 注册时自动加 `annotations.tags` |
| `src/GodotServer.ts` | 监听组变更，发送 notification |
| 37 个工具模块 | 无改动 |

### 关键约束

- `core` 组和 `manage_tools` 本身永远不可被禁用
- Profile 仍然作为启动时的初始配置
- 向后兼容：不调用 `manage_tools` 时行为与现在完全一致

---

## Phase 2：基础安全模块 + 多实例发现

### 2a — 路径安全

#### sanitizePath()

新建 `src/core/path-security.ts`：

```typescript
sanitizePath(path: string, opts?: { allowedRoots?: string[] }): string
```

| 步骤 | 说明 |
|------|------|
| 1. 标准化 | `\` → `/`，合并 `//` → `/` |
| 2. 遍历检测 | 包含 `..` → throw |
| 3. 前缀白名单 | 默认 `res://`、`user://`，追加模式不可移除默认 |
| 4. 非法字符 | `<>:"\|?*` + 控制字符 `\x00-\x1f` |
| 5. 返回 | 标准化后的路径 |

**allowedRoots 规则**：
- 默认白名单：`res://`、`user://`
- 环境变量 `GODOT_MCP_ALLOWED_ROOTS=D:/custom-assets,D:/shared-resources` — 追加到默认白名单
- `opts.allowedRoots` — 调用级临时追加，不可移除默认白名单
- 不允许移除默认条目

#### CommandValidator

新建 `src/core/command-validator.ts`：

```typescript
validateGdscriptCommand(code: string): { safe: boolean; reason?: string; priority?: number }
```

| 类别 | 拦截内容 |
|------|----------|
| **危险引擎 API** | `OS.crash`、`Engine.quit`、`OS.exit`、`get_tree().quit()` |
| **Shell 注入** | `OS.execute`、`OS.shell_open`（已有，加强） |
| **文件系统** | `FileAccess.open`、`DirAccess.open`（已有，保留） |
| **优先级分类** | 1=重操作，5=中等，9=轻操作（为未来节流准备） |

**与现有沙箱的关系**：串联执行。先 `scanGdscriptSandbox()`（正则快扫）→ 再 `validateGdscriptCommand()`（结构化验证）→ 放行。

**安全声明**：CommandValidator 是 best-effort 防护，不保证覆盖所有动态调用变体（如 `call()`/`funcref()` 间接调用、字符串拼接 API 名）。真正的沙箱隔离需要进程级方案。

#### 接入点

`ToolDispatcher.dispatch()` 中间件 `pathSecurity`，对所有涉及 `scene_path`、`script_path`、`resource_path` 参数的工具调用前统一校验。

### 2b — 多实例发现

#### 架构

新建 `src/core/instance-manager.ts`：

```
InstanceManager
  ├─ 机器级注册表：~/.godot-mcp/instances/uuid-xxx.json
  ├─ 项目级注册表：{project}/.godot/mcp-instances/uuid-xxx.json
  ├─ 端口范围：9081-9090（可配置）
  └─ instances: Map<instanceId, InstanceInfo>
```

#### 两级注册表（每实例独立文件）

每个运行中的 Godot 实例写独立 JSON 文件，解决并发写入竞态：

```
~/.godot-mcp/instances/
  ├─ uuid-xxx.json   # 实例 A 自写自删
  └─ uuid-yyy.json   # 实例 B 自写自删
```

实例条目内容：

```json
{
  "id": "uuid-xxx",
  "projectPath": "D:/projects/my-game",
  "projectName": "my-game",
  "port": 9081,
  "pid": 12345,
  "lastSeen": "2026-06-08T12:00:00Z",
  "godotVersion": "4.4"
}
```

发现顺序：先读机器级 → 再读项目级 → 合并去重。

#### 发现流程

```
1. 读机器级注册表 → 已知实例
2. 读项目级注册表 → 补充项目特有实例
3. 端口扫描 9081-9090 → 发现未注册实例
4. 验证：每个端口 ping 一次，确认存活 + 项目匹配
5. 编译时恢复：Bridge 临时不可用时，信任注册表 lastSeen
```

#### 僵尸实例检测

超时阈值 = 心跳间隔 × 2 + 网络抖动余量 = 30s × 2 + 10s = 70s

```typescript
type InstanceStatus = 'alive' | 'stale' | 'unreachable';
// alive: lastSeen < 70s 且 ping 成功
// stale: lastSeen > 70s 且 ping 成功（允许选择，返回警告）
// unreachable: ping 失败（拒绝选择）
```

#### 实例选择策略

- 0 实例 → 返回错误
- 1 实例 → 自动选择
- 2+ 实例 → 需要显式选择

选中实例的生命周期：连接级，不持久化。

#### 新增工具

| 工具 | 说明 |
|------|------|
| `godot_list_instances` | 列出所有发现的实例（id/项目/端口/状态） |
| `godot_select_instance` | 选择实例（id 或 project_path），后续调用路由到该实例 |

#### 安全保障

- 路径校验：注册表文件路径由 `sanitizePath()` 保护
- 端口范围限制：仅扫描 9081-9090
- 本地绑定：Bridge 始终 127.0.0.1
- 项目匹配验证：端口上的实例必须返回匹配的 projectPath

### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/core/path-security.ts` | **新建**，sanitizePath |
| `src/core/command-validator.ts` | **新建**，validateGdscriptCommand |
| `src/core/instance-manager.ts` | **新建**，InstanceManager |
| `src/tools/instance-tools.ts` | **新建**，godot_list_instances + godot_select_instance |
| `src/core/ToolDispatcher.ts` | dispatch 入口加路径校验中间件 |
| `src/gdscript-executor.ts` | 沙箱链串联 CommandValidator |
| `scripts/mcp_bridge.gd` | Bridge autoload 增加注册表写入（心跳更新 lastSeen） |

---

## Phase 3a：懒加载代理

### 目标

核心工具直接暴露，高级工具通过 `godot_advanced_tool` 代理访问，减少客户端工具列表噪音。

### 架构

```
客户端看到的工具列表：
├─ core 工具（~40 个，直接暴露）
├─ manage_tools（元工具，始终可见）
├─ godot_list_instances / godot_select_instance（实例管理）
└─ godot_advanced_tool（代理，访问 ~70 个高级工具）
```

### godot_advanced_tool 设计

```typescript
{
  tool_name: string,        // 要调用的工具名，如 'animation_play'
  arguments: object,        // 传给目标工具的参数
}
```

#### 路由派生

通过 `TOOL_GROUPS` 反查工具所属模块：

```typescript
function findModuleForTool(toolName: string): string {
  // 'animation_play' → 'animation'
  // 'animtree_set_blend' → 'animtree'
  // 'physics_raycast' → 'physics'
}
```

#### 与 Phase 1 Tag 过滤的关系

- 激活的组 → 工具直接暴露（客户端看到独立工具）
- 停用的组 → 工具只能通过代理访问（客户端只看到 `godot_advanced_tool`）

组变更时代理的 description 自动更新，列出代理可达的工具名和简述。

#### LLM 可发现性

代理的 description 动态列出当前可用的代理工具：

```typescript
description: `Proxy for advanced Godot tools. Currently available:\n` +
  deactivatedGroups.flatMap(g => g.tools.map(t => `- ${t}: ${t.description}`)).join('\n') +
  `\n\nCall with { tool_name: "<name>", arguments: {...} }`
```

组变更（`notifications/tools/list_changed`）后自动更新。

#### 错误反馈

无效 tool_name 返回结构化建议：

```json
{
  "error": "Unknown tool 'animaton_play'. Did you mean one of?",
  "suggestions": ["animation_play", "animation_stop", "animation_seek"],
  "available_tools": ["animation_play", "animation_stop", ...]
}
```

### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/tools/advanced-proxy.ts` | **新建**，godot_advanced_tool 代理 |
| `src/core/ToolDispatcher.ts` | `getFilteredTools()` 改为：激活组直接暴露 + 代理始终暴露 |
| `src/core/tool-registry.ts` | 新增 `findModuleForTool()` 反查函数 |

---

## Phase 3b：响应控制

### 截断策略

双阈值（参考 AnkleBreaker），使用结构化截断（MCP content 数组，数据与警告分离）：

```typescript
const SOFT_LIMIT = 2 * 1024 * 1024;  // 2MB
const HARD_LIMIT = 4 * 1024 * 1024;  // 4MB

function truncateResponse(response: ToolResult): ToolResult {
  const size = JSON.stringify(response).length;
  if (size > HARD_LIMIT) {
    return [
      { type: 'text', text: truncateToLimit(response, HARD_LIMIT) },
      { type: 'text', text: '[Response truncated at 4MB. Use page_size for targeted results.]' }
    ];
  }
  if (size > SOFT_LIMIT) {
    return [
      { type: 'text', text: response },
      { type: 'text', text: '[Warning: Response exceeds recommended size. Consider using page_size.]' }
    ];
  }
  return response;
}
```

### 分页支持

高输出工具添加 `page_size` + `cursor` 参数：

| 工具 | 分页方式 |
|------|----------|
| `query_scene_tree` | `page_size` + `cursor`（base64 编码 offset） |
| `validate_scripts` | `page_size` + `cursor` |
| `validate_project` | `page_size` + `cursor` |
| `profiler_get_data` | `page_size` + `cursor` |
| `tilemap_read` | 复用 `region` 参数 + `max_tiles` 上限（空间数据不适合 cursor） |

向后兼容：不传 `page_size` 时返回全部结果（但受截断保护）。

### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/core/response-limiter.ts` | **新建**，truncateResponse |
| `src/core/ToolDispatcher.ts` | dispatch 返回前统一调用 truncateResponse |
| 5 个高输出工具 | inputSchema 加 `page_size` + `cursor` 或 `max_tiles` 可选参数 |

---

## Phase 4：健康监控 + 自动重连 + 优雅降级

### 4a — 健康监控

新建 `src/core/health-monitor.ts`：

```typescript
class HealthMonitor {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  responseTimes: number[];          // 滑动窗口，最近 100 个
  averageResponseTime: number;
  connectionStatus: ConnectionState;
  recentErrors: ErrorEntry[];       // 最近 20 条（MCP 协议层错误）
}
```

| 参数 | 值 | 说明 |
|------|-----|------|
| 心跳间隔 | 30s | 正常模式 |
| 探测间隔 | 60s | 暂停后降频探测 |
| Ping 命令 | Bridge `ping` / Editor 轻量查询 | 按连接模式选择 |
| 自动暂停 | 连续 5 次失败 | 降频为探测模式（不停止） |
| 恢复条件 | 探测成功 1 次 | 立即恢复正常 30s 心跳 |
| 响应时间采样 | 100 个 | 滑动窗口 |
| 错误记录 | 20 条 | 含 time/scope/type/message/retriable |

### 4b — 连接状态机

```
                    ┌──────────────────────┐
                    │    disconnected      │ ← 初始状态 / 重连耗尽
                    └──────────┬───────────┘
                               │ 连接建立 / 手动 reconnect
                               ▼
                    ┌──────────────────────┐
                    │      connected       │ ← 正常工作
                    └──────────┬───────────┘
                          ↕ 健康检查
                    ┌──────────────────────┐
                    │      degraded        │ ← 间歇性问题
                    └──────────┬───────────┘
                               │ 连续 5 次失败
                               ▼
                    ┌──────────────────────┐
                    │    reconnecting      │ ← 指数退避重连
                    └──────────┬───────────┘
                     ┌────────┴────────┐
                  成功                 耗尽
                     ▼                  ▼
                connected         disconnected
```

**degraded 触发条件**（满足任一）：
- 最近 10 个请求中 ≥ 3 个失败
- 平均响应时间 > 2 × 正常基线（首次 10 个请求的均值）

### 4c — 自动重连

```typescript
class ReconnectionManager {
  maxRetries: number;          // 默认 10 次
  baseDelay: number;           // 800ms
  maxDelay: number;            // 30s
}
```

| 连接类型 | 重连策略 |
|----------|----------|
| Bridge | 指数退避（800ms → 1.6s → ... → 30s cap） |
| Editor WebSocket | 同上 |
| Headless | 无需重连（按需启动新进程） |

**重连后自动操作**：
1. 更新 `connectionStatus`
2. 触发 `sync`（检查 requires 条件，自动启用/停用组）
3. 发送 `notifications/tools/list_changed`（如果组有变化）

**重连耗尽后**：
- 转为 `disconnected` 状态
- 发送 `notifications/message` 通知客户端连接已丢失
- 等待手动 `manage_tools reconnect` 操作触发新一轮重连

### 4d — 优雅降级

MCP server 在没有 Godot 连接时仍可启动并提供有限服务：

| 模式 | 可用功能 |
|------|----------|
| **离线** | 项目配置读取、脚本语法验证、CLAUDE.md 规则查询、manage_tools 列表操作 |
| **连接中** | 同离线 + 实例发现、健康监控只读 |
| **已连接** | 全部功能 |

实现：工具模块可选 `offlineCapable?: boolean`，`connectionCheck` 中间件根据连接状态和工具标记决定放行或拒绝。

### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/core/health-monitor.ts` | **新建**，HealthMonitor |
| `src/core/reconnection-manager.ts` | **新建**，ReconnectionManager |
| `src/core/ToolDispatcher.ts` | dispatch 中间件数组化 |
| `src/core/tool-registry.ts` | 工具定义增加 `offlineCapable` 标记 |
| `src/core/EditorConnection.ts` | 集成 ReconnectionManager |
| `src/GodotServer.ts` | 启动时不再要求连接，离线模式启动 |
| 离线可用工具 | 标记 `offlineCapable: true` |

---

## Phase 5：Resources 扩展 + Prompts + Elicitation + Context 注入

### 5a — Resources 扩展

项目已有 `godot://` URI 方案。新增 5 个 Resource：

| URI | 数据 | 离线可用 |
|-----|------|---------|
| `godot://health` | HealthMonitor 快照（连接状态/响应时间/错误） | 否 |
| `godot://instances` | InstanceManager 快照（活跃实例列表） | 部分（缓存） |
| `godot://console-errors` | Godot 运行时错误（最近 20 条，GDScript 报错/场景加载失败） | 否 |
| `godot://scene-tree` | 当前场景树快照（加大小保护，大型场景返回摘要） | 否 |
| `godot://tool-groups` | 各组启用/停用状态 + 可用工具列表 | 是 |
| `godot://project-context` | 项目文档摘要（编码规范/架构/测试结构，每类 2000 字符） | 是 |

**数据源分离**：
- `HealthMonitor.recentErrors`：MCP 协议层错误（调度失败、超时、参数错误）
- `godot://console-errors`：Godot 运行时错误（GDScript 报错、场景加载失败）
- 两个独立数据源，不合并

**`godot://scene-tree` 大小保护**：复用 Phase 3b 截断策略，大型场景返回摘要（前 N 个节点 + 总数统计）而非全量树。

### 5b — MCP Prompts

新建 `src/prompts.ts`，4 个预置 Prompt 模板：

| Prompt 名称 | 输入参数 | 产出 |
|-------------|----------|------|
| `create_platformer` | `project_name`, `resolution` | 2D 平台游戏脚手架指导 |
| `setup_player_controller` | `dimension: '2d' \| '3d'`, `movement_type` | 玩家控制器指导 |
| `optimize_scene` | `scene_path` | 场景优化分析指导 |
| `debug_performance` | — | 性能调试引导 |

Prompt 返回结构化指导文本（非代码），LLM 按步骤执行。支持不带参数调用（使用默认值）。

### 5c — Elicitation

中间件位置：在 `connectionCheck` 之后、`executeTool` 之前。

逻辑：
1. 检查 required 参数 vs 已提供的 args
2. 仅提示原始类型（string/number/boolean/enum）
3. 不提示 object/array 等复杂类型
4. 通过 MCP Elicitation API 询问
5. 客户端不支持时优雅降级为传统参数错误
6. 60 秒超时

### 5d — Project Context 注入

**方案**：通知 + 按需 Resource，不自动注入工具返回值。

服务启动连接建立后发送独立通知：

```typescript
server.notification({
  method: 'notifications/message',
  params: {
    level: 'info',
    data: '[Godot MCP] Project context available at godot://project-context. '
        + 'Read it for coding guidelines and architecture notes.'
  }
});
```

LLM 看到通知后自主决定是否读取 `godot://project-context` Resource。

Resource 内容按类别截断（每类 2000 字符，总计 ≤ 8000 字符）：
- project-overview
- coding-guidelines
- architecture
- testing

### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/resources.ts` | 新增 6 个 Resource URI |
| `src/prompts.ts` | **新建**，4 个 Prompt 模板 |
| `src/core/middleware/elicitation.ts` | **新建**，Elicitation 中间件 |
| `src/core/middleware/context-notify.ts` | **新建**，启动通知逻辑 |
| `src/core/middleware/group-filter.ts` | **新建**，从 ToolDispatcher 提取 |
| `src/core/middleware/path-security.ts` | **新建**，从 ToolDispatcher 提取 |
| `src/core/middleware/connection-check.ts` | **新建**，从 ToolDispatcher 提取 |
| `src/core/middleware/response-limiter.ts` | **新建**，从 ToolDispatcher 提取 |
| `src/core/middleware/health-sample.ts` | **新建**，健康采样埋点 |
| `src/core/ToolDispatcher.ts` | 重构为中间件数组模式 |
| `src/GodotServer.ts` | 注册 Prompt handler + 启动通知 |

---

## 新建文件清单

| Phase | 文件 | 说明 |
|-------|------|------|
| 1 | `src/tools/manage-tools.ts` | manage_tools 元工具 |
| 2a | `src/core/path-security.ts` | sanitizePath |
| 2a | `src/core/command-validator.ts` | validateGdscriptCommand |
| 2b | `src/core/instance-manager.ts` | InstanceManager |
| 2b | `src/tools/instance-tools.ts` | godot_list_instances + godot_select_instance |
| 3a | `src/tools/advanced-proxy.ts` | godot_advanced_tool 代理 |
| 3b | `src/core/response-limiter.ts` | truncateResponse |
| 4a | `src/core/health-monitor.ts` | HealthMonitor |
| 4b | `src/core/reconnection-manager.ts` | ReconnectionManager |
| 5 | `src/prompts.ts` | 4 个 Prompt 模板 |
| 5 | `src/core/middleware/*.ts` | 6 个中间件文件 |

**总计**：新建 ~15 个文件，改动 ~10 个现有文件，37 个工具模块零改动。

---

## 风险与约束

1. **CommandValidator best-effort**：动态语言的间接调用无法完全拦截，文档明确声明
2. **Bridge GDScript 改动**：多实例需要修改 `mcp_bridge.gd` 增加注册表心跳，需同步更新
3. **MCP SDK TS 版本**：当前 `^1.29.0`，Tag 过滤和 Elicitation 需要确认 SDK 支持
4. **中间件数组性能**：8 层中间件，每层有异步操作，需要关注 dispatch 延迟
5. **向后兼容**：每个 Phase 必须保持不使用新功能时的行为完全一致
