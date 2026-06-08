# 竞品借鉴改进设计文档

> 日期：2026-06-08
> 来源：game-engine-mcp-cross-analysis.md 竞品深度对比分析
> 策略：方案 A — 渐进增强（复用已有 16 组 + 5 Profile 架构）
> 竞品参考：UnrealMCPBridge、unity-mcp-server (AnkleBreaker)、Unreal_mcp (ChiR24)、unity-mcp (CoplayDev)
> 审查：2026-06-08 通过 plan-eng-review，25 项发现已修复（4C+13I+8A）

---

## 总览

### 调整后 Phase 顺序

```
Phase 1   → Tag 过滤动态管理（工具分组 + manage_tools 元工具）
Phase 2   → 基础安全模块（sanitizePath + CommandValidator）
            + 多实例发现（注册表 + 端口扫描 + 实例选择 + 路由）
Phase 3a  → 懒加载代理（godot_advanced_tool + TOOL_GROUPS 反查）
Phase 3b  → 响应控制（按元素截断 2MB/4MB + 分页 page_size/cursor）
Phase 4   → 剩余安全 + 优雅降级（健康监控 + 自动重连 + 离线模式）
Phase 5   → Resources 扩展 + Prompts + Elicitation + Context 注入
```

### Phase 依赖图

```
Phase 1 ──→ Phase 3a（代理依赖 Tag 过滤和组信息）
    │
    └──→ Phase 2a（安全模块独立，无前置依赖）
              │
              └──→ Phase 2b（多实例依赖 sanitizePath）
                      │
                      └──→ Phase 3b（响应控制独立）
                              │
                              └──→ Phase 4（依赖 Phase 1 组管理 + Phase 2 安全）
                                      │
                                      └──→ Phase 5（依赖前面所有 Phase）
```

**可独立推进的路径**：
- Phase 1 和 Phase 2a 可并行开发
- Phase 3b 不依赖 Phase 3a，可独立推进
- Phase 2b 如果延期，Phase 3a/3b/4 不受影响（多实例是独立子系统）

### Feature Flag / 禁用开关

每个 Phase 新增的功能都有环境变量级别的禁用开关：

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `GODOT_MCP_TOOL_GROUPS` | `true` | Phase 1：Tag 过滤和动态管理 |
| `GODOT_MCP_PATH_SECURITY` | `true` | Phase 2a：路径安全校验 |
| `GODOT_MCP_MULTI_INSTANCE` | `false` | Phase 2b：多实例发现（默认关闭，需显式启用） |
| `GODOT_MCP_ADVANCED_PROXY` | `false` | Phase 3a：懒加载代理（默认关闭） |
| `GODOT_MCP_RESPONSE_LIMIT` | `true` | Phase 3b：响应截断 |
| `GODOT_MCP_HEALTH_MONITOR` | `true` | Phase 4：健康监控和自动重连 |
| `GODOT_MCP_OFFLINE_MODE` | `true` | Phase 4d：离线降级 |
| `GODOT_MCP_ELICITATION` | `true` | Phase 5c：缺参询问 |

禁用时对应中间件直接跳过（`next()`），不影响其他层。这确保安全模块误杀时可以快速关闭。

### 中间件执行模型

**模型**：管道 + 后置钩子（非洋葱模型）

```typescript
// 中间件接口签名
interface Middleware {
  name: string;
  before(ctx: DispatchContext): Promise<MiddlewareResult>;  // 前置检查
  after?(ctx: DispatchContext, result: ToolResult): Promise<ToolResult>;  // 后置处理
}

interface DispatchContext {
  toolName: string;
  args: Record<string, unknown>;
  startTime: number;       // 由框架自动设置
  phase: 'before' | 'after';
}

type MiddlewareResult =
  | { passed: true }
  | { rejected: true; error: ToolResult };  // 拦截时直接返回错误

// 执行流程
async dispatch(name, args) {
  const ctx = { toolName: name, args, startTime: Date.now() };

  // 前置阶段（管道模型，任一拒绝则终止）
  for (const mw of middleware) {
    const result = await mw.before(ctx);
    if (result.rejected) {
      // 前置拦截时仍执行所有 after 钩子（健康采样需要）
      await runAfterHooks(ctx, result.error);
      return result.error;
    }
  }

  // 执行
  const response = await executeTool(name, args);

  // 后置阶段（所有 after 都执行，可修改返回值）
  return runAfterHooks(ctx, response);
}
```

