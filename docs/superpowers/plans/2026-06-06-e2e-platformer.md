# mcp-e2e-platformer 端到端验证实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Kenney New Platformer Pack 构建一个 2D 平台跳跃项目，端到端验证 godot-mcp-enhanced 核心工具链（场景/TileMap/UI/音频/验证）的协同能力。

**Architecture:** 7 阶段顺序执行，每阶段产出一个可验证的中间产物（场景文件/脚本），最终组装为完整项目并通过 `verify_delivery`。所有操作通过 MCP 工具完成，项目独立于 godot-mcp-enhanced 仓库。

**Tech Stack:** Godot 4.4+、GDScript、Kenney CC0 资源包

**Spec:** `docs/superpowers/specs/2026-06-06-e2e-platformer-design.md`

**项目路径常量：**
- `PROJECT_PATH` = `D:\GitHub\mcp-e2e-platformer`
- `ASSETS_DIR` = `D:\GitHub\mcp-e2e-platformer\assets\kenney_new_platformer_pack`

---

## Task 1: 项目创建与验证

**目标**：创建 Godot 项目脚手架，验证项目配置正确。

**Files:**
- Create: `D:\GitHub\mcp-e2e-platformer\project.godot`
- Create: `D:\GitHub\mcp-e2e-platformer\scenes\` (模板生成)
- Create: `D:\GitHub\mcp-e2e-platformer\scripts\` (模板生成)

- [ ] **Step 1: 用 create_project 创建 2D 平台模板项目**

调用 MCP 工具：
```
project(action="create_project",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  project_name="mcp-e2e-platformer",
  template="2d-platformer",
  renderer="forward_plus",
  godot_version="4.4")
```

预期：返回 `status: "ok"`，目录 `D:\GitHub\mcp-e2e-platformer` 已创建。

- [ ] **Step 2: 确认 project.godot 存在**

用 Bash 检查：
```bash
Test-Path "D:\GitHub\mcp-e2e-platformer\project.godot"
```
预期：`True`

- [ ] **Step 3: 用 validate_project 验证项目**

调用 MCP 工具：
```
validation(action="validate_project",
  project_path="D:\\GitHub\\mcp-e2e-platformer")
```

预期：返回无错误（`errors: 0` 或 `valid: true`）。

- [ ] **Step 4: 提交验证结果记录**

记录阶段 1 通过标准：`project.godot` 存在 ✅ + `validate_project` 无错误 ✅

---

## Task 2: 资源下载与导入

**目标**：下载 Kenney New Platformer Pack，解压到项目 assets 目录，导入 Godot 资源。

**Files:**
- Create: `D:\GitHub\mcp-e2e-platformer\assets\kenney_new_platformer_pack\` (完整 Kenney 解压)

- [ ] **Step 1: 下载 Kenney New Platformer Pack**

用浏览器或 curl 下载：
```bash
Invoke-WebRequest -Uri "https://kenney.nl/media/13330/kenney_newplatformerpack.zip" -OutFile "$env:TEMP\kenney_newplatformerpack.zip"
```

> 注：URL 可能随版本变化，如果下载失败，手动从 https://kenney.nl/assets/new-platformer-pack 下载 ZIP。

- [ ] **Step 2: 创建 assets 目录并解压**

```bash
New-Item -ItemType Directory -Force -Path "D:\GitHub\mcp-e2e-platformer\assets"
Expand-Archive -Path "$env:TEMP\kenney_newplatformerpack.zip" -DestinationPath "D:\GitHub\mcp-e2e-platformer\assets" -Force
```

- [ ] **Step 3: 确认 Kenney 目录结构**

```bash
Get-ChildItem "D:\GitHub\mcp-e2e-platformer\assets\kenney_new_platformer_pack" -Recurse -Directory | Select-Object FullName
```

预期：存在 `PNG/Tiles/`、`PNG/Players/`、`PNG/Items/`、`PNG/Background/`、`Audio/` 目录。

- [ ] **Step 4: 用 import_resources 导入**

调用 MCP 工具：
```
validation(action="import_resources",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  directory="assets",
  extensions=[".png", ".jpg", ".wav", ".ogg"],
  recursive=true)
