# mcp-e2e-platformer 端到端业务验证设计

## 目标

用 Kenney New Platformer Pack（CC0）构建一个简单 2D 平台跳跃项目，
端到端验证 godot-mcp-enhanced 核心工具链的协同能力：
**项目创建 → 资源导入 → TileMap 关卡 → 角色/道具 → UI 布局 → 音效 → 组装验证**

## 项目信息

| 项 | 值 |
|----|-----|
| 项目名 | `mcp-e2e-platformer` |
| 路径 | `D:\GitHub\mcp-e2e-platformer` |
| Godot 版本 | 4.4+ |
| 资源来源 | Kenney New Platformer Pack（CC0） |
| 资源下载 | `https://kenney.nl/assets/new-platformer-pack` |

## 项目结构

```
mcp-e2e-platformer/
  project.godot
  assets/
    kenney_new_platformer_pack/     ← Kenney 原始解压结构
      PNG/Tiles/                    ← 图块（用于 TileMapLayer）
      PNG/Players/                  ← 角色精灵
      PNG/Items/                    ← 金币/道具
      PNG/Background/               ← 背景图
      Audio/                        ← 音效 WAV
    tileset_platformer.tres         ← MCP 生成的 TileSet
  scenes/
    main.tscn                       ← 运行入口（instance level + player + hud）
    level_01.tscn                   ← TileMapLayer 关卡 + 碰撞体
    player.tscn                     ← 玩家角色 + 碰撞形状
    hud.tscn                        ← HUD CanvasLayer
  scripts/
    player.gd                       ← 玩家移动逻辑
    coin.gd                         ← 金币收集逻辑
```

## 验证流程（7 阶段）

### 阶段 1：项目创建

| 步骤 | MCP 工具 | 验证点 |
|------|---------|--------|
| 创建项目 | `create_project(template="2d-platformer")` | 脚手架生成正确 |
| 验证配置 | `validate_project` | 无错误 |

**通过标准**：`project.godot` 存在 + `validate_project` 无错误 | **阻塞**

---

### 阶段 2：资源导入

| 步骤 | 操作 | 验证点 |
|------|------|--------|
| 下载 Kenney 包 | 用户下载解压到 `assets/` | `PNG/Tiles/`、`Audio/` 目录存在 |
| 导入资源 | `import_resources` | Godot 识别资源文件 |

**通过标准**：Kenney 目录结构完整 + `import_resources` 成功 | **阻塞**

---

### 阶段 3：TileMapLayer 关卡搭建

| 步骤 | MCP 工具 | 验证点 |
|------|---------|--------|
| 生成 TileSet | `execute_gdscript` → `tileset_platformer.tres` | TileSet 引用正确图块 PNG |
| 创建关卡场景 | `create_scene(root_node_type="Node2D", root_node_name="Level01")` | `level_01.tscn` 创建 |
| 添加 TileMapLayer | `add_node(node_type="TileMapLayer")` | 节点存在 |
| 绘制地面 | `tilemap_fill_rect` | 地面区域填满图块 |
| 绘制平台 | `tilemap_set_cell` | 浮空平台绘制 |
| 读取验证 | `tilemap_read` | 与绘制一致 |
| 区块复制 | `tilemap_copy` + `tilemap_paste` | 复制到新位置 |
| 添加地面碰撞 | `add_node(StaticBody2D)` + `add_node(CollisionShape2D)` | 地面有物理碰撞 |
| 设置碰撞形状 | `edit_node` 设置 `CollisionShape2D.shape` 为 `RectangleShape2D` | Shape 资源绑定到碰撞节点 |
| 保存场景 | `save_scene` | `.tscn` 包含完整数据 |

**通过标准**：`tilemap_read` 一致 + `save_scene` 后数据完整 | **阻塞**

---

### 阶段 4：角色与道具

| 步骤 | MCP 工具 | 验证点 |
|------|---------|--------|
| 创建玩家场景 | `create_scene(root_node_type="CharacterBody2D")` | `player.tscn` 创建 |
| 加载角色精灵 | `add_node(Sprite2D)` + `load_sprite` | PNG 正确加载 |
| 添加碰撞形状 | `add_node(CollisionShape2D)` + `edit_node` 设置 `shape` 为 `RectangleShape2D` | 碰撞体绑定到玩家 |
| 编写移动脚本 | `write_script(player.gd)` | 写入成功 |
| **立即验证** | `validate_scripts([player.gd])` | 无语法错误 |
| 放置金币道具 | `add_node(Area2D)` + `Sprite2D` + `CollisionShape2D`（`edit_node` 设置 `shape` 为 `RectangleShape2D`） | 金币可检测玩家穿越 |
| 编写金币脚本 | `write_script(coin.gd)` | 写入成功 |
| **立即验证** | `validate_scripts([coin.gd])` | 无语法错误 |
| 实例化到关卡 | `instance_scene` | player + coins 实例化到 `level_01` |
| 保存场景 | `save_scene` | 包含实例化引用 |

**通过标准**：Sprite2D 有纹理 + 碰撞体存在 + `validate_scripts` 通过 | **阻塞**

---

### 阶段 5：HUD 界面

