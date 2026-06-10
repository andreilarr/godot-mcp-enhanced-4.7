# Unreal_mcp 全面借鉴设计 — v0.18.0

> 日期: 2026-06-10
> 版本: v0.18.0 (breaking change)
> 状态: 已批准
> 前置研究: Unreal_mcp v0.5.30 架构分析

## 背景

Unreal_mcp (v0.5.30) 通过 CRI (Context Reduction Initiative) 将 78K→25K token 的上下文开销。核心手段包括：合并工具（130+→23）、动态加载、公共 schema 提取、schema 精简。

godot-mcp-enhanced 当前有 **39 个 MCP 工具**（含 ~170 个内部操作）、18 工具组、6 Profile。其中大部分工具已使用内部 `action` 参数做 dispatch（如 scene、game、animation），但仍有 ~9 个独立工具可被吸收合并。同时缺少：listChanged 通知、Common Schema 提取、Response Validation、Schema 精简。

**目标**：一次性大版本（v0.18.0），将 39 个 MCP 工具精简为 ~27 个，吸收 9 个独立工具进相关组，统一 action 路由模式，同时引入 Unreal_mcp 的能力增强模式。

### 实施依赖

本 spec 与 `agent-architecture-design.md` 共享 v0.18.0 里程碑，两者修改相同核心文件。

**实施顺序**：
1. 先实施 agent-architecture Phase 1（AgentContextManager + 状态持久化）→ ToolDispatcher.ts 增加 agentId 提取 + AgentContext 注入
2. 再实施本 spec（action 路由合并）→ ToolDispatcher.ts 在 agentId 提取之后增加 handleAction 入口
3. 两者共享的 tool-registry.ts 变更合并为一个 PR

## 前置条件

| # | 条件 | 状态 |
|---|------|------|
| 1 | 50 条意图→action 选准率测试通过 | 实施前阻塞门 |
| 2 | Response schema 包含 tool_name + action 用于错误追踪 | 设计已确认 |
| 3 | CHANGELOG 提供完整映射表 + legacy warning 模式 | 设计已确认 |

---

## 第 1 节：工具合并架构

### 合并策略

利用已有的 18 TOOL_GROUPS 结构，将 39 个 MCP 工具精简为 27 个。当前状态分两类：

- **类型 A（需迁移）**：9 个独立工具被吸收进相关组，工具名消失（breaking change）
- **类型 B（零迁移）**：30 个工具已使用内部 action 路由，合并后行为模式不变，仅调整 schema

### 类型 A — 独立工具吸收（Breaking Change，共 9 个）

| 旧工具名 | 并入 | 新 action 名 | 迁移影响 |
|----------|------|-------------|---------|
| node_create_3d | scene | create_3d_node | 工具名+action 变更 |
| scene_commit | scene | commit | 工具名+action 变更 |
| recording | runtime | record_start/stop/save/load/play | 5 个操作合并 |
| verify_delivery | validation | verify_delivery | 仅工具名变更 |
| test | validation | assert/stress/export_* | 工具名变更 |
| ik | animation_player | ik_modifier_create/get/set/list_bones | 工具名变更 |
| templates | project | list_templates/apply | 工具名变更 |
| batch | workflow | create_files/run_verify/diff_scenes | 工具名变更 |
| game_design | validation | validate_gdd/chain_verify | 工具名变更 |

### 类型 B — 已有 action 路由（零迁移，共 30 个）

scene, script, project, runtime, editor, game, animation, animtree, animation_track, audio, material, screenshot, particles, physics, nav, ui, tilemap, signal, profiler, workflow, docs, manage_tools, confirm_and_execute, godot_advanced_tool, godot_list_instances, godot_select_instance, validation, ...

这些工具已通过内部 `action` 参数 dispatch。合并后仅调整 schema（action 从内部参数提升为 schema 正式字段），用户无感知。

### 最终工具清单（27 个）

#### 主力工具（23 个）

