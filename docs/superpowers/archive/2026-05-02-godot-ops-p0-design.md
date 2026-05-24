# P0 运行时操作工具 — 设计文档

**日期:** 2026-05-02
**状态:** v3（二次审查修订版）
**范围:** 信号控制、3D 操作、物理查询、导航寻路

---

## 1. 背景

竞品分析显示项目缺失 4 个 P0 能力域：运行时信号控制、3D 基础操作、物理引擎、导航寻路。
当前 `execute_gdscript` 可执行任意 GDScript，但 AI 需要手写代码，门槛高。
本设计新增 8 个结构化工具，降低 AI 使用门槛。

## 2. 方案选择

| 方案 | 描述 | 结论 |
|------|------|------|
| A: 纯 execute_gdscript | 只提供模板文档 | 门槛过高 |
| B: 全部独立工具 | 每个能力注册独立 MCP 工具 | token 开销大 |
| **C: 混合** | **高频操作独立工具 + 低频走模板** | **已选** |

交付策略：方案 C
实现路径：新增 `src/tools/godot-ops.ts`，内部调用 `executeGdscript()` 生成并执行 GDScript 片段
执行模式：默认 `load_autoloads: true`，可选参数 `load_autoloads` 允许高级场景关闭以加速

## 2.1 实现级约束（审查修订新增）

### P0-1：结构化向量对象

from/to/start_pos/end_pos 必须定义为严格对象 `{x: number, y: number, z: number}`。
TS 侧在生成 GDScript 前校验数值类型，非数字拒绝。
schema 定义示例：
```json
{ "type": "object", "properties": { "x": {"type":"number"}, "y": {"type":"number"}, "z": {"type":"number"} }, "required": ["x","y","z"] }
```

### P0-2：统一 NodePath 解析

所有路径参数（source_path/target_path/node_path/body_path/parent）统一处理：
- 空字符串拒绝
- **仅接受 scene tree path**（`root/...` 或 `/root/...`），不接受 `res://...`
- `res://...` 仅用于资源路径参数（如 texture_path），NodePath 参数遇到 `res://` 前缀直接拒绝
- 支持 `root/...` 与 `/root/...` 两种格式，统一为 `/root/...`
- 转义后再插入脚本（防止引号注入）

```typescript
function normalizeNodePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('NodePath cannot be empty');
  if (trimmed.startsWith('res://')) throw new Error('NodePath must be a scene tree path (root/...), not a resource path (res://...)');
  return trimmed.startsWith('/') ? trimmed : '/' + trimmed;
}
```

### P0-3：GDScript 字符串安全转义

所有 string 参数（信号名、方法名、节点名）插入脚本前必须经过 escape：
```typescript
function gdEscape(s: string): string {
  return s
    .replace(/\r\n/g, '\\n')   // CRLF → \n (先于单独 \n 处理)
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\n')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\0/g, '');        // 禁止 null 字节
}
```

支持 Unicode 字符原样透传（GDScript 源文件为 UTF-8）。

### P1-1：physics_raycast 锁定 Godot 4 写法

使用 Godot 4.x 标准查询流程（非 PhysicsServer3D 直接调用）：
```gdscript
var space_state = get_viewport().get_world_3d().direct_space_state
var query = PhysicsRayQueryParameters3D.create(from, to)
query.collision_mask = mask
var result = space_state.intersect_ray(query)
```

### P1-2：工具级 load_autoloads 可配

默认 true（可用性优先），每个工具提供可选 `load_autoloads` 参数。
高级场景（如仅需 physics_raycast 不需要 autoload）可关闭加速。

### P1-3：统一返回格式

8 个工具统一返回：
```json
{ "success": true/false, "data": ..., "error": "...", "error_code": "...", "warnings": [] }
```

错误码枚举：
- `INVALID_PATH` — NodePath 格式错误或使用了 res://
- `NODE_NOT_FOUND` — get_node 找不到节点
- `INVALID_VECTOR` — 向量参数缺字段或非数字
- `INVALID_TYPE` — node_create_3d 的 type 不在白名单中
- `INVALID_SIGNAL` — 信号名/方法名格式错误
- `SCRIPT_EXEC_FAILED` — GDScript 执行出错

handler 内解析 executeGdscript 的 outputs，映射到此结构。

### 架构接入说明

当前 master 已完成模块化重构（commit 0404f75），`GodotServer.ts` 为 258 行路由分发，
工具注册通过 `toolModules` 数组。新模块直接 import 并加入数组即可。

## 3. 工具清单

### 3.1 信号控制（4 个工具）

| 工具 | 参数 | GDScript 逻辑 |
|------|------|---------------|
| `signal_connect` | source_path (NodePath), signal_name (string), target_path (NodePath), method_name (string), flags? (int) | `get_node(src).connect(sig, Callable(get_node(tgt), method))` |
| `signal_disconnect` | source_path (NodePath), signal_name (string), target_path (NodePath), method_name (string) | `get_node(src).disconnect(sig, Callable(get_node(tgt), method))` |
| `signal_emit` | source_path (NodePath), signal_name (string), args? (any[]) | `get_node(src).emit_signal(sig, ...args)` |

