# E2E 验证发现优化设计

## 目标

基于 mcp-e2e-platformer 端到端业务验证的 5 个核心痛点，设计优化方案：
**减少进程启动开销 + 解决持久化 + 资源预热 + 2D 截图 + 安全配置写入**

## 约束

- 向后兼容：现有 MCP 工具 API 签名不变，内部切换实现
- 并行实施：5 个优化独立开发，不区分优先级

## 痛点与方案总览

| # | 痛点 | 方案 | 收益 |
|---|------|------|------|
| P1 | 每次工具调用启动 Godot 进程（2-3s） | add_node/edit_node 走 tscn-editor 纯文件操作 | <50ms |
| P2 | tilemap 运行时状态不持久化 | scene_commit 批量 GDScript | N 次进程 → 1 次 |
| P3 | Headless 无法加载导入资源 | --headless --import 预热 | 纹理可用 |
| P4 | 2D 截图空白 | SubViewport 渲染（待验证） | 2D 可截图 |
| P5 | 沙箱禁止修改 project.godot | project_write_config 白名单 API | 安全配置写入 |

---

## P1：add_node/edit_node/save_scene → tscn-editor 纯文件操作

### 当前架构

```
MCP 调用 add_node
  → scene/index.ts case 'add_node'
  → spawnGodot(['--headless', '--script', opsScript, 'add_node', params])
  → 启动 Godot 进程（2-3s）→ 执行 GDScript → 写入 .tscn → 进程退出
```

### 目标架构

```
MCP 调用 add_node
  → scene/index.ts case 'add_node'
  → 检测属性类型 → 纯文件操作路径
  → tscn-editor.addNode()（纯 TS 文件操作，<50ms）
  → 直接返回结果
```

### tscn-editor 扩展

现有函数（无需修改）：
- `editNodeProperty()` — 修改节点属性
- `deleteNode()` — 删除节点
- `addConnection()` / `removeConnection()` — 信号连接
- `setNodeScript()` — 绑定脚本

**新增函数：**

| 函数 | 功能 |
|------|------|
| `addNode()` | 添加节点到 .tscn |
| `addNodes()` | 批量添加多个节点（一次 parse + 一次写回） |
| `addExtResource()` | 添加外部资源引用（含去重） |
| `addSubResource()` | 添加子资源 |

### 节点插入位置算法

.tscn 中节点是深度优先排列，新子节点必须插入到 parent 的最后一个后代节点之后：

```
输入：parent_path（如 "." 或 "GroundBody"）
算法：
  1. 从 parent 节点 section 开始，向后扫描所有 [node] sections
  2. 对每个后续节点，检查其 parent 属性：
     - parent === parent_path 或 parent 以 parent_path + "/" 开头 → 后代，继续
     - 否则 → 非后代，当前行就是插入点
  3. 在插入点之前插入新 [node] section
```

### 属性类型白名单 + 自动回退

**首版支持（纯文件操作）：**
`String`, `int`, `float`, `bool`, `Vector2`, `Vector2i`, `Vector3`, `Vector3i`, `Color`, `Rect2`, `Rect2i`, `Enum`（`@export_enum`）, `ResourcePath`（如 `res://...`）

**自动回退到 Godot 进程：**
`Array`, `Dictionary`, `SubResource` 嵌套（如内联 Shape）, `Curve`, `Gradient`, `PackedByteArray`, 自定义对象

回退逻辑：`addNode()` 检测 props → 命中不支持类型 → 调用 `spawnGodotAddNode()` → 调用方无感知。

### ext_resource 去重

```typescript
function addExtResource(tscn: string, type: string, path: string): string {
  // 先检查是否已有相同 path 的 ext_resource
  // 已有 → 返回现有 id
  // 未有 → 添加新 entry，返回新 id
}
```

### load_steps 同步

`addExtResource()` 和 `addSubResource()` 插入时自动更新 `[gd_scene load_steps=N]`，N += 1。

### 批量接口

```typescript
function addNodes(tscn: string, nodes: Array<{
  parent: string;
  name: string;
  type: string;
  properties?: Record<string, unknown>;
}>): { content: string; fallback: boolean }
// 一次 parseTscn → 计算所有插入点 → 批量插入 → 一次写回
// 任一节点属性触发回退 → 整批回退到 Godot 进程
```

