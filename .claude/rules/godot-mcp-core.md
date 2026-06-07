---
description: "godot-mcp 核心指南 模式选择 Headless Editor Bridge execute_gdscript edit_script dev_loop run_and_verify validate_scripts verify_delivery 运行时 持久化"
alwaysApply: true
---

> 适用于 godot-mcp-enhanced v0.17.0+

## 概述与架构

godot-mcp-enhanced 提供 130+ 工具，通过三层架构操作 Godot：

1. **Headless CLI** — 独立 Godot 进程执行 GDScript，适合文件读写和一次性验证
2. **Editor WebSocket** — 连接运行中的编辑器插件，适合实时场景操作
3. **Game Bridge** — TCP 连接运行中的游戏，适合运行时调试和 E2E 测试

`setup_project_rules` 生成的 `.claude/rules/godot-mcp.md` 是基础规则（始终可见）。
本指南是核心决策参考，子系统详细指南在 `.claude/rules/godot-mcp-*.md` 中按需加载。

## 模式选择决策树

```
需要操作什么？
├─ .tscn/.gd 文件（静态读写）
│   ├─ 精确编辑 → Headless（edit_script / write_script）
│   └─ 批量创建 → Headless（batch_add_nodes / batch_create_files）
├─ 编辑器中打开的场景（实时）
│   ├─ 编辑器已连接？→ Editor 模式（editor_sync + add_node）
│   └─ 未连接 → Headless（read_scene + add_node + save_scene）
├─ 运行中的游戏（动态状态）
│   ├─ 只读查询 → Bridge（game_query）
│   ├─ 修改状态 → Bridge（game_write）
│   └─ 模拟输入 → Bridge（game_input + game_wait）
└─ 一次性验证
    ├─ 快速检查 → run_and_verify
    ├─ 完整交付 → verify_delivery
    └─ 语法检查 → validate_scripts
```

## 核心工具使用决策

### execute_gdscript — 动态执行

- **片段模式**（默认）：无需 `extends`，代码自动包装为 `extends SceneTree`。用 `_mcp_output(key, value)` 返回结构化结果，用 `_mcp_done()` 结束执行。
- **完整类模式**：手写 `extends SceneTree`，适合需要 `_process()` 或复杂生命周期的场景。
- **load_autoloads=true**：在完整项目环境中运行，可访问 DataRegistry、PlayerData 等全局单例。启动较慢（需加载整个项目），仅在确实需要 Autoload 时开启。
- **注意**：片段模式中 `func`/`var`/`const` 声明自动放在类级别，语句行放在 `_initialize()` 体内。
- **⚠️ 沙箱安全限制（C-04 已知限制）**：GDScript 沙箱扫描基于正则匹配（非语法解析），设计用于防止**意外误操作**，**不可防御恶意/蓄意绕过**。已知绕过向量包括：
  - 字符串拼接：`str("OS")+".cmd()"` 或 `%` 格式化构造危险 API 名
  - 变量间接调用：通过 `call()` / `funcref()` 的非字面量参数绕过静态扫描
  - 注释中包含危险 API 名称会导致误报拦截（安全侧失败）
  - **适用场景**：本地单用户开发环境（信任调用者）。**不适用于多用户/远程/不可信输入场景**——后者需要容器/VM 隔离 + `GODOT_MCP_ALLOW_UNSAFE=false`

### edit_script — 脚本编辑

- **优先使用 search_and_replace**：基于内容匹配，对行号偏移鲁棒，CRLF 安全。
- **行范围模式**（start_line/end_line）：仅在 search_and_replace 无法使用时（如批量重复修改）。
- **indent_mode**：`smart`（推荐）自动对齐缩进；`raw` 仅在确认缩进正确时使用。
- **verify_content**：提供期望内容作为守卫，防止过时的行号编辑。

### dev_loop vs 单独工具