| # | 工具名 | action 数 | 吸收说明 |
|---|--------|----------|---------|
| 1 | project | 9 | 原 7 + templates(list/apply) |
| 2 | scene | 19 | 原 16 + node_create_3d→create_3d_node + scene_commit→commit |
| 3 | script | 7 | |
| 4 | runtime | 11 | 原 6 + recording(5: start/stop/save/load/play) |
| 5 | validation | 10 | 原 5 + verify_delivery + test(5) + game_design(2) |
| 6 | editor | 3 | |
| 7 | game | 14 | |
| 8 | animation_player | 15 | 原 animation 11 + ik 4 |
| 9 | animation_tree | 6 | animtree 6 actions |
| 10 | animation_track | 6 | animation_track 6 actions |
| 11 | audio | 4 | |
| 12 | material | 11 | |
| 13 | screenshot | 2 | |
| 14 | particles | 5 | |
| 15 | physics | 5 | |
| 16 | nav | 6 | |
| 17 | ui | 8 | |
| 18 | tilemap | 8 | |
| 19 | signal | 4 | |
| 20 | profiler | 6 | |
| 21 | workflow | 6 | 原 3 + batch(3: create_files/run_verify/diff_scenes) |
| 22 | docs | 4 | |
| 23 | manage_tools | 6 | 原 5 + migrate |

#### 基础设施工具（4 个，不参与合并）

| # | 工具名 | 说明 |
|---|--------|------|
| 24 | confirm_and_execute | 安全确认层 |
| 25 | godot_advanced_tool | 动态路由 fallback |
| 26 | godot_list_instances | 多实例列表 |
| 27 | godot_select_instance | 多实例选择 |

### action 参数设计

每个工具的 inputSchema 包含：
- `action`: string enum，列出所有可用 action
- Common params（见第 2 节）
- Action-specific params

Schema 采用 **flat schema + handler 校验**策略（与 Unreal_mcp 一致）：
- Schema 层：所有参数标为 optional，description 标注每个 action 需要哪些参数
- Handler 层：代码做严格校验，缺失必填参数返回结构化错误

不使用 oneOf 条件分支（schema 体积反而更大），不依赖 tool annotations（MCP 协议尚未标准化）。

### 路由实现

```typescript
// handler 注册（co-located 模式：required 声明与 handler 绑定）
const handlers: Record<string, ActionHandler> = {
  "scene:read_scene": {
    required: ["scene_path"],
    handle: async (args, ctx) => { /* ... */ }
  },
  "scene:add_node": {
    required: ["parent_node_path", "node_type"],
    handle: async (args, ctx) => { /* ... */ }
  },
};
```

### manage_tools migrate action

输出完整迁移映射 JSON，包含四个分类：
- `mapping`: 完整旧→新映射（查表用）
- `renamed`: 仅 action 名变更（find-and-replace 用）
- `removed`: 旧工具名已不存在但 action 还在
- `unchanged`: 零改动

---

## 第 2 节：Common Schema 提取

### 设计

提取共享参数（project_path、node_path、scene_path 等）为 Common Schema，各工具 schema 引用而非重写。

```typescript
// src/core/common-schemas.ts
export const COMMON_SCHEMAS = {
  project_path: { type: "string", description: "项目目录路径（可选，默认 GODOT_PROJECT_PATH 环境变量或当前目录）" },
  scene_path:   { type: "string", description: "场景文件路径（相对项目，如 res://scenes/main.tscn）" },
  node_path:    { type: "string", description: "节点路径（root/Player/Sprite2D）" },
  animation_name: { type: "string", description: "动画名称" },
  load_autoloads: { type: "boolean", description: "是否加载 Autoload 上下文（默认 true）" },
};

export function withCommonParams(
  params: Record<string, unknown>,
  ...commonKeys: (keyof typeof COMMON_SCHEMAS)[]
): Record<string, unknown> { /* ... */ }
```

### Token 节省说明

- **协议层**：39→27 工具，消除 12 个独立 schema（每个约 200-400 token），预估节省 ~3600 token。额外节省来自 Schema 精简（description 缩短）
- **代码层**：Common Schema 提取消除 copy-paste，是开发体验优化，不直接减少协议层 token

---

## 第 3 节：listChanged 通知 + Schema 精简

### listChanged

