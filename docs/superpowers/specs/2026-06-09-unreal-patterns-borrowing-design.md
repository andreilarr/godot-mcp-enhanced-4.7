# 从 UnrealMCPBridge 借鉴 6 项设计模式

**日期：** 2026-06-09
**来源：** UnrealMCPBridge v1.8 (`D:\GitHub\GitHubUnrealMCPBridge`)
**目标：** godot-mcp-enhanced (`D:\GitHub\godot-mcp-enhanced`)
**状态：** eng review 修正完成（v3），可进入实施
**审查版本：** v3（已修正 v1 的 3 HIGH + 6 MEDIUM + v2 eng review 的 8 IMPORTANT + 3 ADVISORY + 6 测试缺口）

---

## 背景

通过深度研究 UnrealMCPBridge（57 个 MCP 工具、TCP 三层桥接、C++ 蓝图 API），识别出 6 个可借鉴到 Godot MCP 的设计模式。按价值排序：性能分析 > 相机控制 > 属性快捷 > PIE 多玩家 > 持久上下文 > 蓝图 API。

---

## 改进 1：Profiler 增强分析流水线

### 现状问题

Godot MCP `profiler` 的 `get_data` 存在不足：
- 只采样 `TIME_PROCESS`，不采 physics/nav 维度
- 百分位只有 p50 和 p95，缺少 p99
- 无趋势退化检测（无法发现「后半段比前半段慢了」）
- 内存只做单次快照，无趋势

### 借鉴来源

UnrealMCPBridge `get_csv_profile()` 实现：
- avg/min/max/p50/p95/p99 完整百分位
- 帧预算分析（1000/target_fps）
- 尖峰检测 + 趋势退化检测（前后半段均值对比）
- 多维度同时采样

### 设计

#### 1a. 新增参数

在 `profiler` 工具的 `get_data` action 中新增：

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `dimensions` | `string[]` | `["process"]` | 采样维度列表（**默认值不变，向后兼容**） |
| `leak_threshold_mb` | `number` | `2.0` | 内存泄漏嫌疑阈值（MB） |

支持的时间维度（输出毫秒，可做百分位统计）：

| 维度字符串 | Godot Performance 常量 | 映射位置 | 说明 |
|-----------|----------------------|---------|------|
| `"process"` | `Performance.TIME_PROCESS` | TS 端 `genGetData()` | 主线程帧时间 |
| `"physics"` | `Performance.TIME_PHYSICS_PROCESS` | TS 端 `genGetData()` | 物理帧时间 |
| `"nav_process"` | `Performance.TIME_NAVIGATION_PROCESS` | TS 端 `genGetData()` | 导航处理时间（Godot 4.x） |

> **ARCH-1 修正：** 映射逻辑放在 TS 端 `profiler-ops.ts` 的 `genGetData()` 函数中。根据 `dimensions` 参数动态构建 GDScript 采样代码，每个维度生成独立的 `_mcp_dim_*` 数组和统计逻辑。不在 GDScript 端做运行时查表。

```typescript
// profiler-ops.ts 中的映射常量
const DIMENSION_MAP: Record<string, { gdConstant: string; label: string }> = {
  'process':     { gdConstant: 'Performance.TIME_PROCESS',           label: 'process' },
  'physics':     { gdConstant: 'Performance.TIME_PHYSICS_PROCESS',   label: 'physics' },
  'nav_process': { gdConstant: 'Performance.TIME_NAVIGATION_PROCESS', label: 'nav_process' },
};
const VALID_DIMENSIONS = new Set(Object.keys(DIMENSION_MAP));
```

**维度校验（CODE-6）：** TS 端在生成 GDScript 前校验 dimensions，未知维度发出警告并跳过：

```typescript
const invalid = dimensions.filter(d => !VALID_DIMENSIONS.has(d));
if (invalid.length > 0) {
  // 记录警告，继续处理有效维度
  getLogger().warn('profiler', `Unknown dimensions ignored: ${invalid.join(', ')}`);
}
dimensions = dimensions.filter(d => VALID_DIMENSIONS.has(d));
if (dimensions.length === 0) dimensions = ['process']; // fallback
```