```

预期：返回成功，列出导入的资源文件。

- [ ] **Step 5: 记录实际可用的图块文件名**

```bash
Get-ChildItem "D:\GitHub\mcp-e2e-platformer\assets\kenney_new_platformer_pack\PNG\Tiles" -Name | Select-Object -First 10
```

> **重要**：记录实际 PNG 文件名，后续 tilemap 操作需要使用。不同版本的 Kenney 包文件名可能不同。

记录阶段 2 通过标准：Kenney 目录结构完整 ✅ + `import_resources` 成功 ✅

---

## Task 3: TileMapLayer 关卡搭建

**目标**：生成 TileSet 资源，创建关卡场景，用 TileMapLayer 绘制地面和平台，添加碰撞体，保存。

**Files:**
- Create: `D:\GitHub\mcp-e2e-platformer\assets\tileset_platformer.tres`
- Create: `D:\GitHub\mcp-e2e-platformer\scenes\level_01.tscn`

**依赖**：Task 2 完成（资源已导入、实际文件名已记录）

- [ ] **Step 1: 用 execute_gdscript 生成 TileSet**

根据 Task 2 Step 5 记录的实际图块文件名，生成 TileSet。以下示例假设存在 `tile_000.png` 等文件，**执行时需替换为实际文件名**：

调用 MCP 工具：
```
script(action="execute_gdscript",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  code="""
var ts = TileSet.new()
var ts_size = Vector2i(32, 32)
ts.tile_size = ts_size
ts Rendering_layers_layout = 1

# 获取图块目录下所有 PNG 文件
var dir = DirAccess.open("res://assets/kenney_new_platformer_pack/PNG/Tiles")
if dir:
  dir.list_dir_begin()
  var file_name = dir.get_next()
  var source_id = 0
  while file_name != "":
    if file_name.ends_with(".png"):
      var source = TileSetAtlasSource.new()
      source.texture = load("res://assets/kenney_new_platformer_pack/PNG/Tiles/" + file_name)
      # 假设每个 PNG 是单独一个图块（1x1 atlas）
      source.texture_region_size = ts_size
      source.create_tile(Vector2i(0, 0))
      ts.add_source(source, source_id)
      source_id += 1
    file_name = dir.get_next()
  dir.list_dir_end()

# 保存 TileSet
var save_path = "res://assets/tileset_platformer.tres"
var err = ResourceSaver.save(ts, save_path)
if err == OK:
  _mcp_output("tileset", "created")
  _mcp_output("source_count", str(ts.get_source_count()))
  _mcp_output("save_path", save_path)
else:
  _mcp_output("tileset", "failed: " + str(err))
_mcp_done()
""",
  timeout=30)
```

预期：返回 `tileset: "created"`、`source_count` 大于 0。

- [ ] **Step 2: 确认 TileSet 文件已生成**

```bash
Test-Path "D:\GitHub\mcp-e2e-platformer\assets\tileset_platformer.tres"
```
预期：`True`

- [ ] **Step 3: 创建关卡场景**

调用 MCP 工具：
```
scene(action="create_scene",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="D:\\GitHub\\mcp-e2e-platformer\\scenes\\level_01.tscn",
  root_node_type="Node2D",
  root_node_name="Level01")
```

预期：返回 `status: "ok"`。

- [ ] **Step 4: 添加 TileMapLayer 节点**

调用 MCP 工具：
```
scene(action="add_node",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="res://scenes/level_01.tscn",
  parent_node_path="Level01",
  node_type="TileMapLayer",
  node_name="Ground",
  properties={"tile_set": "res://assets/tileset_platformer.tres"})
```

预期：返回节点路径。

- [ ] **Step 5: 用 tilemap_fill_rect 绘制地面**

用 source_id=0（第一个图块）绘制一行地面。坐标范围根据图块尺寸计算：

调用 MCP 工具：
```
tilemap(action="tilemap_fill_rect",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  node_path="Level01/Ground",
  layer=0,
  region={"x": 0, "y": 10, "w": 20, "h": 2},
  source_id=0,
  atlas_coords={"x": 0, "y": 0})
