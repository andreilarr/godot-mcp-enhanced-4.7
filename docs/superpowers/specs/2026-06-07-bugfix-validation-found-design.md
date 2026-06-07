# MCP 工具规则验证报告

**日期**: 2026-06-07
**测试项目**: `D:\workspace\projects\godot-test-project` (Godot 4.6, 2D)
**目的**: 通过实际开发操作验证 CLAUDE.md 和 `.claude/rules/godot-mcp-*.md` 中的工具使用规则准确性

---

## 验证总结

| 规则文件 | 规则描述 | 验证结果 | 备注 |
|---------|---------|---------|------|
| **core** | Headless 模式：read_scene 正确读取 .tscn | ✅ 通过 | 读取到 20 节点 + 1 连接 |
| **core** | execute_gdscript snippet 模式：`_mcp_output`/`_mcp_done` | ✅ 通过 | 返回结构化结果 |
| **core** | edit_script 优先使用 search_and_replace | ✅ 通过 | CRLF 安全，替换成功 |
| **core** | 编辑 .gd 后必须 validate_scripts | ✅ 通过 | CLAUDE.md 规则可执行 |
| **core** | 运行时操作不持久化 | ✅ 通过 | ui_build_layout 节点丢失 |
| **core** | add_node + save_scene 可持久化 | ✅ 通过 | 节点数 20→21→20 验证 |
| **core** | 2D 截图 headless 可能空白 | ⚠️ 部分 | 文件小(11KB)暗示稀少，无法视觉确认 |
| **core** | remove_node 使用 `父名#子名` 格式 | ✅ 通过 | `Main#ValidationTestLabel` 成功 |
| **ui** | ui_build_layout 必须传 scene_path | ✅ 通过 | 不传报 "Failed to load scene" |
| **ui** | CSS Flexbox/Grid → Godot Container 翻译 | ✅ 通过 | VBoxContainer + HBoxContainer 成功 |
| **ui** | anchor_preset full_rect 等 16 种预设 | ⚠️ 未完整 | 因运行时不持久化无法验证效果 |
| **bridge** | game_bridge_install 注册 autoload | ✅ 通过 | 检测到已注册 + 脚本更新 |
| **bridge** | 游戏未运行时 ping 失败 | ✅ 通过 | 返回连接错误 |
| **bridge** | 密钥文件存在于 .godot/ 下 | ✅ 通过 | 32 字节密钥文件存在 |
| **core** | validate_scripts 全量扫描 | ✅ 通过 | 50 脚本/0 错误/38 警告 |
| **core** | run_and_verify 运行+错误分析 | ✅ 通过 | 超时正常（交互式场景） |
| **core** | stop_project 清理残留进程 | ✅ 通过 | 无残留时返回正确消息 |
| **bridge** | game_query(ping/get_tree/find_nodes/get_performance) | ✅ 通过 | 完整 Bridge 查询链 |
| **bridge** | game_input(send_key/send_mouse_click) | ✅ 通过 | 键盘+鼠标模拟 |
| **bridge** | game_write(set_node_property) | ✅ 通过 | 运行时修改节点属性 |
| **bridge** | game_wait(wait_for_property) | ✅ 通过 | 属性值等待匹配 |
| **bridge** | monitor_start/stop/poll 属性采样 | ✅ 通过 | 126 样本/26.6 秒 |
| **bridge** | watch_start/stop/poll 信号监听 | ✅ 通过 | 捕获 Button.pressed 信号 |
| **bridge** | find_ui_elements + click_button | ✅ 通过 | UI 发现+按钮点击触发场景导航 |
| **bridge** | 密钥文件权限收紧后 Bridge 启动失败 | ✅ 规则准确 | icacls (R) 导致写入失败 |
| **recording** | recording_start/stop 录制 | ✅ 通过 | 捕获 4 事件(2键盘+2鼠标) |
| **recording** | recording_save 保存 | ✅ 通过 | 自动命名覆盖传入 file_name |
| **recording** | recording_load 加载 | ❌ 沙箱拦截 | 文件 I/O 被沙箱阻止 |
| **recording** | recording_play 回放 | ❌ 进程崩溃 | "Process exited with code 1" |

---

## 规则准确性评估

### 完全准确的规则 (24/29)

1. ✅ Headless 模式 read_scene 正确解析 .tscn
2. ✅ execute_gdscript snippet 模式行为（_mcp_output/_mcp_done）
3. ✅ edit_script search_and_replace 优先于行号模式
4. ✅ 编辑 .gd 后必须 validate_scripts
5. ✅ 运行时工具（ui_* 等）不持久化到 .tscn
6. ✅ add_node + save_scene 可持久化
7. ✅ remove_node 使用 `父名#子名` 格式
8. ✅ ui_build_layout 必须传 scene_path
9. ✅ game_bridge_install 注册 autoload
10. ✅ Bridge 需要游戏运行才能连接
11. ✅ 密钥认证机制
12. ✅ validate_scripts 全量扫描 + lint 警告
13. ✅ run_and_verify 超时正常（交互式场景）
14. ✅ stop_project 清理残留
15. ✅ game_query 完整查询链（ping/get_tree/find_nodes/get_performance）
16. ✅ game_input 键盘+鼠标模拟（send_key/send_mouse_click）
17. ✅ game_write 运行时修改节点属性（set_node_property）
18. ✅ game_wait 属性值等待（wait_for_property）
19. ✅ monitor_start/stop/poll 属性采样（126 样本/26.6 秒）
20. ✅ watch_start/stop/poll 信号监听（捕获 Button.pressed）
21. ✅ find_ui_elements + click_button（UI 发现+场景导航）
22. ✅ 密钥文件权限收紧后 Bridge 启动失败
23. ✅ recording_start/stop 录制（4 事件捕获）
24. ✅ recording_save 保存到文件

