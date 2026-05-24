# P2 Shader + 材质工具设计文档

> **版本**: v0.7.0 | **日期**: 2026-05-03 | **状态**: 已批准

## 目标

为 godot-mcp-enhanced 新增 3 个 MCP 工具，覆盖 Godot 4.x 的 ShaderMaterial 和内置材质的完整操作：参数读写、材质创建/附加/持久化、Shader 代码编辑、模板库、编译诊断。

## 工具总览

| 工具 | 职责 | 生成器函数 |
|------|------|-----------|
| `material_read` | 读取节点材质属性 + shader uniform 列表 | `genMaterialReadScript` |
| `material_write` | 写参数 / 创建材质 / 附加 / 保存 .tres | `genMaterialSetParamsScript`, `genMaterialCreateScript`, `genMaterialSaveScript`, `genMaterialLoadScript` |
| `shader_edit` | 读写 shader code / 加载 .gdshader / 模板 / 编译诊断 | `genShaderReadScript`, `genShaderWriteScript`, `genShaderLoadFileScript`, `genShaderSaveFileScript`, `genShaderListTemplatesScript`, `genShaderApplyTemplateScript` |

**模块文件**: `src/tools/material-ops.ts`（新建，约 600-700 行）

**复用 shared.ts**: `SCENE_TREE_HEADER`, `NON_PERSIST`, `opsErrorResult`, `parseGdscriptResult`

---

## 工具 1: material_read

### 输入 Schema

```json
{
  "project_path": "string (必填)",
  "node_path": "string (必填) — 场景树节点路径",
  "material_index": "number (可选, 默认 0)",
  "load_autoloads": "boolean (可选, 默认 true)"
}
```

### 行为

1. 材质获取优先级（material_index 仅对 mesh surface 材质生效）：
   - 优先检查 `node.material_override`（如果存在，直接使用，忽略 material_index）
   - 如果没有 material_override，检查 `node.get_surface_override_material(material_index)`
   - 最后尝试 `node.mesh.surface_get_material(material_index)`（mesh 内嵌材质）
2. 判断材质类型（`material.get_class()`）
3. ShaderMaterial: 遍历 `shader.get_shader_uniform_list()` 获取名称/类型/当前值 + shader resource_path
4. 内置材质: 遍历 `get_property_list()` 过滤 `usage & PROPERTY_USAGE_STORAGE` 获取可序列化属性

### 输出格式

```json
{
  "success": true,
  "data": {
    "material_type": "ShaderMaterial",
    "resource_path": "res://materials/player.tres",
    "shader_uniforms": [
      {"name": "albedo", "type": 20, "hint": 0, "value": [1, 0, 0, 1]},
      {"name": "intensity", "type": 3, "hint": 0, "value": 2.5}
    ],
    "properties": {
      "render_priority": 0,
      "shader_path": "res://shaders/player.gdshader"
    }
  }
}
```

Type 值对照 Godot Variant.Type 枚举（3=float, 20=Color 等）。

---

## 工具 2: material_write

### 输入 Schema

```json
{
  "project_path": "string (必填)",
  "node_path": "string (必填)",
  "material_index": "number (可选, 默认 0)",
  "action": "enum (必填): set_params | create | save | load",
  "params": "object (set_params 时必填) — {uniform_name: value, ...}",
  "material_type": "string (create 时必填) — 白名单校验",
  "shader_path": "string (create ShaderMaterial 时可选)",
  "resource_path": "string (save/load 时必填) — res://materials/xxx.tres",
  "load_autoloads": "boolean (可选, 默认 true)"
}
```

### 各 action 行为

**set_params:**
- ShaderMaterial: `material.set_shader_parameter(name, value)`
- 内置材质: `material.set(name, value)`
- params 值类型映射约定（按数组长度自动推断 Godot 类型）：
  - `number` → float
  - `string` → 内置材质属性直接赋值（如 resource_name）；对于 ShaderMaterial 的 sampler2D uniform，`string` 视为资源路径并调用 `load()`
  - `boolean` → bool
  - `null` → null
  - `array` 长度 2 → `Vector2(x, y)`
  - `array` 长度 3 → `Vector3(x, y, z)`
  - `array` 长度 4 → `Color(r, g, b, a)`
  - 其他类型拒绝（返回 INVALID_PARAM_TYPE 错误）
  - 注意：GDShader uniform 不支持纯 string 类型，string 在 ShaderMaterial 上下文中仅用于资源路径（sampler2D 等）