**注意：** 渲染维度 `render` 独立处理（见 1f），不纳入时间百分位统计——因为 `RENDER_TOTAL_DRAW_CALLS_IN_FRAME` 返回整数（draw calls 数），与毫秒混做百分位无意义。

#### 1b. 多维度采样

修改 `genGetData()` 生成的 GDScript，将 `_mcp_frame_times` 从 `Array` 改为 `Dictionary`，每个时间维度独立收集：

```gdscript
var _mcp_dimensions: Dictionary = {
  "process": [],
  "physics": [],
  # 可选维度...
}
```

每帧 `_process` 中同时采样所有选中维度的 Performance monitor。每个维度独立做百分位统计，输出为 `dimension_stats` 数组。

#### 1c. 新增 p99 百分位

在 `_analyze_and_report()` 中计算：

```gdscript
var _p99_idx: int = int(_n * 0.99)
if _p99_idx >= _n:
    _p99_idx = _n - 1
var _p99: float = _sorted[_p99_idx]
```

#### 1d. 趋势退化检测

> **CODE-2 修正：** `frame_count < 2` 时 `_half = 0`，除零崩溃。需前置守卫。

```gdscript
# 前后半段均值对比（含除零守卫）
var _degradation_pct: float = 0.0
var _degradation_detected: bool = false
var _first_half_avg_ms: float = 0.0
var _second_half_avg_ms: float = 0.0
if _n < 2:
    # 帧数不足，跳过退化检测
    pass
else:
    var _half: int = _n / 2
    var _first_half_sum: float = 0.0
    var _second_half_sum: float = 0.0
    for _i in range(_half):
        _first_half_sum += _times[_i]
    for _i in range(_half, _n):
        _second_half_sum += _times[_i]
    _first_half_avg_ms = _first_half_sum / float(_half)
    _second_half_avg_ms = _second_half_sum / float(_n - _half)
    if _first_half_avg_ms > 0.0:
        _degradation_pct = ((_second_half_avg_ms - _first_half_avg_ms) / _first_half_avg_ms) * 100.0
        _degradation_detected = _degradation_pct > 10.0  # 超过 10% 视为退化
```

输出到 `frame_analysis` 中新增：
```json
{
  "degradation_pct": 15.3,
  "first_half_avg_ms": 2.1,
  "second_half_avg_ms": 2.4,
  "degradation_detected": true
}
```

#### 1e. 内存趋势

短会话（≤120 帧）只采首尾两次内存快照，避免频繁 GC 干扰。长会话（>120 帧）额外在中间采一次：

> **CODE-4 修正：** 补充 `_capture_memory()` 函数定义。

```gdscript
var _mem_start: Dictionary = {}
var _mem_end: Dictionary = {}
var _mem_mid: Dictionary = {}  # 仅 >120 帧时填充

func _capture_memory() -> Dictionary:
    return {
        "static_mb": Performance.get_monitor(Performance.MEMORY_STATIC) / 1048576.0,
        "object_count": Performance.get_monitor(Performance.OBJECT_COUNT),
        "resource_count": Performance.get_monitor(Performance.OBJECT_RESOURCE_COUNT),
        "node_count": Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
    }

func _initialize():
    _mem_start = _capture_memory()

func _analyze_and_report():
    _mem_end = _capture_memory()
    # 计算趋势...
```

输出：
```json
{
  "memory_trend": {
    "start_static_mb": 45.2,
    "end_static_mb": 47.8,
    "delta_mb": 2.6,
    "leak_suspected": true
  }
}
```

`leak_suspected` 判定：`delta_mb > leak_threshold_mb`（默认 2MB，用户可通过参数调整）。

#### 1f. 渲染统计（独立区块）

渲染维度不出现在 `dimensions` 参数中，而是始终作为独立 `render_stats` 区块输出（采集首尾两次）：

```json
{
  "render_stats": {
    "start_draw_calls": 120,
    "end_draw_calls": 135,
    "start_objects_drawn": 89,
    "end_objects_drawn": 102
  }
}
```

### 影响范围