```

预期：返回成功。

- [ ] **Step 6: 用 tilemap_set_cell 绘制浮空平台**

调用 MCP 工具：
```
tilemap(action="tilemap_set_cell",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  node_path="Level01/Ground",
  layer=0,
  coords={"x": 5, "y": 7},
  source_id=0,
  atlas_coords={"x": 0, "y": 0})
```

再画几个平台：
```
tilemap(action="tilemap_set_cell", ..., coords={"x": 6, "y": 7}, ...)
tilemap(action="tilemap_set_cell", ..., coords={"x": 7, "y": 7}, ...)
tilemap(action="tilemap_set_cell", ..., coords={"x": 12, "y": 5}, ...)
tilemap(action="tilemap_set_cell", ..., coords={"x": 13, "y": 5}, ...)
```

- [ ] **Step 7: 用 tilemap_read 验证绘制结果**

调用 MCP 工具：
```
tilemap(action="tilemap_read",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  node_path="Level01/Ground",
  layer=0,
  region={"x": 0, "y": 5, "w": 20, "h": 8})
```

预期：返回的 cells 数据包含步骤 5-6 绘制的图块坐标。

- [ ] **Step 8: 用 tilemap_copy + tilemap_paste 复制区块**

调用 MCP 工具：
```
tilemap(action="tilemap_copy",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  node_path="Level01/Ground",
  layer=0,
  source_region={"x": 5, "y": 7, "w": 3, "h": 1})
```

记录返回的 pattern，然后粘贴：
```
tilemap(action="tilemap_paste",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  node_path="Level01/Ground",
  layer=0,
  target={"x": 15, "y": 7},
  pattern=<Step 8 copy 返回的 pattern>)
```

- [ ] **Step 9: 添加地面碰撞体 — StaticBody2D**

调用 MCP 工具：
```
scene(action="add_node",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="res://scenes/level_01.tscn",
  parent_node_path="Level01",
  node_type="StaticBody2D",
  node_name="GroundBody")
```

- [ ] **Step 10: 添加碰撞形状 — CollisionShape2D**

调用 MCP 工具：
```
scene(action="add_node",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="res://scenes/level_01.tscn",
  parent_node_path="Level01/GroundBody",
  node_type="CollisionShape2D",
  node_name="GroundCollision")
```

然后用 execute_gdscript 创建并绑定 RectangleShape2D：
```
script(action="execute_gdscript",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  code="""
var shape = RectangleShape2D.new()
shape.size = Vector2(640, 64)
var err = ResourceSaver.save(shape, "res://assets/ground_shape.tres")
_mcp_output("shape_saved", "OK" if err == OK else str(err))
_mcp_done()
""")
```

然后 edit_node 设置 shape：
```
scene(action="edit_node",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="res://scenes/level_01.tscn",
  node_path="Level01/GroundBody/GroundCollision",
  properties={"shape": "res://assets/ground_shape.tres", "position": {"x": 320, "y": 368}})
```

- [ ] **Step 11: 保存场景**

调用 MCP 工具：
```
scene(action="save_scene",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="res://scenes/level_01.tscn")
```

- [ ] **Step 12: 确认 .tscn 文件包含 TileMapLayer 数据**

```bash
Select-String -Path "D:\GitHub\mcp-e2e-platformer\scenes\level_01.tscn" -Pattern "TileMapLayer|tile_data"
```

预期：匹配到 TileMapLayer 和 tile_data。

记录阶段 3 通过标准：`tilemap_read` 一致 ✅ + `save_scene` 包含数据 ✅

---

## Task 4: 玩家角色与金币道具

**目标**：创建玩家场景（CharacterBody2D + Sprite2D + CollisionShape2D），编写移动脚本；创建金币（Area2D），编写收集脚本；实例化到关卡。

**Files:**
- Create: `D:\GitHub\mcp-e2e-platformer\scenes\player.tscn`
- Create: `D:\GitHub\mcp-e2e-platformer\scripts\player.gd`
- Create: `D:\GitHub\mcp-e2e-platformer\scripts\coin.gd`

**依赖**：Task 3 完成（level_01.tscn 已保存）

- [ ] **Step 1: 创建玩家场景**

调用 MCP 工具：
```
scene(action="create_scene",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="D:\\GitHub\\mcp-e2e-platformer\\scenes\\player.tscn",
  root_node_type="CharacterBody2D",
  root_node_name="Player")