**create:**
- 白名单: `ShaderMaterial`, `StandardMaterial3D`, `CanvasItemMaterial`
- 创建 `material_type.new()` → 如果是 ShaderMaterial 且有 shader_path，先检查 `ResourceLoader.exists(shader_path)`，不存在返回 MATERIAL_NOT_FOUND
- 附加到节点: `node.material_override = material`

**save:**
- 先通过 `DirAccess.make_dir_recursive()` 确保父目录存在
- `ResourceSaver.save(material, resource_path)`
- resource_path 必须以 `res://` 开头

**load:**
- 先检查 `ResourceLoader.exists(resource_path)`，不存在返回 MATERIAL_NOT_FOUND
- `material = load(resource_path)`，加载失败（返回 null）返回 MATERIAL_NOT_FOUND
- 附加到节点: `node.material_override = material`

---

## 工具 3: shader_edit

### 输入 Schema

```json
{
  "project_path": "string (必填)",
  "node_path": "string (read/write/load_file/apply_template 时必填; list_templates/save_file 时可选)",
  "action": "enum (必填): read | write | load_file | save_file | list_templates | apply_template",
  "code": "string (write 时必填) — 完整 shader 代码",
  "file_path": "string (load_file/save_file 时必填) — res://shaders/xxx.gdshader",
  "template_name": "string (apply_template 时必填)",
  "load_autoloads": "boolean (可选, 默认 true)"
}
```

### 各 action 行为

**read:** 返回 `material.shader.code`（完整 shader 源码）

**write:** 先 `material.shader = material.shader.duplicate()` 避免影响共享同一 shader 的其他材质，然后设置 `material.shader.code = code`，触发 Godot 自动编译，返回编译诊断

**load_file:** `material.shader = load(file_path)`

**save_file:** 将 shader code 写入文件（通过 FileAccess），如果文件已存在则**直接覆盖**（不提示确认）

**list_templates:** 返回内置模板列表（名称 + 描述 + uniform 列表）

**apply_template:** 从模板生成 shader code，设置到材质，返回编译诊断

### 内置模板库

| 模板名 | 类型 | uniform 参数 | 适用 |
|--------|------|-------------|------|
| `dissolve` | 2D/3D 通用 | edge_color: Color, edge_width: float, progress: float | sprite/mesh 溶解 |
| `outline` | 2D | outline_color: Color, outline_width: float | sprite 描边 |
| `blur` | 2D | blur_amount: float, direction: vec2 | sprite 模糊 |
| `glow` | 2D | glow_color: Color, glow_intensity: float | sprite 发光 |
| `water` | 3D | wave_speed: float, wave_scale: float, deep_color: Color, shallow_color: Color | mesh 水面 |
| `gradient_map` | 2D/3D 通用 | gradient_texture: Texture, intensity: float | 色调映射 |

每个模板存储为 TypeScript 常量字符串（GDShader 代码），在 genShaderApplyTemplateScript 中嵌入。

### 编译诊断格式

```json
{
  "compile_success": true,
  "errors": [],
  "warnings": ["line 5: unused varying 'uv'"]
}
```

或失败时:
```json
{
  "compile_success": false,
  "errors": [
    {"line": 12, "message": "Expected ',' after uniform declaration"}
  ],
  "warnings": []
}
```

编译诊断机制：通过检查 `material.shader.code` 设置后 `RenderingServer` 的 shader 编译状态获取。如果 API 不可用，降级为检查 `material.shader` 是否有效（非 null 但 `get_shader()` 返回无效 RID 表示编译失败），并解析 GDScript 执行的 stderr 输出作为错误详情。

---

## 错误处理

### 错误码