- `src/tools/profiler-ops.ts`：修改 `genGetData()`、新增 `dimensions` + `leak_threshold_mb` 参数解析
- 无 schema 破坏：所有新字段为可选，默认行为不变

### 验收标准

1. `get_data` 不传 `dimensions` 时行为与现有一致（只采 process，输出格式不变）
2. 传入 `dimensions: ["process", "physics"]` 时返回两个维度的独立统计
3. 输出包含 p99、趋势退化百分比、内存趋势、渲染统计
4. 已有测试不被破坏
5. **[T1]** `dimensions: ["typo"]` → 返回警告，静默 fallback 到 `["process"]`
6. **[T2]** `frame_count=1` → 退化检测跳过（`degradation_detected: false`），不崩溃
7. **[T2]** `frame_count=200` 且前慢后快 → `degradation_detected: true`
8. **[T1]** `dimensions: ["process", "render"]` → render 被忽略（不在 VALID_DIMENSIONS 中），警告日志

---

## 改进 2：高频属性快捷映射

### 现状问题

`scene` 工具的 `edit_node` 修改属性时，用户必须知道确切的 Godot 属性名（如 `position`、`rotation_degrees`、`visible`）。高频操作没有快捷方式。

### 借鉴来源

UnrealMCPBridge `modify_actor()` 的三级解析：
1. well-known 快捷方式 → 调用专用 setter
2. 点分路径 → 组件属性链
3. 通用 fallback → `setattr`

### 设计

> **审查修正：** 实现位置更正。`edit_node` 实际通过 TS 端 `src/tools/scene/helpers.ts` 的 `gdScriptSetLine()` 生成 GDScript 字符串，经 `spawnGodot` 执行。不经过 editor plugin 的 `scene_commands.gd`。

#### 2a. 实现位置

属性名展开逻辑放在 **TS 端** `src/tools/scene/helpers.ts`：

1. `gdScriptSetLine()` 生成赋值 GDScript 之前，先经过快捷映射展开
2. 映射表定义在 `helpers.ts` 中（或新建 `property-shortcuts.ts` 再导出）
3. 展开后的属性名和值传给现有的 `gdScriptSetLine()` 逻辑

**不涉及** `addons/godot_mcp_server/commands/scene_commands.gd`。

#### 2b. 快捷映射表

```typescript
const PROPERTY_SHORTCUTS: Record<string, {
  godotProp: string;
  type: 'auto' | 'bool' | 'float' | 'int' | 'color' | 'string' | 'process_mode';
  autoConvert2D3D: boolean;
  needsReadModifyWrite: boolean;  // 需要先读当前值再修改
}> = {
  'position':    { godotProp: 'position',           type: 'auto',        autoConvert2D3D: true,  needsReadModifyWrite: false },
  'rotation':    { godotProp: 'rotation_degrees',   type: 'auto',        autoConvert2D3D: true,  needsReadModifyWrite: false },
  'scale':       { godotProp: 'scale',              type: 'auto',        autoConvert2D3D: true,  needsReadModifyWrite: false },
  'visible':     { godotProp: 'visible',            type: 'bool',        autoConvert2D3D: false, needsReadModifyWrite: false },
  'enabled':     { godotProp: 'process_mode',       type: 'process_mode', autoConvert2D3D: false, needsReadModifyWrite: false },
  // ⚠ enabled 是 process_mode 的简化版，仅覆盖 INHERIT/DISABLED 两种状态。
  // 如需 ALWAYS 或 WHEN_PAUSED，请直接使用 process_mode 属性。
  'color':       { godotProp: 'modulate',           type: 'color',       autoConvert2D3D: false, needsReadModifyWrite: false },
  'opacity':     { godotProp: 'modulate',           type: 'float',       autoConvert2D3D: false, needsReadModifyWrite: true },
  'name':        { godotProp: 'name',               type: 'string',     autoConvert2D3D: false, needsReadModifyWrite: false },
  'z_index':     { godotProp: 'z_index',            type: 'int',        autoConvert2D3D: false, needsReadModifyWrite: false },
};
```

#### 2c. BLOCKED_PROPS 冲突处理