```

- [ ] **Step 2: 添加 Sprite2D 并加载角色精灵**

根据 Task 2 记录的实际文件名，选择一个玩家角色 PNG：

调用 MCP 工具：
```
scene(action="add_node",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="res://scenes/player.tscn",
  parent_node_path="Player",
  node_type="Sprite2D",
  node_name="PlayerSprite",
  properties={"texture": "res://assets/kenney_new_platformer_pack/PNG/Players/<实际文件名>.png"})
```

> 注意：`<实际文件名>` 需在执行时替换为 Task 2 中记录的 Players 目录下的实际 PNG 文件名。

- [ ] **Step 3: 添加 CollisionShape2D 并设置 Shape**

调用 MCP 工具：
```
scene(action="add_node",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="res://scenes/player.tscn",
  parent_node_path="Player",
  node_type="CollisionShape2D",
  node_name="PlayerCollision")
```

创建 Shape 资源：
```
script(action="execute_gdscript",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  code="""
var shape = RectangleShape2D.new()
shape.size = Vector2(28, 28)
var err = ResourceSaver.save(shape, "res://assets/player_shape.tres")
_mcp_output("shape_saved", "OK" if err == OK else str(err))
_mcp_done()
""")
```

设置 shape 属性：
```
scene(action="edit_node",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="res://scenes/player.tscn",
  node_path="Player/PlayerCollision",
  properties={"shape": "res://assets/player_shape.tres"})
```

- [ ] **Step 4: 编写玩家移动脚本**

调用 MCP 工具：
```
script(action="write_script",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  script_path="D:\\GitHub\\mcp-e2e-platformer\\scripts\\player.gd",
  content="""extends CharacterBody2D

const SPEED = 200.0
const JUMP_VELOCITY = -400.0
var gravity = ProjectSettings.get_setting(\"physics/2d/default_gravity\")

func _physics_process(delta):
\tif not is_on_floor():
\t\tvelocity.y += gravity * delta
\tif Input.is_action_just_pressed(\"ui_up\") and is_on_floor():
\t\tvelocity.y = JUMP_VELOCITY
\tvar direction = Input.get_axis(\"ui_left\", \"ui_right\")
\tif direction:
\t\tvelocity.x = direction * SPEED
\telse:
\t\tvelocity.x = move_toward(velocity.x, 0, SPEED)
\tmove_and_slide()
""")
```

- [ ] **Step 5: 立即验证 player.gd**

调用 MCP 工具：
```
validation(action="validate_scripts",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scripts=["scripts/player.gd"])
```

预期：无语法错误。

- [ ] **Step 6: 绑定脚本到玩家场景**

调用 MCP 工具：
```
scene(action="edit_node",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="res://scenes/player.tscn",
  node_path="Player",
  properties={"script": "res://scripts/player.gd"})
```

- [ ] **Step 7: 保存玩家场景**

```
scene(action="save_scene",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="res://scenes/player.tscn")
```

- [ ] **Step 8: 用 execute_gdscript 创建金币场景**

金币需要 Area2D + Sprite2D + CollisionShape2D + script，一步到位：

```
script(action="execute_gdscript",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  code="""
# 创建金币脚本
var coin_script_content = \"extends Area2D\\n\\nfunc _on_body_entered(body):\\n\\tif body.name == \\\"Player\\\":\\n\\t\\tqueue_free()\"
var coin_file = FileAccess.open(\"res://scripts/coin.gd\", FileAccess.WRITE)
coin_file.store_string(coin_script_content)
coin_file.close()

# 创建碰撞 Shape
var coin_shape = RectangleShape2D.new()
coin_shape.size = Vector2(16, 16)
ResourceSaver.save(coin_shape, \"res://assets/coin_shape.tres\")

_mcp_output(\"coin_script\", \"created\")
_mcp_output(\"coin_shape\", \"created\")
_mcp_done()
""")
```

- [ ] **Step 9: 验证 coin.gd**

```
validation(action="validate_scripts",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scripts=["scripts/coin.gd"])
```

预期：无语法错误。

- [ ] **Step 10: 实例化玩家到关卡**

调用 MCP 工具：
```
scene(action="instance_scene",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="res://scenes/level_01.tscn",
  parent_node_path="Level01",
  instance_path="res://scenes/player.tscn",
  properties={"position": {"x": 100, "y": 280}})