**关键规则**：
- `before` 阶段：管道模型，任一中间件拒绝则终止，不执行后续 `before`
- `after` 阶段：全部执行（即使 `before` 被拦截也执行），用于健康采样和响应截断
- 错误传播：`before` 拦截的错误通过 `ctx` 传递给 `after` 钩子
- 超时：每层中间件默认 5s 超时（`elicitation` 除外，60s），超时视为拒绝

### 最终中间件链

```
前置（before）顺序：                   后置（after）顺序（全部执行）：
1. groupFilter    — 组过滤              1. responseLimiter — 截断/分页
2. pathSecurity   — 路径校验            2. healthSample    — 健康采样（含失败）
3. connectionCheck— 离线/连接分级
4. elicitation    — 缺参数询问（60s）
5. executeTool    — 执行

contextNotify 不在中间件链中 — 它是服务启动时的一次性通知（Phase 5d）
```

---

## Phase 1：Tag 过滤动态管理

### 验收标准

- [ ] 所有工具定义包含 `annotations.tags: ['group:xxx']`
- [ ] `manage_tools list_groups` 返回所有组及其启用状态
- [ ] `manage_tools activate/deactivate` 动态更新工具列表
- [ ] `notifications/tools/list_changed` 在组变更后发送
- [ ] 被停用组的工具调用返回明确错误
- [ ] `core` 组不可被停用
- [ ] 不调用 `manage_tools` 时行为与当前完全一致
- [ ] 全量现有测试通过（零回归）

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

`groupFilter` 中间件的 `before` 钩子检查 `isToolAllowed(name)`：
- in-flight 请求不中断，正常完成（`activeGroups` 写时复制，读端无锁）
- 新请求被拒绝，返回"XX 组已停用"错误

#### 6. 生命周期与并发

- `activeGroups` 连接级，不持久化
- 每次 MCP server 启动回到 Profile 默认值
- **单客户端假设**：MCP stdio 协议为单客户端，不存在多客户端并发操作 `manage_tools` 的场景。`activeGroups` 更新使用写时复制（Copy-on-Write），保证 `dispatch` 读取的一致性

### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/core/tool-registry.ts` | 添加 `activeGroups` 管理、`setGroups()`/`getGroups()`、`requires` 字段 |
| `src/core/ToolDispatcher.ts` | `getFilteredTools()` 实时按 Tag 过滤 + `groupFilter` 中间件 |
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

### 验收标准

- [ ] `sanitizePath` 拦截 `..` 遍历、非法字符、非白名单前缀
- [ ] `CommandValidator` 拦截危险引擎 API（OS.crash 等）
- [ ] `GODOT_MCP_PATH_SECURITY=false` 时路径检查跳过
- [ ] 多实例发现支持机器级 + 项目级注册表
- [ ] 僵尸检测 70s 阈值标记 stale/unreachable
- [ ] 旧版 Bridge（无注册表心跳）降级为端口扫描
- [ ] `godot_select_instance` 后续请求路由到正确实例
- [ ] 实例切换时 in-flight 请求不中断
- [ ] 全量现有测试通过

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

`pathSecurity` 中间件的 `before` 钩子，对所有涉及 `scene_path`、`script_path`、`resource_path` 参数的工具调用前统一校验。

### 2b — 多实例发现与路由

#### 架构

新建 `src/core/instance-manager.ts` 和 `src/core/instance-router.ts`：

```
InstanceManager（发现与管理）
  ├─ 机器级注册表：~/.godot-mcp/instances/uuid-xxx.json
  ├─ 项目级注册表：{project}/.godot/mcp-instances/uuid-xxx.json
  ├─ 端口范围：9081-9090（可配置 GODOT_MCP_INSTANCE_PORT_RANGE）
  └─ instances: Map<instanceId, InstanceInfo>

InstanceRouter（请求路由）
  ├─ selectedInstance: string | null
  ├─ route(name, args) → 转发到选定实例的 Bridge 连接
  └─ withInstanceLock() → 实例切换时排队请求
```

#### InstanceRouter 请求路由机制