> **审查修正（HIGH）：** `process_mode` 当前在 `helpers.ts:83` 的 `BLOCKED_PROPS` 集合中。

**解决方案：** 快捷映射走独立路径，不经过 BLOCKED_PROPS 检查：

```typescript
function applyPropertyShortcuts(
  propName: string,
  value: unknown,
  nodePath: string,
): { gdscript: string; wasShortcut: boolean } | null {
  const shortcut = PROPERTY_SHORTCUTS[propName];
  if (!shortcut) return null;

  // 快捷属性跳过 BLOCKED_PROPS 检查
  switch (shortcut.type) {
    case 'process_mode': {
      const mode = value ? 'PROCESS_MODE_INHERIT' : 'PROCESS_MODE_DISABLED';
      return {
        gdscript: `_node.set_process_mode(Node.${mode})`,
        wasShortcut: true,
      };
    }
    case 'auto': {
      // 生成带 2D/3D 自适应的赋值代码
      return {
        gdscript: `_node.set("${shortcut.godotProp}", ${serializeValue(value, shortcut)})`,
        wasShortcut: true,
      };
    }
    // ...其他类型
  }
}
```

在 `edit_node` handler 中，**先检查快捷映射**，命中则跳过 BLOCKED_PROPS；未命中则走原有逻辑。

#### 2d. opacity 的 read-modify-write（含 CanvasItem 守卫）

> **审查修正（CODE-1 IMPORTANT）：** `opacity → modulate.a` 需要先读当前 `modulate` 再改 `.a`。且 `get_modulate()` / `set_modulate()` 只存在于 `CanvasItem` 子类，对 Node3D 会运行时报错。

```gdscript
# opacity 快捷方式生成的 GDScript（含 CanvasItem 类型守卫）
if _node is CanvasItem:
    var _cur_mod: Color = _node.get_modulate()
    _cur_mod.a = float(0.5)  # 用户传入的 opacity 值
    _node.set_modulate(_cur_mod)
else:
    push_warning("opacity shortcut requires CanvasItem node, got: " + _node.get_class())
```

`needsReadModifyWrite: true` 标记的属性统一走此模式。

#### 2e. 自动 2D/3D 适配

当节点类型继承自 `Node3D` 时，`position` 自动映射为 `position:Vector3`，`rotation` 映射为 `rotation_degrees:Vector3`。Node2D 则用 Vector2。

生成的 GDScript 包含运行时类型判断：

```gdscript
# position 快捷方式生成的 GDScript
if _node is Node3D:
    _node.set("position", Vector3(1.0, 2.0, 3.0))
elif _node is Node2D:
    _node.set("position", Vector2(100.0, 200.0))
```

TS 端根据传入值的数组长度（2 vs 3）生成对应的 Vector 构造。

> **ARCH-2 说明：** `_node is Node3D` 依赖 headless 模式下节点类型信息可用。headless 进程加载场景后节点类型信息完整保留（`get_class()` 返回正确类名），因此此功能在 headless 和 Bridge 模式下均可用。

### 影响范围

- `src/tools/scene/helpers.ts`：新增快捷映射表 + `applyPropertyShortcuts()` 函数
- `src/tools/scene/index.ts`：修改 `edit_node` handler，先检查快捷映射
- **不涉及** `addons/godot_mcp_server/commands/scene_commands.gd`

### 验收标准

1. `edit_node` 传入 `properties: {"position": [100, 200]}` 正常工作
2. `edit_node` 传入 `properties: {"visible": false}` 正常工作
3. `edit_node` 传入 `properties: {"enabled": false}` 调用 `set_process_mode`（绕过 BLOCKED_PROPS）
4. Node3D 节点传入 `position: [1, 2, 3]` 正确设为 Vector3
5. `edit_node` 传入 `properties: {"opacity": 0.5}` 执行 read-modify-write 设置 modulate.a
6. 原有完整属性名（如 `rotation_degrees`）仍然走原有路径，快捷映射不影响
7. 不在映射表中的属性仍受 BLOCKED_PROPS 约束
8. **[T3]** `opacity: 0.5` 对非 CanvasItem 节点（如 Node3D）→ 输出警告，不崩溃
9. **[T4]** `rotationDegrees`（camelCase）不命中快捷键，走原有 `toSnakeCase` 路径