```

- [ ] **Step 11: 添加金币到关卡**

调用 MCP 工具（在关卡中添加 Area2D 金币节点）：
```
scene(action="add_node",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="res://scenes/level_01.tscn",
  parent_node_path="Level01",
  node_type="Area2D",
  node_name="Coin1",
  properties={"position": {"x": 200, "y": 250}, "script": "res://scripts/coin.gd"})
```

给金币添加 Sprite2D 和 CollisionShape2D：
```
scene(action="add_node", ..., parent_node_path="Level01/Coin1", node_type="Sprite2D", node_name="CoinSprite", properties={"texture": "res://assets/kenney_new_platformer_pack/PNG/Items/<金币文件名>.png"})
scene(action="add_node", ..., parent_node_path="Level01/Coin1", node_type="CollisionShape2D", node_name="CoinCollision", properties={"shape": "res://assets/coin_shape.tres"})
```

> 注意：需用信号连接 body_entered。在 .tscn 中手动编辑或通过 execute_gdscript 添加 `[connection]` 段。

- [ ] **Step 12: 连接金币信号**

用 execute_gdscript 在 .tscn 文件中追加信号连接：
```
script(action="execute_gdscript",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  code="""
var tscn_path = \"res://scenes/level_01.tscn\"
var file = FileAccess.open(tscn_path, FileAccess.READ)
var content = file.get_as_text()
file.close()

# 检查是否已有 connection 段
if not \"body_entered\" in content:
  var connection = \"\\n[connection signal=\\\"body_entered\\\" from=\\\"Level01/Coin1\\\" to=\\\"Level01/Coin1\\\" method=\\\"_on_body_entered\\\"]\\n\"
  content += connection
  var write_file = FileAccess.open(tscn_path, FileAccess.WRITE)
  write_file.store_string(content)
  write_file.close()
  _mcp_output(\"signal\", \"connected\")
else:
  _mcp_output(\"signal\", \"already_exists\")
_mcp_done()
""")
```

- [ ] **Step 13: 保存关卡场景**

```
scene(action="save_scene",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="res://scenes/level_01.tscn")
```

- [ ] **Step 14: 确认玩家和金币已实例化**

```bash
Select-String -Path "D:\GitHub\mcp-e2e-platformer\scenes\level_01.tscn" -Pattern "Player|Coin1|CharacterBody2D|Area2D"
```

预期：匹配到 Player 实例和 Coin1 节点。

记录阶段 4 通过标准：Sprite2D 有纹理 ✅ + 碰撞体存在 ✅ + `validate_scripts` 通过 ✅

---

## Task 5: HUD 界面

**目标**：创建 HUD CanvasLayer，用 ui_build_layout 构建界面布局，添加控件、锚点、HP 条。

**Files:**
- Create: `D:\GitHub\mcp-e2e-platformer\scenes\hud.tscn`

**依赖**：无（与 Task 4 独立）

- [ ] **Step 1: 创建 HUD 场景**

调用 MCP 工具：
```
scene(action="create_scene",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="D:\\GitHub\\mcp-e2e-platformer\\scenes\\hud.tscn",
  root_node_type="CanvasLayer",
  root_node_name="HUD")
```

- [ ] **Step 2: 用 ui_build_layout 构建顶部信息栏**

调用 MCP 工具：
```
ui(action="ui_build_layout",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="res://scenes/hud.tscn",
  parent_path="HUD",
  tree={
    "type": "VBoxContainer",
    "name": "TopBar",
    "anchor_preset": "top_wide",
    "layout": {"direction": "column", "justify": "flex-start", "padding": [10, 10, 10, 10]},
    "children": [
      {
        "type": "HBoxContainer",
        "name": "StatsRow",
        "layout": {"direction": "row", "justify": "space-between", "gap": 8},
        "children": [
          {"type": "Label", "name": "ScoreLabel", "properties": {"text": "Score: 0"}},
          {"type": "Label", "name": "HPLabel", "properties": {"text": "HP: 100"}}
        ]
      }
    ]
  })