**signal_emit args 序列化边界：** 仅支持基础类型（string/number/bool/null）和一维数组。
传入对象/嵌套数组/Resource 引用时返回 `INVALID_SIGNAL` 错误。
| `signal_list` | node_path (NodePath) | `get_node(path).get_signal_list()` |

**关键限制：** 信号操作是运行时操作，headless 执行后不持久化。description 中明确说明：
> "仅影响当前执行上下文。如需持久化信号连接，请编辑 .tscn 文件。"

不做 `signal_wait`（需要持续运行进程 + 超时回调，架构改动过大）。

### 3.2 物理查询（2 个工具）

| 工具 | 参数 | GDScript 逻辑 |
|------|------|---------------|
| `physics_raycast` | from (Vector3{x,y,z}), to (Vector3{x,y,z}), collision_mask? (int), exclude_paths? (NodePath[]) | `PhysicsRayQueryParameters3D.create(from, to)` + `query.exclude = [rids...]` + `direct_space_state.intersect_ray()` |
| `physics_body_info` | body_path (NodePath) | 读取 CollisionShape 类型/AABB/layer/mask。无 CollisionShape3D 子节点时返回 `{success:true, data:{has_collision:false}}` |

### 3.3 3D 节点创建（1 个工具）

| 工具 | 参数 | GDScript 逻辑 |
|------|------|---------------|
| `node_create_3d` | type (string 白名单), name (string), parent? (NodePath), position? (Vector3), rotation? (Vector3), scale? (Vector3), properties? (object) | `var node = Type.new(); node.name = ...; add_child()` |

**node_create_3d.type 白名单：** Node3D, MeshInstance3D, StaticBody3D, RigidBody3D, CharacterBody3D,
Camera3D, Light3D, DirectionalLight3D, OmniLight3D, SpotLight3D, CollisionShape3D,
RayCast3D, Area3D, Marker3D, PathFollow3D, VisibleOnScreenNotifier3D。
不在白名单中的 type 返回 `INVALID_TYPE` 错误。

**关键限制：** headless 中创建的节点不持久化。用途：验证创建逻辑、配合 run_project 动态操作。
持久化场景修改应走现有的 `add_node` + `save_scene`。

### 3.4 导航查询（1 个工具）

| 工具 | 参数 | GDScript 逻辑 |
|------|------|---------------|
| `nav_query_path` | start_pos (Vector3{x,y,z}), end_pos (Vector3{x,y,z}), navigation_region? (NodePath) | `NavigationServer3D.query_path()` |

**nav_query_path 无导航数据时：** 返回 `{success:true, data:{path:[], path_length:0, warning:"No navigation data available"}}`。
不返回错误（空路径是合法结果），通过 warning 字段提示。

不做 NavMesh 烘焙（需要编辑器 API）。

## 4. 架构

```
src/tools/godot-ops.ts (~450 行)
├── TOOL_NAMES (8 个常量)
├── getToolDefinitions(): Tool[]
│   └── 8 个工具定义（inputSchema）
├── handleTool(): Promise<ToolResult | null>
│   └── switch 8 cases
│       └── 每个: 提取参数 → 生成 GDScript → executeGdscript() → 返回
└── GDScript 生成辅助函数
    ├── genSignalConnectScript()
    ├── genSignalDisconnectScript()
    ├── genSignalEmitScript()
    ├── genSignalListScript()
    ├── genRaycastScript()
    ├── genBodyInfoScript()
    ├── genCreate3DScript()
    └── genNavQueryScript()
```

注册到 `GodotServer.ts` 的 `toolModules` 数组。

## 5. 不做的事

- `signal_wait`（需要持续进程，架构改动大）
- NavMesh 烘焙（需编辑器 API）
- Shader 编辑（P2）
- 粒子系统（P2）
- 音频管理（P1，后续迭代）
- TileMap 编辑（P1，后续迭代）

## 6. 测试策略

- `test/godot-ops.test.js`：测试 GDScript 生成函数和辅助工具
  - 每个 gen*Script() 验证输出的 GDScript 包含关键代码片段
  - 负例测试：空 path、非法 signal 名、非法 vector（非数字、缺字段）
  - 转义测试：包含引号/反斜杠/中文/换行的参数
  - 路径兼容测试：`root/...`、`/root/...`、`res://...` 三类路径
  - 结果解析测试：脚本输出标记被正确解析为统一 JSON 结构
  - 辅助函数测试：`normalizeNodePath`、`gdEscape`、向量校验
- 不做 Godot 进程集成测试（需要 Godot 安装 + 项目上下文）

## 7. 成功标准

- 8 个新工具 schema 全部有 required + 类型校验
- 所有 string 入脚本前统一 `gdEscape`
- 所有 path 先 `normalizeNodePath` 再 `get_node`
- 每个工具 description 明确"运行时非持久化"
- `npm run build` 通过
- `test/godot-ops.test.js` 覆盖 8 个 gen*Script + 负例 + 转义 + 路径兼容
- 工具总数从 35 增长到 43
- README.md 同步更新：工具总数、新增工具列表、限制说明（非持久化）、示例调用