---

## 改进 3：视口相机控制

### 现状问题

Godot MCP 无法控制视口相机。截图工具只能在 headless 模式下用固定视角，3D 项目审查体验差。

### 借鉴来源

UnrealMCPBridge 的 `set_camera_3d(location, rotation, fov)` 和 `focus_on_actor(name, distance)`。

### 设计

> **审查修正（HIGH）：** 相机操作改为放入 `game` 工具（`game_write` 新增 method），而非 `screenshot` 工具。原因：
> - `screenshot` 标记 `readonly: true`，相机修改状态违反语义
> - 相机操作依赖 game bridge 运行时连接，与 game 工具职责一致
> - 复用现有 bridge 通道，无需新增工具

#### 3a. game 工具新增 method

在 `game` 工具的 `game_write` action 中新增两个 method：

| Method | 参数 | 说明 |
|--------|------|------|
| `set_camera` | `{position, rotation, fov}` | 设置运行时 Camera3D 属性 |
| `focus_on_node` | `{node_path, distance}` | 自动计算相机位置对准目标节点 |

注册到 `WRITE_METHODS` 集合（因为是修改操作）。

#### 3b. 前提条件

- **仅 Bridge 模式可用**：需要游戏正在运行（通过 game bridge TCP 连接）
- **headless 不可用**：headless 模式不初始化渲染服务器，`get_camera_3d()` 返回 null
- 无 Camera3D 时返回清晰错误：`"No Camera3D found in current viewport"`

#### 3c. set_camera 实现（含 dispatch 路由 + fov 范围约束）

> **ARCH-5 修正：** Bridge autoload 的 `_handle_message` 函数增加方法名白名单判断。`set_camera` / `focus_on_node` 路由到自身 handler，其他走 `call_method`（方案 A，与现有 dispatch 一致）。

```gdscript
# mcp_bridge.gd 的 _handle_message 中新增路由（方案 A：白名单判断）
const _BRIDGE_METHODS = ["set_camera", "focus_on_node"]

func _handle_message(method: String, params: Dictionary) -> Dictionary:
    if method in _BRIDGE_METHODS:
        match method:
            "set_camera":     return _handle_set_camera(params)
            "focus_on_node":  return _handle_focus_on_node(params)
    # ...原有 call_method 逻辑
```

```gdscript
# mcp_bridge.gd 新增
func _handle_set_camera(params: Dictionary) -> Dictionary:
    var _cam: Camera3D = get_viewport().get_camera_3d()
    if _cam == null:
        return {"error": "No Camera3D found in current viewport"}
    if params.has("position"):
        var pos = params["position"]
        _cam.position = Vector3(float(pos[0]), float(pos[1]), float(pos[2]))
    if params.has("rotation"):
        var rot = params["rotation"]
        _cam.rotation_degrees = Vector3(float(rot[0]), float(rot[1]), float(rot[2]))
    # CODE-5: fov 范围约束 1-179 度
    if params.has("fov"):
        var _fov: float = float(params["fov"])
        if _fov > 0 and _fov <= 179:
            _cam.fov = _fov
    return {"success": true, "camera_position": [\
        _cam.position.x, _cam.position.y, _cam.position.z]}
```

#### 3d. focus_on_node 实现（含路径归一化）

> **ARCH-3 修正：** MCP 节点路径有两种格式：`root/Player`（MCP 惯例）和 `Player`（相对路径）。需归一化后再拼接 `/root/` 前缀。

