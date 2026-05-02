# P0 运行时操作工具 — 设计文档

**日期:** 2026-05-02
**状态:** 已批准
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
执行模式：所有工具使用 `load_autoloads: true`（信号/物理/导航需要 SceneTree 上下文）

## 3. 工具清单

### 3.1 信号控制（4 个工具）

| 工具 | 参数 | GDScript 逻辑 |
|------|------|---------------|
| `signal_connect` | source_path, signal_name, target_path, method_name, flags? | `get_node(src).connect(sig, Callable(get_node(tgt), method))` |
| `signal_disconnect` | source_path, signal_name, target_path, method_name | `get_node(src).disconnect(sig, Callable(get_node(tgt), method))` |
| `signal_emit` | source_path, signal_name, args? | `get_node(src).emit_signal(sig, ...args)` |
| `signal_list` | node_path | `get_node(path).get_signal_list()` |

**关键限制：** 信号操作是运行时操作，headless 执行后不持久化。description 中明确说明：
> "仅影响当前执行上下文。如需持久化信号连接，请编辑 .tscn 文件。"

不做 `signal_wait`（需要持续运行进程 + 超时回调，架构改动过大）。

### 3.2 物理查询（2 个工具）

| 工具 | 参数 | GDScript 逻辑 |
|------|------|---------------|
| `physics_raycast` | from (x,y,z), to (x,y,z), collision_mask? | `PhysicsServer3D.direct_state.intersect_ray()` |
| `physics_body_info` | body_path | 读取 CollisionShape 类型/AABB/layer/mask |

### 3.3 3D 节点创建（1 个工具）

| 工具 | 参数 | GDScript 逻辑 |
|------|------|---------------|
| `node_create_3d` | type, name, parent?, position?, rotation?, scale?, properties? | `var node = Type.new(); node.name = ...; add_child()` |

**关键限制：** headless 中创建的节点不持久化。用途：验证创建逻辑、配合 run_project 动态操作。
持久化场景修改应走现有的 `add_node` + `save_scene`。

### 3.4 导航查询（1 个工具）

| 工具 | 参数 | GDScript 逻辑 |
|------|------|---------------|
| `nav_query_path` | start_pos (x,y,z), end_pos (x,y,z), navigation_region? | `NavigationServer3D.query_path()` |

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

- `test/godot-ops.test.js`：测试 GDScript 生成函数的输出
  - 每个 gen*Script() 验证输出的 GDScript 包含关键代码片段
  - 参数边界：缺少必需参数、空字符串、非法节点路径
- 不做 Godot 进程集成测试（需要 Godot 安装 + 项目上下文）

## 7. 成功标准

- 8 个新工具注册成功，build 无错误
- 工具总数从 35 增长到 43
- 每个工具的 description 清晰说明限制（headless 非持久化）
- GDScript 生成函数有对应单元测试