```typescript
class InstanceRouter {
  private selectedId: string | null = null;
  private switchLock: Promise<void> = Promise.resolve();

  // 路由请求到选定实例
  async route(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.selectedId) {
      return { error: 'No instance selected. Use godot_select_instance first.' };
    }
    const instance = this.instanceManager.getInstance(this.selectedId);
    // 通过实例的 Bridge 连接发送请求
    return this.bridgeManager.sendToInstance(instance.port, name, args);
  }

  // 切换实例（带锁保护）
  async selectInstance(id: string): Promise<void> {
    // 等待 in-flight 请求完成
    await this.switchLock;
    this.selectedId = id;
    // 触发 Phase 1 的 sync（检查 requires 条件）
    await this.dispatcher.syncGroups();
  }
}
```

**实例切换原子性保证**：
- `selectInstance()` 使用锁机制，等待当前 in-flight 请求完成后才切换
- 切换后触发 `sync`，自动启用/停用依赖 Bridge 的组
- 代理工具（Phase 3a）的请求同样经过 `InstanceRouter.route()`

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
  "godotVersion": "4.4",
  "capabilities": ["registry-heartbeat"]
}
```

发现顺序：先读机器级 → 再读项目级 → 合并去重。

#### 注册表文件容错

- **目录初始化**：使用 `mkdirSync(path, { recursive: true })`，Windows 上 `recursive` 选项使目录创建幂等
- **文件读取**：捕获 `ENOENT`（实例退出删了文件）和 `SyntaxError`（文件写入中途）
- **Windows 文件锁**：读取时使用 `readFileSync` + try/catch，写时使用原子写入（写临时文件 → rename）
- **Bridge 版本协商**：实例条目的 `capabilities` 字段，旧版 Bridge 不包含 `registry-heartbeat`，InstanceManager 降级为仅端口扫描

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
阈值可通过 `GODOT_MCP_INSTANCE_STALE_TIMEOUT_MS` 环境变量调整（默认 70000）。

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

#### Bridge 版本兼容性

- 旧版 Bridge（无 `capabilities` 字段）→ 降级为仅端口扫描发现
- 注册表心跳的文件 I/O：每 30s 写一次约 200 字节的 JSON，SSD 和 HDD 上均可接受
- Web 导出不支持文件系统 → 注册表机制不可用，仅端口扫描

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
| `src/core/instance-router.ts` | **新建**，InstanceRouter |
| `src/tools/instance-tools.ts` | **新建**，godot_list_instances + godot_select_instance |
| `src/core/ToolDispatcher.ts` | dispatch 加 pathSecurity 中间件 + 实例路由 |
| `src/gdscript-executor.ts` | 沙箱链串联 CommandValidator |
| `scripts/mcp_bridge.gd` | Bridge autoload 增加注册表写入（心跳更新 lastSeen）+ capabilities 上报 |

---

## Phase 3a：懒加载代理

### 验收标准

- [ ] `godot_advanced_tool` 代理能调用停用组的工具
- [ ] 代理 description 动态列出可用工具名和简述
- [ ] 无效 tool_name 返回模糊匹配建议
- [ ] 代理调用经过完整中间件链（pathSecurity + connectionCheck）
- [ ] 代理与多实例路由正确交互
- [ ] 新增 `slim` Profile：核心工具直接暴露 + 代理访问高级工具
- [ ] 全量现有测试通过

### 目标

核心工具直接暴露，高级工具通过 `godot_advanced_tool` 代理访问，减少客户端工具列表噪音。

### 代理模式触发条件

新增 `slim` Profile，触发代理模式：

| Profile | 核心工具 | 高级工具 |
|---------|----------|----------|
| `full` | 直接暴露 | 直接暴露 |
| `slim` | 直接暴露 | 仅通过 `godot_advanced_tool` 代理 |
| `minimal` | 直接暴露 | 不可用（不暴露也不代理） |

`manage_tools activate` 可以将 `slim` 中的代理工具升级为直接暴露。

### godot_advanced_tool 设计

```typescript
{
  tool_name: string,        // 要调用的工具名，如 'animation_play'
  arguments: object,        // 传给目标工具的参数
}
```

**代理自身归属**：`core` 组，始终可见，不可被禁用。

#### 路由派生

使用 `TOOL_GROUPS` 的反向映射表（`toolName → groupName → moduleFile`），而非前缀推断：

```typescript
// 构建反向映射（启动时一次性计算）
const toolToGroup: Map<string, string> = new Map();
for (const [group, def] of Object.entries(TOOL_GROUPS)) {
  for (const tool of def.tools) {
    toolToGroup.set(tool, group);
  }
}