- **dev_loop**：执行 GDScript → 可选验证 → 可选 Bridge 查询/截图 → 可选断言 → 可选状态保存。适合一体化验证流程。
- **单独工具**：execute_gdscript + validate_scripts + run_and_verify 灵活组合。适合多步调试或需要中间检查的场景。

### run_and_verify vs 手动组合

- **run_and_verify**：一键 headless 运行 + 错误分析 + 可选场景树快照。适合快速检查。
- **手动组合**：run_project + get_debug_output + stop_project。适合需要精细控制运行时长的场景。

## 运行时 vs 持久化

部分工具在 headless 进程中创建/修改节点，但**这些变更不持久化到 .tscn 文件**：

- **运行时工具**（不持久化）：signal_connect/disconnect/emit、node_create_3d、physics_raycast、tilemap_*、audio_*、particles_*、ui_*、recording_* 等
- **持久化方法**：使用 add_node（写入 .tscn）+ save_scene 保存。或用 write_script / edit_script 修改 .gd 文件。

> 运行时工具适合验证和测试。若需持久化场景修改，必须使用 add_node + save_scene。

## 2D 项目截图限制

Headless 模式下 2D 场景（CanvasItem 子类，如 ColorRect/TextureRect/\_draw() 内容）的截图可能完全空白。
这是 Godot headless 渲染器的已知限制——headless 进程不初始化渲染服务器，2D CanvasItem 无法渲染到纹理。

**推荐工作流**：
1. 用 `screenshot(action=capture)` 尝试截图
2. 如果返回 `BLANK_DETECTED` 警告，使用以下替代方案：
   - 用户手动截图（F5 运行后截图）
   - `screenshot(action=analyze)` 返回图片的 base64 数据供 AI 视觉分析（需配合 `image_path` 指定本地文件）
   - Bridge `take_screenshot`（如果游戏正在运行，渲染由 GPU 完成）
3. 3D 场景（Node3D/MeshInstance3D 等）不受此限制影响

## 常见陷阱

- **忘记 `_mcp_done()`**：片段模式中如果没有调用 `_mcp_done()`，执行会超时。
- **edit_script 行号偏移**：多步编辑后行号会变化。始终优先使用 search_and_replace。
- **运行时操作误认为持久化**：运行时工具的修改在 headless 进程退出后丢失。
- **load_autoloads 性能开销**：仅在需要 Autoload 单例时开启，否则启动时间增加 3-5 倍。
- **Bridge 密钥过期**：Bridge 密钥有 5 分钟 TTL 缓存，长时间未操作后首次调用可能稍慢。
- **2D 截图空白**：Headless 模式无法渲染 2D CanvasItem，使用 Bridge 或手动截图替代。
- **run_and_verify 可能残留进程**：headless 模式下交互式场景（不自动退出）可能残留 Godot 进程。如果后续 `run_project` 报 "another Godot process is running"，先调用 `stop_project` 清理残留进程。
- **load_autoloads=true 片段模式差异**：`load_autoloads=true` 时片段包装为 `extends Node`（非 `extends SceneTree`），`get_root()` 不可用。需要手写 `extends SceneTree` 完整类模式来访问 SceneTree API。
- **load_autoloads autoload 层级**：`load_autoloads=true` 时 autoload 节点不直接挂在 `get_root()` 下，而是通过 autoload 系统加载。使用 `Engine.get_main_loop().get_root().get_node("autoload/Xxx")` 访问。
- **remove_node 路径格式**：使用 `父名#子名` 格式（如 `Main#ValidationLabel`），而非 `/` 分隔路径。先用 `query_scene_tree` 确认节点名。
- **ui_build_layout 必须传 scene_path**：不传 `scene_path` 会报错 "Failed to load scene"。所有 `ui_build_layout` 调用必须包含 `scene_path` 参数。
- **screenshot analyze 返回格式**：`screenshot(action=analyze)` 返回图片 base64 数据（非文字描述），需配合 `image_path` 参数指定本地 PNG/JPG 文件路径。它不会自动对截图做 AI 文字分析，而是将图片数据返回给调用方做视觉检查。