### 工具路由表

| 工具 | 走文件操作？ | 说明 |
|------|------------|------|
| `create_scene` | ✅ | 已有纯文件实现（quick_scene 路径） |
| `add_node` | ✅ 简单属性 | 纯 TS；含 SubResource 时自动回退 |
| `edit_node` | ✅ 已实现 | `editNodeProperty` 已存在 |
| `remove_node` | ✅ 已实现 | `deleteNode` 已存在 |
| `save_scene` | ✅ | 文件操作路径自动持久化，不需要单独 save |
| `instance_scene` | ✅ | 生成 ext_resource（含去重）+ instance 节点 |
| `read_scene` | ✅ 已实现 | `parseTscn` 已存在 |
| `load_sprite` | ⚠️ 回退 | 需要实际加载纹理验证，保留进程路径 |

---

## P2：scene_commit 批量 GDScript

### 问题

当前 `tilemap_set_cell` / `tilemap_fill_rect` 每次调用启动一个 Godot 进程，修改运行时状态，但进程退出后数据丢失。

### 方案

新增 `scene_commit` 工具，将多个场景修改合并为一次 Godot 进程调用。

### API

```
scene_commit(
  project_path: string,
  scene_path: string,
  operations: [
    { op: "tile_set",   node_path: string, coords: {x,y}, source_id: int, atlas: {x,y}, alternative_tile?: int },
    { op: "tile_fill",  node_path: string, region: {x,y,w,h}, source_id: int, atlas: {x,y}, alternative_tile?: int },
    { op: "tile_erase", node_path: string, coords: {x,y} },
    { op: "tile_clear", node_path: string, layer?: int },
    { op: "tileset_assign", node_path: string, tileset_path: string },
    { op: "node_property", path: string, property: string, value: unknown },
    { op: "node_add", parent: string, name: string, type: string, properties?: Record<string, unknown> },
  ],
  save: boolean = true,
  stop_on_error: boolean = true
)
```

### 返回值格式

```json
{
  "success": false,
  "saved": false,
  "error_count": 1,
  "results": [
    { "op": "tile_set", "node_path": "Ground", "ok": true },
    { "op": "tile_fill", "node_path": "Ground", "ok": true, "cells_affected": 40 },
    { "op": "node_property", "path": "MissingNode", "ok": false, "error": "Node not found" }
  ]
}
```

### GDScript 生成模板

```gdscript
extends SceneTree

var _results = []
var _has_error = false

func _fill_tiles(node, rx, ry, rw, rh, sid, atlas, alt):
    for cy in range(ry, ry + rh):
        for cx in range(rx, rx + rw):
            node.set_cell(Vector2i(cx, cy), sid, atlas, alt)

func _initialize():
    var scene = load("res://scenes/Level.tscn")
    var inst = scene.instantiate()

    # --- 操作 1: tile_fill ---
    var n1 = inst.get_node_or_null("Ground")
    if n1 == null:
        _results.append({"op":"tile_fill","ok":false,"error":"Node not found: Ground"})
        _has_error = true
    else:
        _fill_tiles(n1, 0, 10, 20, 2, 0, Vector2i(0,0), 0)
        _results.append({"op":"tile_fill","ok":true,"cells":40})

    if _has_error:
        print("COMMIT_RESULT: " + JSON.stringify({"success":false,"saved":false,"results":_results}))
        quit()
        return

    # --- 保存 ---
    var packed = PackedScene.new()
    packed.pack(inst)
    var err = ResourceSaver.save(packed, "res://scenes/Level.tscn")
    print("COMMIT_RESULT: " + JSON.stringify({"success":true,"saved":err==0,"results":_results}))
    quit()
```

### 错误处理策略

- **`stop_on_error: true`**（默认）：遇错 break，不 save
- **`stop_on_error: false`**：遇错 continue，记录错误，最后仍然 save
- 每个操作用 `get_node_or_null()` 而非 `get_node()`，避免 Godot 内部报错淹没结构化输出

### tile_fill 优化