function findModuleForTool(toolName: string): ToolModule | null {
  // 通过 TOOL_GROUPS 反查：toolName → 组名 → 模块
  const group = toolToGroup.get(toolName);
  if (!group) return null;
  return moduleRegistry.get(group);
}
```

#### 代理调用路径

代理调用**经过完整中间件链**：

```
godot_advanced_tool(tool_name='physics_raycast', arguments={...})
  → ToolDispatcher.dispatch('physics_raycast', args)
    → groupFilter: 代理工具自动放行（绕过组过滤）
    → pathSecurity: 正常校验路径参数
    → connectionCheck: 正常检查连接
    → elicitation: 跳过（参数由代理传入，不询问）
    → executeTool: 找到 physics 模块执行
    → responseLimiter: 正常截断
    → healthSample: 正常采样
```

#### 与多实例的交互

代理调用经过 `ToolDispatcher.dispatch()`，自然经过 `InstanceRouter.route()`，无需特殊处理。

#### LLM 可发现性

代理的 description 动态列出当前可用的代理工具：

```typescript
description: `Proxy for advanced Godot tools. Currently available:\n` +
  deactivatedGroups.flatMap(g => g.tools.map(t => `- ${t}: ${t.description}`)).join('\n') +
  `\n\nCall with { tool_name: "<name>", arguments: {...} }`