| 步骤 | MCP 工具 | 验证点 |
|------|---------|--------|
| 创建 HUD 场景 | `create_scene(root_node_type="CanvasLayer")` | `hud.tscn` 创建 |
| 构建布局 | `ui_build_layout`（VBox + HBox） | Flexbox → Container 树 |
| 添加控件 | `ui_create_control`（Label/Button/TextureRect） | 控件创建成功 |
| 设置锚点 | `ui_anchor_preset(preset="top_wide")` | 锚点正确 |
| 绘制 HP 条 | `ui_draw_recipe`（rect 绘制） | 自定义绘制成功 |
| 保存场景 | `save_scene` | `.tscn` 包含 UI 数据 |

**通过标准**：`ui_get_layout` 返回正确层级 + `save_scene` 成功 | **阻塞**

---

### 阶段 6：音效

| 步骤 | MCP 工具 | 验证点 |
|------|---------|--------|
| 添加 AudioStreamPlayer 到 `level_01` | `add_node`（`parent_node_path` 指向 `level_01`） | 音频节点存在于正确场景 |
| 播放跳跃音效 | `audio_play(stream_path=...)` | API 调用不崩溃 |
| 调整音量 | `audio_set_param(param="volume_db")` | 参数设置成功 |
| 查询播放状态 | `audio_query` | 返回 `playing: true` |
| 停止播放 | `audio_stop` | 停止成功 |
| 查询停止状态 | `audio_query` | 返回 `playing: false` |

**通过标准**：`audio_query` 返回状态（允许 headless 无实际音频输出） | **非阻塞**

---

### 阶段 7：组装与最终验证

| 步骤 | MCP 工具 | 验证点 |
|------|---------|--------|
| 创建主场景 | `create_scene(root_node_type="Node2D", root_node_name="Main")` | `main.tscn` 创建 |
| 实例化子场景 | `instance_scene(level_01)` + `instance_scene(hud)` | 子场景嵌入正确 |
| 保存主场景 | `save_scene` | 入口文件完整 |
| 注册运行入口 | `execute_gdscript` 写入 `project.godot` 的 `run/main_scene="res://scenes/main.tscn"` | `run_and_verify` 能找到入口 |
| Headless 运行验证 | `run_and_verify` | 无崩溃 |
| 截图验证 | `screenshot capture` | 文件生成成功（允许空白，仅验证 API 不崩溃） |
| 交付验证 | `verify_delivery` | 全维度通过 |

**通过标准**：`run_and_verify` 无崩溃 + `verify_delivery` passed（截图仅验证 API 不崩溃） | **阻塞（截图除外）**

---

## 通过标准汇总

| 阶段 | 关键通过标准 | 阻塞级别 |
|------|-------------|---------|
| 1 | `project.godot` 存在 + `validate_project` 无错误 | 阻塞 |
| 2 | Kenney 目录结构完整 + `import_resources` 成功 | 阻塞 |
| 3 | `tilemap_read` 与绘制一致 + `save_scene` 包含数据 | 阻塞 |
| 4 | Sprite2D 有纹理 + 碰撞体存在 + `validate_scripts` 通过 | 阻塞 |
| 5 | `ui_get_layout` 返回正确层级 + `save_scene` 成功 | 阻塞 |
| 6 | `audio_query` 返回正确状态 | 非阻塞（headless 可能无音频） |
| 7 | `run_and_verify` 无崩溃 + `verify_delivery` passed | 阻塞（截图除外） |

## 关键设计决策

1. **TileMapLayer 代替 TileMap**：Godot 4.4+ 推荐使用 TileMapLayer
2. **Kenney 原始解压结构**：不手动重分类资源，直接保留 Kenney 的 PNG/Audio 目录结构
3. **碰撞体必须**：平台游戏没有碰撞体会导致 `run_and_verify` 失败
4. **脚本验证前移**：每次 `write_script` 后立即 `validate_scripts`，出错早发现
5. **save_scene 显式调用**：每个阶段修改场景后显式保存
6. **主场景用 instance_scene 组装**：不用 `quick_scene`，用 `create_scene` + `instance_scene`
7. **截图允许空白**：Headless 模式 2D 截图是已知限制，仅验证 API 不崩溃
8. **CollisionShape2D 必须设置 Shape**：`add_node` 创建节点后通过 `edit_node` 设置 `shape` 为 `RectangleShape2D`，否则碰撞不生效
9. **金币用 Area2D**：金币是触发区域而非实体碰撞，玩家穿过时 `body_entered` 信号触发收集
10. **主场景必须注册**：`create_scene` + `save_scene` 后需通过 `execute_gdscript` 写入 `project.godot` 的 `run/main_scene`，否则 `run_and_verify` 找不到入口

## 覆盖的 MCP 工具清单

| 工具类别 | 具体工具 |
|---------|---------|
| 项目管理 | `create_project`, `validate_project`, `import_resources` |
| 场景操作 | `create_scene`, `add_node`, `edit_node`, `save_scene`, `instance_scene`, `load_sprite` |
| TileMap | `tilemap_set_cell`, `tilemap_fill_rect`, `tilemap_read`, `tilemap_copy`, `tilemap_paste` |
| UI 系统 | `ui_build_layout`, `ui_create_control`, `ui_set_layout`, `ui_anchor_preset`, `ui_draw_recipe`, `ui_get_layout` |
| 音频 | `audio_play`, `audio_stop`, `audio_set_param`, `audio_query` |
| 脚本 | `write_script`, `validate_scripts`, `execute_gdscript` |
| 验证 | `run_and_verify`, `verify_delivery`, `screenshot` |