大区域填充用函数封装，避免生成大量 set_cell 调用：

```gdscript
func _fill_tiles(node, rx, ry, rw, rh, sid, atlas, alt):
    for cy in range(ry, ry + rh):
        for cx in range(rx, rx + rw):
            node.set_cell(Vector2i(cx, cy), sid, atlas, alt)
```

主逻辑只调函数，生成脚本体量可控。

### P1/P2 路由规则

```
add_node 调用
├─ props 全在白名单？
│   ├─ YES → P1 纯文件操作（<50ms）
│   └─ NO  → 自动回退
│       ├─ 单个节点 → 现有 Godot 进程路径
│       └─ 多个节点或含 tilemap → P2 scene_commit
edit_node → P1 纯文件操作（已有 editNodeProperty）
tilemap_* → 单次走现有进程，批量推荐 scene_commit
```

---

## P3：资源预热 — `--headless --import`

### 问题

Headless 模式下 Godot 不运行资源导入管线，`.godot/imported/` 不存在或过时，导致 `load()` 失败。

### 方案

当检测到资源未导入时，自动执行 `godot --headless --import --path <project>` 预热。

### 共享模块

提取到 `src/tools/import-check.ts`：

```typescript
export function needsImport(projectPath: string): boolean
export function runImport(projectPath: string, godotPath: string): Promise<void>
```

使用方：
- `gdscript-executor.ts` — executeGdscript 前检查
- `scene_commit.ts`（P2）— spawn 前检查

### 缓存策略

每次执行前轻量级时间戳检查（非布尔缓存）：

```typescript
let lastImportTimestamp: number | null = null;

function needsImport(projectPath: string): boolean {
  const importedDir = path.join(projectPath, ".godot", "imported");
  if (!exists(importedDir)) return true;

  // 扫描 assets/ 目录 mtime（不递归读内容）
  const latestAsset = getLatestMtime(path.join(projectPath, "assets"));
  if (latestAsset > lastImportTimestamp) return true;

  return false;
}
```

这样能捕获会话内新增资源，开销 <1ms。

### 触发时机

- `executeGdscript()` 首次调用时
- `scene_commit` 执行前
- 可通过 `GODOT_MCP_AUTO_IMPORT=false` 禁用

### 性能特征

- 首次预热：小项目 <5s，大项目 10-30s
- 后续调用：时间戳检查 <1ms，跳过预热
- P1 文件操作路径不需要预热

---

## P4：2D 截图 — SubViewport 方案

### 问题

Headless 渲染器不初始化 2D CanvasItem，导致 2D 场景截图完全空白。

### 方案

用 SubViewport 替代直接 viewport 截图。先验证可行性再实现。

### 验证脚本

```gdscript
extends SceneTree
func _initialize():
    var vp = SubViewport.new()
    vp.size = Vector2i(1280, 720)
    vp.render_target_update_mode = SubViewport.UPDATE_ALWAYS
    root.add_child(vp)

    # 测试 1：纯色绘制
    var rect = ColorRect.new()
    rect.color = Color.RED
    rect.size = Vector2(200, 100)
    rect.position = Vector2(100, 50)
    vp.add_child(rect)

    # 测试 2：纹理渲染（如果资源存在）
    var tex_path = "res://assets/Sprites/Tiles/Default/block_green.png"
    if ResourceLoader.exists(tex_path):
        var sprite = Sprite2D.new()
        sprite.texture = load(tex_path)
        sprite.position = Vector2(400, 300)
        vp.add_child(sprite)

    # 等待 5 帧
    for i in range(5):
        await get_tree().process_frame

    var img = vp.get_texture().get_image()
    img.save_png("res://test_subviewport.png")
    print("COLOR_PIXEL: " + str(img.get_pixel(200, 100)))
    print("BG_PIXEL: " + str(img.get_pixel(10, 10)))
    if ResourceLoader.exists(tex_path):
        print("TEX_PIXEL: " + str(img.get_pixel(400, 300)))
    quit()
```

**判定标准：**
- `COLOR_PIXEL` 返回红色 → 纯色渲染可行
- `TEX_PIXEL` 返回非空白 → 纹理渲染可行
- 两者都空白 → headless 不支持任何 2D 渲染，走备选方案