利用 MCP SDK 的 `notifications/tools/list_changed` 通知能力。当 manage_tools 的 activate/deactivate 改变工具集时，发送通知让客户端刷新工具列表。

降级策略：不支持 listChanged 的客户端不刷新列表，但不影响功能（工具仍存在，handler 层返回错误）。

### Schema 精简规则

| 元素 | 之前 | 之后 |
|------|------|------|
| 工具 description | 详细分类 + 举例 | 1 句定位 + action 枚举 |
| 参数 description | 完整说明 + 用途列表 | 类型提示 + 简写用途 |
| action enum | 无额外描述 | action 名自描述 |
| 默认值说明 | "默认 true" | "(默认 true)" |

### x-actions 扩展字段（Optional）

对于 action 数多的工具（如 scene 19 个），可将 action 枚举从 description 移至 `x-actions` 扩展字段：

```json
{
  "name": "scene",
  "description": "场景 CRUD、节点操作、实例管理",
  "x-actions": ["read_scene", "create_scene", ...]
}
```

标记为 optional，当前先靠 action enum。后续视 MCP 客户端支持情况启用。

---

## 第 4 节：迁移策略 + Response Validation

### 迁移策略

**版本**：v0.17.2 → v0.18.0 (breaking change)

**GODOT_MCP_WARN_LEGACY 环境变量**：
- 设置时：旧工具名仍可工作，打 warning 到日志
- 不设置时：旧工具名直接报 "Unknown tool"
- 建议在 v0.18.0 保留一个版本，v0.19.0 移除

实现方式：LEGACY_TOOL_MAP 查找表 + ToolDispatcher 中的 fallback 路由。

**CHANGELOG**：提供完整的旧工具名→新(tool, action)映射表。JSON 格式通过 `manage_tools(action="migrate")` 获取。

### Response Validation

轻量级 Response Wrapper，不引入 ajv/zod 依赖：

```typescript
export interface ActionResult {
  tool: string;
  action: string;
  status: "ok" | "error";
  data?: unknown;
  error?: {
    code: string;
    message: string;
    missing_params?: string[];
  };
}
```

统一的 handleAction 入口处理参数校验、handler 调用、错误包装。

### Error Codes（集中定义）

```typescript
// src/core/error-codes.ts
export const ErrorCodes = {
  MISSING_ACTION: "MISSING_ACTION",
  UNKNOWN_ACTION: "UNKNOWN_ACTION",
  MISSING_REQUIRED_PARAM: "MISSING_REQUIRED_PARAM",
  HANDLER_ERROR: "HANDLER_ERROR",
} as const;
```

### handleAction 前置校验

```typescript
// action 参数缺失的前置校验（避免 "scene:undefined" 的歧义错误）
if (!args.action || typeof args.action !== "string") {
  return toToolResult({
    tool, action: String(args.action ?? ""), status: "error",
    error: { code: ErrorCodes.MISSING_ACTION, message: `Tool "${tool}" requires an "action" parameter` }
  });
}
```

---

## 不做的事

1. **不引入 ajv/zod 做 schema 级别校验**：handler 内部已有参数校验
2. **不注册 output schema**：工具输出格式已足够一致
3. **不改现有 handler 的返回格式**：wrapResult 兼容旧式 ToolResult
4. **不照搬 Unreal_mcp 的分类体系**：使用 Godot 原生的 16 组分类
5. **不做双模式兼容**：一次性大版本，不维护 legacy 模式

---

## 文件变更预估

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| src/core/tool-registry.ts | 重构 | 新增 action 路由、LEGACY_TOOL_MAP、notifyToolsChanged |
| src/core/common-schemas.ts | 新建 | 共享 schema 定义 + withCommonParams |
| src/core/action-response.ts | 新建 | ActionResult + wrapResult + toToolResult |
| src/core/error-codes.ts | 新建 | ErrorCodes 集中定义 |
| src/core/ToolDispatcher.ts | 重构 | handleAction 入口 + legacy fallback |
| src/tools/*.ts (所有工具模块) | 重构 | 改为 action handler 注册模式 |
| test/ | 重构 | 测试适配新路由 |
| CHANGELOG.md | 更新 | 迁移映射表 |