```

组变更（`notifications/tools/list_changed`）后自动更新（加 100ms debounce 防止频繁重建）。

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
| `src/core/ToolDispatcher.ts` | `getFilteredTools()` 按 Profile + 代理模式过滤 |
| `src/core/tool-registry.ts` | 新增 `toolToGroup` 反向映射表 |

---

## Phase 3b：响应控制

### 验收标准

- [ ] 超过 2MB 响应附加警告 content 块
- [ ] 超过 4MB 响应按数组元素裁剪并附加截断提示
- [ ] 截断后的 JSON 结构完整（不破坏 JSON 语法）
- [ ] `page_size + cursor` 分页在 4 个工具上工作正常
- [ ] `tilemap_read` 使用 `region + max_tiles` 分页
- [ ] cursor 包含版本号（`v1:` 前缀）
- [ ] 不传 `page_size` 时行为与现在一致
- [ ] 全量现有测试通过

### 截断策略

双阈值，使用结构化截断（MCP content 数组，数据与警告分离）：

```typescript
const SOFT_LIMIT = 2 * 1024 * 1024;  // 2MB
const HARD_LIMIT = 4 * 1024 * 1024;  // 4MB
```

**截断粒度**：按顶级数组元素裁剪（不是按字节数截断），保证 JSON 完整性：

```typescript
function truncateResponse(response: ToolResult): ToolResult {
  const size = JSON.stringify(response).length;
  if (size > HARD_LIMIT) {
    // 按元素裁剪，保留 JSON 完整性
    const trimmed = trimToArrayLimit(response, HARD_LIMIT);
    return [
      { type: 'text', text: JSON.stringify({ ...trimmed, partial: true, originalSize: size }) },
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

// 按数组元素裁剪：找到最大的数组，逐步移除尾部元素直到低于限制
function trimToArrayLimit(data: any, limitBytes: number): any {
  // 找到 data 中最大的数组，移除尾部元素直到 JSON.stringify 长度 < limitBytes
  // 保留 { ..., nodes: [...前 N 个], totalNodeCount: 原始总数, truncatedAt: N }
}
```

### 分页支持

高输出工具添加 `page_size` + `cursor` 参数：

| 工具 | 分页方式 |
|------|----------|
| `query_scene_tree` | `page_size` + `cursor` |
| `validate_scripts` | `page_size` + `cursor` |
| `validate_project` | `page_size` + `cursor` |
| `profiler_get_data` | `page_size` + `cursor` |
| `tilemap_read` | 复用 `region` 参数 + `max_tiles` 上限（空间数据不适合 cursor） |

**Cursor 编码**（含版本号）：`base64('v1:' + JSON.stringify({ offset, timestamp }))`

向后兼容：不传 `page_size` 时返回全部结果（但受截断保护）。

### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/core/middleware/response-limiter.ts` | **新建**，truncateResponse |
| `src/core/ToolDispatcher.ts` | `responseLimiter` 中间件 |
| 5 个高输出工具 | inputSchema 加 `page_size` + `cursor` 或 `max_tiles` 可选参数 |

---

## Phase 4：健康监控 + 自动重连 + 优雅降级

### 验收标准

- [ ] 健康监控 30s 心跳正常工作
- [ ] 连续 5 次失败后降频为 60s 探测模式
- [ ] 探测成功后立即恢复 30s 心跳
- [ ] 连接状态机四态转换正确
- [ ] `degraded → connected` 退出条件量化
- [ ] 重连指数退避正确（800ms → 30s cap）
- [ ] 重连耗尽后发送 `notifications/message`
- [ ] `manage_tools reconnect` 手动恢复工作
- [ ] 离线模式启动正常，离线工具可调用
- [ ] dispatch 延迟基线：< 50ms（不含工具执行时间）
- [ ] 全量现有测试通过

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

**healthSample 中间件**：作为 `after` 钩子，同时覆盖成功和失败路径。即使前置中间件拦截了请求，`after` 钩子仍然执行，确保 `failedRequests` 计数完整。

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

**degraded 退出条件**（满足全部）：
- 最近 10 个请求中失败数 < 2
- 平均响应时间 < 1.5 × 正常基线
- 退出后状态变为 `connected`

**degraded → reconnecting**：degraded 状态下如果连续 5 次心跳失败，直接进入 reconnecting（不经过额外的中间过渡）。

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
| **离线** | 项目配置读取（project.godot）、脚本语法验证、CLAUDE.md 规则查询、manage_tools 列表操作、Resource 读取（tool-groups、project-context） |
| **连接中** | 同离线 + 实例发现、健康监控只读 |
| **已连接** | 全部功能 |

实现：工具模块可选 `offlineCapable?: boolean`，`connectionCheck` 中间件根据连接状态和工具标记决定放行或拒绝。

### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/core/health-monitor.ts` | **新建**，HealthMonitor |
| `src/core/reconnection-manager.ts` | **新建**，ReconnectionManager |
| `src/core/ToolDispatcher.ts` | 中间件数组 + healthSample after 钩子 |
| `src/core/tool-registry.ts` | 工具定义增加 `offlineCapable` 标记 |
| `src/core/EditorConnection.ts` | 集成 ReconnectionManager |
| `src/GodotServer.ts` | 启动时不再要求连接，离线模式启动 |
| 离线可用工具 | 标记 `offlineCapable: true` |

---

## Phase 5：Resources 扩展 + Prompts + Elicitation + Context 注入

### 验收标准

- [ ] 6 个新 Resource URI 可正常读取
- [ ] `godot://console-errors` 返回 Godot 运行时错误（非 MCP 协议错误）
- [ ] `godot://scene-tree` 大型场景返回摘要而非全量
- [ ] 4 个 Prompt 模板可正常调用
- [ ] Elicitation 在缺参数时主动询问（客户端支持时）
- [ ] Elicitation 不支持时优雅降级为参数错误
- [ ] 启动通知发送 `godot://project-context` 提示
- [ ] Elicitation 参数判定优先级：显式提供 > 默认值 > 询问
- [ ] 全量现有测试通过

### 5a — Resources 扩展

项目已有 `godot://` URI 方案。新增 6 个 Resource：

| URI | 数据 | 离线可用 | 数据获取方式 |
|-----|------|---------|------------|
| `godot://health` | HealthMonitor 快照 | 否 | 内存读取 |
| `godot://instances` | InstanceManager 快照 | 部分（缓存） | 内存 + 注册表 |
| `godot://console-errors` | Godot 运行时错误（最近 20 条） | 否 | Bridge 拉取（get_debug_output 过滤错误行） |
| `godot://scene-tree` | 当前场景树快照（大小保护） | 否 | Bridge get_tree |
| `godot://tool-groups` | 各组启用/停用状态 | 是 | 内存读取 |
| `godot://project-context` | 项目文档摘要 | 是 | 文件读取 |

**`godot://console-errors` 数据来源**：
- 从 Bridge 的 `get_debug_output` 拉取 Godot 引擎输出，过滤 `[ERROR]`/`[WARNING]` 行
- 包含 GDScript 错误、场景加载失败、shader 编译错误
- 与 `HealthMonitor.recentErrors`（MCP 协议层错误）是独立数据源

**`godot://scene-tree` 大小保护**：复用 Phase 3b 截断策略。大型场景返回摘要（前 200 个节点 + `totalNodeCount` + `truncated: true`）而非全量树。

### 5b — MCP Prompts

新建 `src/prompts.ts`，4 个预置 Prompt 模板：

| Prompt 名称 | 输入参数 | 产出 |
|-------------|----------|------|
| `create_platformer` | `project_name`, `resolution` | 2D 平台游戏脚手架指导 |
| `setup_player_controller` | `dimension: '2d' \| '3d'`, `movement_type` | 玩家控制器指导 |
| `optimize_scene` | `scene_path` | 场景优化分析指导 |
| `debug_performance` | — | 性能调试引导 |

Prompt 返回结构化指导文本（非代码），LLM 按步骤执行。支持不带参数调用（使用默认值）。Prompt 输出语言与用户环境匹配（中文环境输出中文指导）。

### 5c — Elicitation

中间件位置：`connectionCheck` 之后、`executeTool` 之前。

逻辑：
1. 检查 required 参数 vs 已提供的 args
2. 参数判定优先级：**显式提供 > inputSchema default 值 > Elicitation 询问**
3. 仅提示原始类型（string/number/boolean/enum）
4. 不提示 object/array 等复杂类型（嵌套 required 也跳过整个参数）
5. 通过 MCP Elicitation API 询问
6. Elicitation 返回的参数**合并**到原始 args（不覆盖已有值）
7. 客户端不支持时优雅降级为传统参数错误
8. 60 秒超时

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
| `src/core/middleware/response-limiter.ts` | **新建**，截断/分页 |
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
| 2b | `src/core/instance-router.ts` | InstanceRouter |
| 2b | `src/tools/instance-tools.ts` | godot_list_instances + godot_select_instance |
| 3a | `src/tools/advanced-proxy.ts` | godot_advanced_tool 代理 |
| 3b | `src/core/middleware/response-limiter.ts` | truncateResponse |
| 4a | `src/core/health-monitor.ts` | HealthMonitor |
| 4b | `src/core/reconnection-manager.ts` | ReconnectionManager |
| 5 | `src/prompts.ts` | 4 个 Prompt 模板 |
| 5 | `src/core/middleware/elicitation.ts` | Elicitation 中间件 |
| 5 | `src/core/middleware/context-notify.ts` | 启动通知 |
| 5 | `src/core/middleware/group-filter.ts` | 组过滤中间件 |
| 5 | `src/core/middleware/path-security.ts` | 路径安全中间件 |
| 5 | `src/core/middleware/connection-check.ts` | 连接检查中间件 |
| 5 | `src/core/middleware/health-sample.ts` | 健康采样中间件 |

**总计**：新建 17 个文件，改动 ~10 个现有文件，37 个工具模块零改动。

---

## SDK 前置条件验证清单

以下 MCP SDK TS 能力需在编码前验证：

| 能力 | SDK API | 最低版本 |
|------|---------|---------|
| `annotations.tags` | `Tool.annotations` | 需验证 |
| `notifications/tools/list_changed` | `server.sendToolListChanged()` | 需验证 |
| `notifications/message` | `server.notification()` | 需验证 |
| Elicitation | MCP Elicitation API | 需验证 |
| Resource 动态模板 | `resources/templates` handler | 已有（`godot://`） |
| Prompt handler | `server.setRequestHandler(ListPromptsRequestSchema)` | 需验证 |

验证步骤：在 Phase 1 编码前，编写最小测试脚本逐项确认 SDK 能力。不支持的特性使用 polyfill 或降级方案。

---

## 风险与约束

1. **CommandValidator best-effort**：动态语言的间接调用无法完全拦截，文档明确声明
2. **Bridge GDScript 改动**：多实例需要修改 `mcp_bridge.gd` 增加注册表心跳，需同步更新。旧版 Bridge 不更新时降级为仅端口扫描
3. **MCP SDK TS 版本**：当前 `^1.29.0`，Tag 过滤和 Elicitation 需在编码前确认 SDK 支持（见验证清单）
4. **中间件性能**：8 层中间件，每层有异步操作。dispatch 延迟预算 < 50ms（不含工具执行时间），需在 Phase 4 完成后做基准测试
5. **向后兼容**：每个 Phase 必须保持不使用新功能时的行为完全一致
6. **中间件顺序安全**：顺序硬编码在 `ToolDispatcher` 中，不可由用户自定义。`pathSecurity` 必须在 `connectionCheck` 之前（离线模式下仍需路径校验）
7. **单客户端假设**：MCP stdio 协议为单客户端，`manage_tools` 的并发操作不在设计范围内
8. **注册表心跳 I/O**：每 30s 写约 200 字节 JSON 文件，对 HDD 影响可忽略。Godot 重载脚本期间文件 I/O 暂停（Bridge autoload 暂时不可用），恢复后补写