```gdscript
func _normalize_node_path(p: String) -> String:
    # 去掉 "root/" 前缀（MCP 惯例格式）
    if p.begins_with("root/"):
        p = p.substr(5)
    # 去掉开头的 "/"
    if p.begins_with("/"):
        p = p.substr(1)
    return p

func _handle_focus_on_node(params: Dictionary) -> Dictionary:
    var _raw_path: String = params.get("node_path", "")
    var _normalized: String = _normalize_node_path(_raw_path)
    var _distance: float = float(params.get("distance", 5.0))
    var _target: Node3D = get_node_or_null("/root/" + _normalized)
    if _target == null:
        return {"error": "Node not found: " + _raw_path}
    if not (_target is Node3D):
        return {"error": "Node is not Node3D: " + _raw_path}
    var _cam: Camera3D = get_viewport().get_camera_3d()
    if _cam == null:
        return {"error": "No Camera3D found in current viewport"}
    var _target_pos: Vector3 = _target.global_position
    # 基于目标 AABB 计算合理的观察距离和角度
    var _bbox: AABB = _target.get_aabb() if _target.has_method("get_aabb") else AABB()
    var _effective_dist: float = max(_distance, _bbox.size.length() * 1.5)
    var _offset: Vector3 = Vector3(0, _effective_dist * 0.5, _effective_dist)
    _cam.global_position = _target_pos + _offset
    _cam.look_at(_target_pos, Vector3.UP)
    return {"success": true, "camera_position": [\
        _cam.global_position.x, _cam.global_position.y, _cam.global_position.z]}
```

> **审查修正（LOW）：** 偏移量改为基于目标 AABB 动态计算，而非硬编码 `distance*0.5`。`get_aabb()` 只对 VisualInstance3D 子类可用，需 `has_method` 守卫。

#### 3e. 截图联动

相机设置后，用户可立即调用 `screenshot capture`（通过 bridge 模式的 `take_screenshot`）捕获新视角截图。两步操作，无需合并到同一个工具。

### 影响范围

- `src/tools/game-bridge.ts`：`WRITE_METHODS` 新增 `set_camera` + `focus_on_node`
- `addons/godot_mcp_server/commands/`（bridge autoload）：新增 `_handle_set_camera` + `_handle_focus_on_node`
- **不修改** `src/tools/screenshot.ts`

### 验收标准

1. Bridge 模式下 `game_write call_method` 传入 `method: "set_camera"` 成功设置 Camera3D 的 position/rotation/fov
2. Bridge 模式下 `game_write call_method` 传入 `method: "focus_on_node"` 自动计算相机位置并对准目标
3. headless 模式下返回明确错误："No Camera3D found — camera control requires Bridge mode"
4. 无 Camera3D 时返回清晰错误信息
5. 设置相机后 `screenshot capture`（bridge 模式）反映新视角
6. **[T5]** `focus_on_node` 传入 `root/Player` 格式路径 → 正确解析（归一化后为 `/root/Player`）
7. **[T6]** headless 模式下调用 → 明确报错 "No Camera3D found — camera control requires Bridge mode"

---

## 改进 4：PIE 多玩家控制（缩窄范围）

### 现状问题

`runtime` 工具的 `run_project` 只能启动单个实例，无法测试多人场景。

### 借鉴来源

UnrealMCPBridge 的 `StartPIE(net_mode, num_clients)` 支持 standalone/listen/dedicated 三种模式。

### 设计

> **审查修正（HIGH）：** 缩窄范围。原方案需要多进程池（改动 `process-state.ts` 架构），工作量 1-2 天。修正后 MCP 只负责传递启动参数，不管理多进程生命周期。

#### 4a. 缩窄方案：仅传递启动参数

`run_project` 新增参数：

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `mp_args` | `string[]` | `[]` | 传递给 Godot 的额外命令行参数 |

**MCP 不做任何多人模式解析**——用户自行传入 `--server`、`--client`、`--port=7000` 等参数。MCP 只负责把这些参数追加到 `spawn()` 调用中。

```typescript
// runtime.ts run_project handler
const extraArgs = Array.isArray(args.mp_args) ? args.mp_args as string[] : [];
const proc = spawn(godot, ['--path', p, '--debug', ...extraArgs], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: buildSafeEnv(),
});
```

#### 4b. 安全约束

`mp_args` 参数做白名单校验（只允许 `--` 开头的参数）：

```typescript
for (const arg of extraArgs) {
  if (!arg.startsWith('--')) {
    return textResult(`Error: mp_args items must start with "--", got: "${arg}"`);
  }
}
```