```

- [ ] **Step 3: 添加 HP 进度条**

调用 MCP 工具：
```
ui(action="ui_create_control",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="res://scenes/hud.tscn",
  node_type="ProgressBar",
  node_name="HPBar",
  parent_node_path="HUD/TopBar/StatsRow",
  properties={"value": 100, "max_value": 100, "custom_minimum_size": {"x": 120, "y": 16}})
```

- [ ] **Step 4: 用 ui_draw_recipe 绘制 HP 条背景**

调用 MCP 工具：
```
ui(action="ui_draw_recipe",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="res://scenes/hud.tscn",
  node_path="HUD/TopBar/StatsRow/HPBar",
  ops=[
    {"kind": "rect", "position": [0, 0], "size": [120, 16], "color": [0.2, 0.2, 0.2]},
    {"kind": "rect", "position": [0, 0], "size": [84, 16], "color": [0, 0.8, 0]},
    {"kind": "string", "text": "70/100", "position": [40, 12], "color": [1, 1, 1], "font_size": 10}
  ])
```

- [ ] **Step 5: 用 ui_get_layout 验证布局**

调用 MCP 工具：
```
ui(action="ui_get_layout",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="res://scenes/hud.tscn",
  node_path="HUD/TopBar")
```

预期：返回 `StatsRow` → `ScoreLabel` + `HPLabel` + `HPBar` 的正确层级。

- [ ] **Step 6: 保存 HUD 场景**

```
scene(action="save_scene",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="res://scenes/hud.tscn")
```

- [ ] **Step 7: 确认 .tscn 包含 UI 数据**

```bash
Select-String -Path "D:\GitHub\mcp-e2e-platformer\scenes\hud.tscn" -Pattern "VBoxContainer|Label|ProgressBar"
```

预期：匹配到 VBoxContainer、Label、ProgressBar。

记录阶段 5 通过标准：`ui_get_layout` 返回正确层级 ✅ + `save_scene` 成功 ✅

---

## Task 6: 音效验证

**目标**：添加 AudioStreamPlayer，播放/停止音效，验证 API 调用。

**Files:**
- Modify: `D:\GitHub\mcp-e2e-platformer\scenes\level_01.tscn`（添加音频节点）

**依赖**：Task 3 完成（level_01.tscn 存在）

- [ ] **Step 1: 添加 AudioStreamPlayer 到 level_01**

调用 MCP 工具：
```
scene(action="add_node",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="res://scenes/level_01.tscn",
  parent_node_path="Level01",
  node_type="AudioStreamPlayer",
  node_name="JumpSFX")
```

- [ ] **Step 2: 播放跳跃音效**

调用 MCP 工具：
```
audio(action="audio_play",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  node_path="Level01/JumpSFX",
  stream_path="res://assets/kenney_new_platformer_pack/Audio/<实际音效文件名>.wav",
  volume_db=-6)
```

> 注意：`<实际音效文件名>` 需替换为 Audio 目录下的实际 WAV 文件名。可在 Task 2 中记录。

- [ ] **Step 3: 调整音量**

调用 MCP 工具：
```
audio(action="audio_set_param",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  node_path="Level01/JumpSFX",
  param="volume_db",
  value=-10)