### 实现路径

**如果 SubViewport 可行：**

修改 `screenshot capture` 的 GDScript 生成逻辑：
1. 创建 SubViewport（`UPDATE_ALWAYS`，加入场景树）
2. 实例化目标场景到 SubViewport 子节点
3. 等待 `frame_delay` 帧（默认 15）
4. `SubViewport.get_texture().get_image()` → save

API 签名不变。

**如果 SubViewport 不可行（备选）：**

维持现状，改进错误提示：
1. 截图返回标注 `BLANK_2D_HEADLESS` 状态
2. 建议 3 种替代：Bridge `take_screenshot` / Editor 模式截图 / 用户提供截图 + `screenshot analyze`

---

## P5：安全配置写入 — `project_write_config`

### 问题

`execute_gdscript` 沙箱禁止 `FileAccess.open`，无法在 GDScript 中修改 `project.godot`。

### 方案

新增 `project_write_config` 工具（注册到 `mcp__godot__project`，action `write_config`），只允许修改预定义的白名单字段。

### API

```
project_write_config(
  project_path: string,
  key: string,    // 白名单内的配置键
  value: string,  // 新值
)
```

### 白名单字段

| key | 类型 | 合法值 |
|-----|------|--------|
| `run/main_scene` | 资源路径 | `res://...` |
| `application/config/name` | 字符串 | 任意 |
| `application/config/description` | 字符串 | 任意 |
| `application/config/icon` | 资源路径 | `res://...` |
| `display/window/size/viewport_width` | 整数 | 正整数 |
| `display/window/size/viewport_height` | 整数 | 正整数 |
| `display/window/stretch/mode` | 枚举 | `disabled`, `canvas_items`, `viewport` |
| `display/window/stretch/aspect` | 枚举 | `ignore`, `keep`, `keep_height`, `keep_width`, `expand` |
| `rendering/renderer/rendering_method` | 枚举 | `forward_plus`, `mobile`, `gl_compatibility` |
| `autoload/*` | 资源路径 | `res://...`，实现自动加 `*` 前缀 |

**首版不支持：**
- `input/*` — 输入映射是多行结构化数据，非简单字符串。输入映射用 `execute_gdscript` + `ProjectSettings.set_setting()` 处理。

### 实现逻辑

```typescript
function projectWriteConfig(projectPath: string, key: string, value: string): Result {
  // 1. 验证 key 在白名单内
  if (!isAllowedConfigKey(key)) {
    return error('CONFIG_KEY_NOT_ALLOWED', `${key} is not in the allowed config keys`);
  }

  // 2. 验证 value 格式（资源路径校验 res://、整数校验、枚举校验）
  if (!validateConfigValue(key, value)) {
    return error('INVALID_CONFIG_VALUE', `Invalid value for ${key}: ${value}`);
  }

  // 3. 读取 project.godot
  // 4. 解析 INI 段结构，找到或创建对应 section
  // 5. 替换或新增 key=value 行
  // 6. 写回文件
  return { success: true, key, value };
}
```

### 安全考虑

- 不暴露 FileAccess：TS 端直接操作文件，不经过 GDScript 沙箱
- 白名单严格限制：只能修改预定义的安全字段
- 路径安全：project_path 经过 `resolveWithinRoot` 校验
- 值校验：资源路径验证 `res://` 前缀，整数验证数字格式，枚举验证合法值
- autoload 自动加 `*` 前缀

### autoload 处理

用户传 `value: "res://scripts/game_manager.gd"`，实现自动补为 `"*res://scripts/game_manager.gd"`。`*` 前缀表示启用全局作用域。

---

## 实施顺序建议

5 个优化独立，但存在依赖关系：

```
P3 资源预热（独立，最简单）
  ↓
P1 纯文件操作（核心收益，扩展 tscn-editor）
  ↓
P2 scene_commit（需要 P1 的回退机制）
  ↓
P4 2D 截图（需要先验证 SubViewport）
  ↓
P5 配置写入（独立，最简单）
```

建议 P3 和 P5 先行（实施量小），P1 核心收益最大放中间，P2 依赖 P1 回退机制，P4 需要验证。