#### 4c. 多实例启动

用户如需启动多个实例（server + N 个 client），需多次调用 `run_project`（每次 `stop_project` 后再启动新实例）。MCP 仍然只管理单个进程。

**替代方案（远期）：** 如多进程需求强烈，可后续在 `process-state.ts` 中引入进程池。本次不实施。

#### 4d. 文档说明

工具描述中添加示例：
```
多人测试示例：
1. run_project(mp_args: ["--server", "--port=7000"]) → 启动服务端
2. 手动或脚本启动客户端
3. stop_project → 停止服务端

注意：单横杠参数（如 -s 脚本模式、-f 全屏）不支持，此类功能请通过项目内脚本或场景配置实现。
```

### 影响范围

- `src/tools/runtime.ts`：`run_project` handler 新增 `mp_args` 参数，约 10 行改动
- **不修改** `process-state.ts`

### 验收标准

1. `run_project` 不传 `mp_args` 时行为与现在完全一致
2. `mp_args: ["--headless", "--server"]` 正确追加到 Godot 启动参数
3. 非 `--` 开头的参数被拒绝并返回错误
4. `stop_project` 正常停止（无多进程管理需求）

---

## 改进 5：持久执行上下文（取消）

> **审查修正：** 原方案标记为"暂不实施"，审查确认这一判断正确。

### 取消理由

1. **Expression 无法持久变量**（MEDIUM）：`Expression` 不支持 `var` 声明，验收标准第 2 条"变量在后续调用中可访问"不可实现
2. **安全绕过风险**（MEDIUM）：`eval_expression` 绕过 `_is_blocked_method` 检查，可执行 `get_tree().quit()`
3. **现有替代充足**：`workflow.dev_loop` 文件状态 + `execute_gdscript` 独立进程已覆盖 90% 调试场景

### 结论

**取消此项。** 如未来有需求，降级为只读 `evaluate_expression`（不修改 context，只返回求值结果）。

---

## 改进 6：蓝图 Graph API（Deferred）

### 结论

无变化。Godot 无等效蓝图系统，现有 `animtree`/`material`/`ui` 工具已覆盖对应场景。**暂不实施**。

---

## 实施优先级（v2 修正）

| 优先级 | 改进 | 预估工作量 | 影响文件数 | 状态 |
|--------|------|-----------|-----------|------|
| P0 | Profiler 增强 | 3-4h | 1 (`profiler-ops.ts`) | 可立即启动 |
| P1 | 属性快捷映射 | 3-4h | 2 (`scene/helpers.ts`, `scene/index.ts`) | 需注意 BLOCKED_PROPS |
| P1 | 相机控制 | 3-4h | 2 (`game-bridge.ts`, bridge autoload) | 仅 Bridge 模式 |
| P2 | 多人启动参数 | 1h | 1 (`runtime.ts`) | 缩窄为参数透传 |
| ~~P2~~ | ~~持久上下文~~ | ~~N/A~~ | ~~N/A~~ | **取消** |
| Deferred | Graph API | N/A | N/A | 无变化 |

**建议实施顺序：** P0 → P1（属性+相机可并行）→ P2

---

## 风险与约束（v2 修正）

1. **Profiler 增强**：纯 GDScript 生成改动，风险最低。渲染统计独立区块避免单位混淆
2. **属性快捷映射**：快捷路径绕过 BLOCKED_PROPS，需确保只开放预定义的安全映射（`enabled` → `set_process_mode`），不开放任意属性绕过
3. **相机控制**：仅 Bridge 模式可用（需游戏运行中），headless 模式明确报错
4. **多人启动参数**：白名单校验（只允许 `--` 开头），MCP 不管理多进程生命周期
5. ~~持久上下文~~：**已取消**
6. **Graph API**：无明确需求，暂不实施

---

## 审查问题修正追踪

### v1 审查（首次代码审查，3 HIGH + 6 MEDIUM）