```

- [ ] **Step 4: 查询播放状态**

调用 MCP 工具：
```
audio(action="audio_query",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  node_path="Level01/JumpSFX")
```

预期：返回状态信息（headless 可能返回 `playing: false`，属于非阻塞）。

- [ ] **Step 5: 停止播放**

调用 MCP 工具：
```
audio(action="audio_stop",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  node_path="Level01/JumpSFX")
```

- [ ] **Step 6: 再次查询状态**

```
audio(action="audio_query",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  node_path="Level01/JumpSFX")
```

预期：API 不崩溃（状态值本身非阻塞）。

- [ ] **Step 7: 保存场景**

```
scene(action="save_scene",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="res://scenes/level_01.tscn")
```

记录阶段 6 通过标准：`audio_query` 返回状态 ✅（非阻塞）

---

## Task 7: 组装与最终验证

**目标**：创建主场景，实例化子场景，注册运行入口，运行验证，截图，交付检查。

**Files:**
- Create: `D:\GitHub\mcp-e2e-platformer\scenes\main.tscn`
- Modify: `D:\GitHub\mcp-e2e-platformer\project.godot`（注册 main_scene）

**依赖**：Task 4、5、6 全部完成

- [ ] **Step 1: 创建主场景**

调用 MCP 工具：
```
scene(action="create_scene",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="D:\\GitHub\\mcp-e2e-platformer\\scenes\\main.tscn",
  root_node_type="Node2D",
  root_node_name="Main")
```

- [ ] **Step 2: 实例化 level_01 子场景**

调用 MCP 工具：
```
scene(action="instance_scene",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="res://scenes/main.tscn",
  parent_node_path="Main",
  instance_path="res://scenes/level_01.tscn",
  node_name="Level")
```

- [ ] **Step 3: 实例化 hud 子场景**

调用 MCP 工具：
```
scene(action="instance_scene",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="res://scenes/main.tscn",
  parent_node_path="Main",
  instance_path="res://scenes/hud.tscn",
  node_name="GameHUD")
```

- [ ] **Step 4: 保存主场景**

```
scene(action="save_scene",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene_path="res://scenes/main.tscn")
```

- [ ] **Step 5: 注册运行入口到 project.godot**

用 execute_gdscript 写入 `run/main_scene`：
```
script(action="execute_gdscript",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  code="""
var config = ConfigFile.new()
var err = config.load(\"res://project.godot\")
if err == OK:
  config.set_value(\"application\", \"run/main_scene\", \"res://scenes/main.tscn\")
  config.save(\"res://project.godot\")
  _mcp_output(\"main_scene\", \"registered\")
else:
  _mcp_output(\"main_scene\", \"load_failed: \" + str(err))
_mcp_done()
""")
```

预期：返回 `main_scene: "registered"`。

- [ ] **Step 6: 确认 project.godot 包含 main_scene**

```bash
Select-String -Path "D:\GitHub\mcp-e2e-platformer\project.godot" -Pattern "main_scene"
```

预期：匹配到 `run/main_scene="res://scenes/main.tscn"`。

- [ ] **Step 7: 用 run_and_verify 验证运行**

调用 MCP 工具：
```
validation(action="run_and_verify",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene="res://scenes/main.tscn",
  timeout=15,
  capture_tree=true)
```

预期：无崩溃（exit code 0 或正常超时退出）。

- [ ] **Step 8: 截图验证（允许空白）**

调用 MCP 工具：
```
screenshot(action="capture",
  project_path="D:\\GitHub\\mcp-e2e-platformer",
  scene="res://scenes/main.tscn",
  output_path="D:\\GitHub\\mcp-e2e-platformer\\screenshot.png",
  viewport_width=1280,
  viewport_height=720)
```

预期：文件生成成功（即使内容空白也不阻塞）。2D 截图在 headless 模式下可能是空白，这是已知限制。

- [ ] **Step 9: 用 verify_delivery 最终验证**

调用 MCP 工具：
```
verify_delivery(project_path="D:\\GitHub\\mcp-e2e-platformer",
  scope="full",
  checks={
    "scene_tree": true,
    "script_health": true,
    "performance": true,
    "gdd_standards": false
  })
```

预期：返回 `status: "passed"`（或大部分检查通过）。

- [ ] **Step 10: 记录最终结果**

汇总所有阶段通过标准：

| 阶段 | 状态 |
|------|------|
| 1 项目创建 | ✅ / ❌ |
| 2 资源导入 | ✅ / ❌ |
| 3 TileMapLayer | ✅ / ❌ |
| 4 角色/道具 | ✅ / ❌ |
| 5 HUD | ✅ / ❌ |
| 6 音效 | ✅ / ❌（非阻塞） |
| 7 组装验证 | ✅ / ❌（截图除外） |

全部阻塞项 ✅ = 验证通过。