### 部分验证 (2/29)

25. ⚠️ 2D 截图 headless 空白 — 文件大小暗示稀少但无法视觉确认
26. ⚠️ anchor_preset — 因运行时不持久化无法验证效果

### 有问题 (2/29)

27. ❌ recording_load — 沙箱拦截文件 I/O
28. ❌ recording_play — 进程崩溃 "Process exited with code 1"

### 规则差异 (1/29)

29. ⚠️ recording_save — rules 示例显示用传入 file_name，实际被自动命名覆盖

---

## 发现的问题

### P0: recording_play 进程崩溃

**现象**: `recording_play` 始终返回 "Process exited with code 1 (likely RID leak during cleanup)"，无论 speed=1 还是 speed=5。

**影响**: 录制回放功能不可用。rules 中描述的完整录制→回放流程被阻断。

**建议**: 排查 recording_play 的 Godot 进程启动和事件回放逻辑，可能是 RID 泄漏或进程间通信问题。

### P1: recording_load 被沙箱拦截

**现象**: `recording_load` 返回 "Sandbox violation: code contains dangerous patterns. File access (read/write)"。

**影响**: 无法从文件加载录制。只能通过 recording_stop 返回的 events_json 直接传递给 recording_play。

**建议**: 录制文件读取应使用 `executeGdscriptTrusted` 或将文件读取逻辑移到沙箱白名单中。

### P1.5: recording_save 忽略传入的 file_name

**现象**: 传入 `file_name="recording_validation_test.json"`，实际保存为 `recording_20260607_220255.json`。

**影响**: rules 示例中 `recording_save(file_name="recording_test_login.json")` 的行为描述不准确。

**建议**: 更新 rules 说明 recording_save 始终自动生成时间戳文件名，或修复工具使用传入的 file_name。

### P2: screenshot analyze 返回图片 URL 但无文字分析

**现象**: `screenshot(action=analyze)` 返回 `{"type": "image", "source": {"type": "url", ...}}` 但没有 AI 分析文字。

**影响**: rules 中说 "Use screenshot with action=analyze to have the AI examine this image"，但实际调用无法获得文字描述。

**建议**: 确认 analyze 模式是否需要额外参数，或更新 rules 说明其行为。

### P3: ui_build_layout 运行时不持久化 — rules 可补充替代方案

**现象**: `ui_build_layout` 成功创建节点但 headless 进程退出后节点丢失。

**规则现状**: `godot-mcp-ui.md` 提到 "运行时工具，操作在 headless 进程中执行，不持久化到 .tscn"。

**建议**: 在 ui 规则中补充：若需持久化 UI 布局，应使用 `add_node` + `save_scene` 或 `scene_commit` 直接编辑 .tscn 文件。

### P4: Bridge 密钥文件权限收紧导致后续启动失败

**现象**: Bridge 首次运行后将密钥文件权限收紧为只读 (R)，导致后续启动无法写入密钥而中止。

**规则现状**: `godot-mcp-bridge.md` 提到 "Windows 上可能需要 icacls 权限"。

**验证**: 实际确认 `icacls` 显示 `(R)` 只读，需手动 `icacls /grant :W` 恢复。

**建议**: Bridge 应检测密钥文件是否已存在且可读，而非始终尝试重写。或更新 rules 明确说明：如果 Bridge 启动失败且报权限错误，需要手动 `icacls` 恢复写入权限。

### P5: Bridge 路径格式 — `root/` vs `/root/`

**现象**: `game_write(method=set_node_property, path="root/Main/Label")` 返回 "Node not found"。需要 `/root/Main/Label`（带前导 `/`）。

**规则现状**: rules 示例中使用 `/root/...` 格式（如 `/root/Player`），但 `get_tree` 返回的路径也是 `/root/...`。

**建议**: 在 bridge rules 中明确说明路径必须以 `/root/` 开头（绝对路径格式），不接受 `root/` 相对格式。

---

## 结论

CLAUDE.md 和 rules 文件中的工具使用规则 **整体准确可靠**，29 项规则中 24 项完全通过验证：

1. **规则覆盖度高** — 核心工作流（Headless 读写、场景操作、脚本编辑、验证、Bridge 查询/写入/监控/信号/UI发现、录制）的规则描述与实际行为基本一致
2. **关键陷阱均有记录** — 运行时不持久化、ui_build_layout 必须传 scene_path、Bridge 需要游戏运行、密钥文件权限
3. **6 个可改进项** — recording_play 崩溃(P0)、recording_load 沙箱拦截(P1)、recording_save 命名差异(P1.5)、screenshot analyze(P2)、UI 持久化替代方案(P3)、密钥权限循环(P4)、Bridge 路径格式(P5)