```typescript
export const MATERIAL_ERROR_CODES = {
  MATERIAL_NOT_FOUND: 'MATERIAL_NOT_FOUND',
  INVALID_MATERIAL_TYPE: 'INVALID_MATERIAL_TYPE',
  INVALID_PARAM_TYPE: 'INVALID_PARAM_TYPE',
  SHADER_COMPILE_FAILED: 'SHADER_COMPILE_FAILED',
  RESOURCE_SAVE_FAILED: 'RESOURCE_SAVE_FAILED',
  INVALID_TEMPLATE: 'INVALID_TEMPLATE',
};
```

### 错误映射规则

| GDScript 错误消息 | 映射错误码 |
|------------------|-----------|
| "Node not found" | MATERIAL_NOT_FOUND |
| "No material" | MATERIAL_NOT_FOUND |
| "Not a ShaderMaterial" | INVALID_MATERIAL_TYPE |
| "Shader compile" / "shader error" | SHADER_COMPILE_FAILED |
| "Failed to save" | RESOURCE_SAVE_FAILED |
| "Invalid param type" / "not supported type" | INVALID_PARAM_TYPE |
| 其他 | SCRIPT_EXEC_FAILED |

### 安全校验

- 材质类型白名单: `ShaderMaterial`, `StandardMaterial3D`, `CanvasItemMaterial`
- shader code 通过 gdEscape 转义后嵌入 GDScript 字符串
- 文件路径通过 resolveWithinRoot 校验（已有 helpers）
- resource_path 必须以 `res://` 开头
- params 值类型白名单: number, string, boolean, null, Array (用于 Color/Vector)

---

## 架构

### 文件结构

```
src/tools/material-ops.ts    — 新建，3 个工具定义 + handler + gen*Script + 模板常量
src/tools/shared.ts          — 复用，不修改
src/tools/godot-ops.ts       — 不修改
src/tools/tilemap-ops.ts     — 不修改
src/GodotServer.ts           — 添加 materialOps 导入
test/material-ops.test.js    — 新建
```

### GDScript 生成模式

沿用 gen*Script 模式，所有函数返回 `extends SceneTree` 的 GDScript 字符串。示例:

```typescript
export function genMaterialReadScript(nodePath: string, materialIndex: number): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
    var node = get_node("${gdEscape(nodePath)}")
    if node == null:
        _mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
        _mcp_done()
        return
    var mat = node.material_override
    if mat == null:
        mat = node.get_surface_override_material(${materialIndex})
    if mat == null and node.mesh != null:
        mat = node.mesh.surface_get_material(${materialIndex})
    if mat == null:
        _mcp_output("error", "No material on node")
        _mcp_done()
        return
    var info = {}
    info["material_type"] = mat.get_class()
    info["resource_path"] = mat.resource_path if mat.resource_path else ""
    ...
    _mcp_output("material_info", info)
    _mcp_done()
`;
}
```

### 注册

```typescript
// GodotServer.ts
import * as materialOps from './tools/material-ops.js';
const toolModules = [..., materialOps];
```

### 版本

v0.7.0（GodotServer.ts VERSION + package.json version 同步更新）

---

## 测试策略

- 纯函数测试：所有 gen*Script 函数（验证输出包含正确的 GDScript 片段）
- 验证函数测试：参数校验（params 类型、材质类型白名单、template 名有效性）
- 错误码测试：MATERIAL_ERROR_CODES 包含所有定义
- 边界场景测试：
  1. `material_read` 节点无材质时返回 MATERIAL_NOT_FOUND
  2. `set_params` 传入非法 uniform 名时的错误处理
  3. `create` 传入不在白名单中的 material_type 被拒绝
  4. `shader_edit/write` 传入语法错误的 code，验证编译诊断格式
  5. `save` 到不存在的子目录（自动创建）
  6. `load` 不存在的 .tres 文件返回错误
  7. `apply_template` 后 uniform 默认值正确
- 预计新增约 30-40 个测试用例

## Godot 版本要求

最低支持 Godot 4.2+。`get_shader_uniform_list()`、`set_shader_parameter()` 等 API 在 4.0+ 可用，但 4.2+ 行为更稳定。
Godot 4.3+ 新增的 `material_overlay` 属性暂不在本版本支持范围内，后续版本可扩展。
