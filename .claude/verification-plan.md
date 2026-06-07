# MCP 业务流程验证计划

## 前提
- 重启 Claude Code 会话（使全局 env 生效）
- 验证目标：`D:/workspace/projects/godot-test-project`

## Phase 1: Headless 基础验证

| # | 验证项 | 工具 | 预期结果 |
|---|--------|------|---------|
| 1 | 项目信息读取 | `get_project_info` | 返回 Godot 4.x 项目信息 |
| 2 | 文件列表 | `list_files` | 列出 .gd/.tscn/.tres 文件 |
| 3 | 场景读取 | `read_scene` | 解析 .tscn 文件结构 |
| 4 | GDScript 执行 | `execute_gdscript` | 片段模式返回结果 |
| 5 | 脚本验证 | `validate_scripts` | 语法检查通过 |
| 6 | 运行验证 | `run_and_verify` | headless 运行无错误 |

## Phase 2: 场景操作验证

| # | 验证项 | 工具 | 预期结果 |
|---|--------|------|---------|
| 7 | 创建节点 | `add_node` | 节点添加到场景 |
| 8 | 编辑节点 | `edit_node` | 属性修改成功 |
| 9 | 保存场景 | `save_scene` | .tscn 文件更新 |
| 10 | 查询场景树 | `query_scene_tree` | 返回节点层级 |
| 11 | 检查节点 | `inspect_node` | 返回属性和信号 |

## Phase 3: 脚本操作验证

| # | 验证项 | 工具 | 预期结果 |
|---|--------|------|---------|
| 12 | 读取脚本 | `read_script` | 返回 GDScript 内容 |
| 13 | 编辑脚本 | `edit_script(search_and_replace)` | 替换成功 + 语法校验 |
| 14 | 写入脚本 | `write_script` | 创建新 .gd 文件 |

## Phase 4: 截图 & UI 验证

| # | 验证项 | 工具 | 预期结果 |
|---|--------|------|---------|
| 15 | 截图捕获 | `screenshot(capture)` | PNG 文件生成（可能 2D 空白） |
| 16 | 截图分析 | `screenshot(analyze)` | AI 视觉分析结果 |
| 17 | UI 布局 | `ui_build_layout` | 创建 Container 树 |

## Phase 5: Bridge 模式验证（可选）

| # | 验证项 | 工具 | 前提 |
|---|--------|------|------|
| 18 | Bridge 安装 | `game_bridge_install` | — |
| 19 | 运行项目 | `run_project` | Bridge 已安装 |
| 20 | Ping 测试 | `game_query(ping)` | 游戏运行中 |
| 21 | 场景树查询 | `game_query(get_tree)` | Bridge 连接 |
| 22 | 属性设置 | `game_write(set_node_property)` | Bridge 连接 |
| 23 | UI 发现 | `find_ui_elements` | Bridge 连接 |
| 24 | 属性监控 | `monitor_start/poll/stop` | Bridge 连接 |

## 诊断记录

### 2026-06-06 环境变量问题
- **问题**：MCP 服务器进程未接收到 project-level `env` 配置中的 `ALLOWED_PROJECT_PATHS` 和 `GODOT_MCP_UNRESTRICTED`
- **原因**：MCP 服务器在 env 变量配置之前已启动，进程环境不包含这些变量
- **修复**：已将两个变量添加到全局 `~/.claude/settings.json` 的 `env` 节
- **验证**：需重启 Claude Code 会话