| # | 严重度 | 问题 | 修正方式 |
|---|--------|------|---------|
| 1 | HIGH | 改进 2 实现位置指向 scene_commands.gd | 更正为 TS 端 `helpers.ts` 的 `gdScriptSetLine()` |
| 2 | HIGH | enabled → process_mode 与 BLOCKED_PROPS 冲突 | 快捷映射走独立路径，跳过 BLOCKED_PROPS |
| 3 | HIGH | screenshot readonly 语义违反 | 相机操作移到 game 工具 game_write method |
| 4 | HIGH | 单进程架构不支持多进程 | 缩窄为参数透传，不管理多进程 |
| 5 | MEDIUM | 渲染维度单位不匹配 | 独立为 render_stats 区块 |
| 6 | MEDIUM | 内存趋势采样间隔未指定 | 短会话只采首尾两次 |
| 7 | MEDIUM | leak_suspected 阈值缺失 | 暴露 leak_threshold_mb 参数（默认 2MB） |
| 8 | MEDIUM | headless 模式不可用未说明 | 明确标注"仅 Bridge 模式可用" |
| 9 | MEDIUM | bridge method 注册集合未指定 | 注册到 WRITE_METHODS |
| 10 | MEDIUM | detached 客户端无法清理 | 缩窄方案后 MCP 不管理多进程 |
| 11 | MEDIUM | Expression 无法持久变量 | 取消此项 |
| 12 | MEDIUM | eval_expression 安全绕过 | 取消此项 |
| 13 | LOW | focus_on_node 偏移硬编码 | 改为基于 AABB 动态计算 |
| 14 | LOW | opacity 需 read-modify-write | 需求正确，文档已明确说明 |

### v2 eng review（8 IMPORTANT 设计/代码 + 3 ADVISORY + 6 测试缺口）

| # | ID | 严重度 | 问题 | 修正方式 |
|---|-----|--------|------|---------|
| 15 | ARCH-1 | IMPORTANT | Dimensions 到 Performance Monitor 映射表未定义 | 新增映射表 + TS 端生成逻辑说明 |
| 16 | ARCH-2 | IMPORTANT | 2D/3D 自适应 headless 可靠性 | 补充说明：headless 下节点类型信息完整保留 |
| 17 | ARCH-3 | IMPORTANT | focus_on_node 路径前缀未归一化 | 新增 `_normalize_node_path()` 函数 |
| 18 | ARCH-5 | IMPORTANT | Bridge dispatch 路由机制未明确 | 方案 A：白名单判断，`set_camera`/`focus_on_node` 路由到自身 handler |
| 19 | CODE-1 | IMPORTANT | opacity 缺 CanvasItem 类型守卫 | 添加 `if _node is CanvasItem` 前置检查 |
| 20 | CODE-2 | IMPORTANT | 趋势退化 frame_count<2 除零 | 添加 `if _n < 2` 前置守卫 |
| 21 | CODE-4 | IMPORTANT | `_capture_memory()` 函数未定义 | 补充完整伪代码 |
| 22 | CODE-6 | IMPORTANT | dimensions 参数校验缺失 | TS 端 VALID_DIMENSIONS 白名单 + 无效维度警告 |
| 23 | ARCH-4 | ADVISORY | mp_args 白名单限制应文档化 | 4d 节补充单横杠参数不支持说明 |
| 24 | CODE-3 | ADVISORY | enabled 语义说明 | 映射表注释补充：仅覆盖 INHERIT/DISABLED |
| 25 | CODE-5 | ADVISORY | set_camera fov 缺上限 | fov 范围约束 1-179 度 |
| 26 | T1 | 测试缺口 | dimensions 无效字符串处理 | 改进 1 验收标准 #5 |
| 27 | T2 | 测试缺口 | frame_count=1 退化检测 | 改进 1 验收标准 #6-7 |
| 28 | T3 | 测试缺口 | opacity 对非 CanvasItem | 改进 2 验收标准 #8 |
| 29 | T4 | 测试缺口 | rotationDegrees 兼容性 | 改进 2 验收标准 #9 |
| 30 | T5 | 测试缺口 | 节点路径 root/ 前缀归一化 | 改进 3 验收标准 #6 |
| 31 | T6 | 测试缺口 | headless 模式相机报错 | 改进 3 验收标准 #7 |
