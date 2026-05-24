# godot-mcp-enhanced v0.8.0 功能升级设计

> 日期：2026-05-13
> 状态：终版（整合 3 轮审核意见）
> 前置版本：v0.7.0（90+ 工具，纯 Headless）
> 支持 Godot 版本：4.4+

## 1. 目标

从竞品项目（godot-mcp-pro、6ninelives、godotmcp、bradypp）中筛选并整合经过验证的功能，分三批交付：

- **P1**：架构升级（编辑器插件 + UndoRedo + 心跳 + 只读模式）
- **P2**：工具补充（文档查询 + 测试框架 + 导出管理）
- **P3**：更多工具（粒子系统 + 导航系统 + AnimationTree）

每批独立可用，P1 是架构基础。

## 2. 架构升级：双模式

### 2.1 模式定义

| 模式 | 触发 | 通信 | 状态范围 | UndoRedo |
|------|------|------|---------|----------|
| Headless | 默认 / `GODOT_MCP_MODE=headless` | CLI 调用 `godot --headless --script` | 进程级状态，会话结束后丢失 | 不支持 |
| Editor | `GODOT_MCP_MODE=editor` | WebSocket → Godot 插件 | 编辑器级状态：UndoRedo 历史 + 场景打开状态。**不缓存节点引用**（避免用户手动修改场景后引用失效导致崩溃） | 支持 |

**降级策略**：若用户设置 `GODOT_MCP_MODE=editor` 但未安装编辑器插件，服务器启动时检测 WebSocket 连接失败 → 打印**致命级警告**并自动降级到 Headless 模式，不崩溃。

```
[FALLBACK] Editor mode requested but plugin not found at port 9090.
Running in Headless mode. UndoRedo disabled, no scene state persistence.
To enforce editor mode, set GODOT_MCP_NO_FALLBACK=true.
```

**强制模式**：环境变量 `GODOT_MCP_NO_FALLBACK=true` 时，连接失败不降级，直接报错退出（错误码 1），强制用户先安装插件。适用于 CI/CD 或严格要求 Editor 模式的场景。

Node.js 服务器根据模式选择不同的 `ToolExecutor` 实现。Headless 模式走现有逻辑，Editor 模式通过 WebSocket 发送 JSON-RPC 命令。

### 2.2 编辑器插件结构

```
addons/godot_mcp_server/
├── plugin.cfg              # 插件元数据
├── plugin.gd               # EditorPlugin 入口
├── websocket_server.gd     # WebSocket 服务器
├── command_handler.gd      # JSON-RPC 命令分发
├── undo_manager.gd         # UndoRedo 操作封装
├── heartbeat.gd            # 心跳检测
├── commands/               # 各类命令实现
│   ├── scene_commands.gd
│   ├── node_commands.gd
│   ├── script_commands.gd
│   └── ...
└── ui/
    └── status_panel.tscn   # 编辑器底部状态面板（含日志级别筛选）
```

**多端口分配规则**：

| 策略 | 说明 |
|------|------|
| 范围 | 9090-9094（最多 5 个并发 AI 客户端） |
| 分配 | 第一个客户端用 9090，第二个用 9091，以此类推 |
| 占用检测 | 启动时逐端口尝试 `bind()`，已被占用则递增 |
| 全部占满 | 返回 `{"error": {"code": -32100, "message": "All ports (9090-9094) occupied"}}` |

### 2.3 WebSocket 协议

基于 JSON-RPC 2.0（参考 godot-mcp-pro）：

```json
// 请求
{"jsonrpc": "2.0", "id": 1, "method": "add_node", "params": {"scene": "res://main.tscn", "type": "Sprite2D", "name": "Player"}}

// 成功响应
{"jsonrpc": "2.0", "id": 1, "result": {"node_path": "root/Player", "status": "created"}}

// 错误响应
{"jsonrpc": "2.0", "id": 1, "error": {"code": -32000, "message": "Scene not loaded"}}
```

**错误码规范**：

| 错误码 | 含义 |
|--------|------|
| -32000 | 通用执行错误 |
| -32001 | 只读模式拦截（操作被拒绝） |
| -32002 | 节点/资源不存在 |
| -32003 | 场景未加载 |
| -32004 | 参数校验失败 |
| -32010 | 心跳超时（连接已断开） |
| -32100 | 端口全部占用 |
| -32600 | JSON-RPC 格式错误 |
| -32601 | 方法不存在 |

**会话恢复（双向同步）**：

1. **插件启动时**：主动广播 `{"method": "session_resync", "params": {"open_scenes": [...]}}`（覆盖 Godot 先启动、服务器后启动的场景）
2. **服务器连接时**：发送 `{"method": "request_sync"}`，插件收到后立即补发一次场景树快照（覆盖服务器先连接、插件后启动的场景）
3. 每个新客户端连接时，插件也会发送一次快照

两种时机确保无论谁先启动，服务器都能获取完整的场景状态。

### 2.4 心跳机制

参考 godot-mcp-pro v1.13.1 的实现：

- **Ping 间隔**：5 秒
- **超时阈值**：30 秒无消息 → 判定连接死亡 → 强制关闭 → 自动重连
- **重连策略**：指数退避 1s → 2s → 4s → ... → 60s

**操作执行中的心跳暂停**：

长时间操作（导航烘焙、导出构建、批量操作）可能超过 30 秒。处理策略：

**通用规则**：所有标记为 `long_running: true` 的工具自动触发心跳暂停，无需逐个声明。当前标记的工具：`nav_bake_mesh`、`export_build`、`validate_project`（大型项目）。

1. 操作开始前，Node.js 服务器发送 `{"method": "operation_start", "params": {"timeout": T}}` 延长超时
   - `T` 由工具自行定义默认值（如烘焙 300s，导出 600s），但**上限为 600 秒**，超出截断并打印警告
2. 插件收到后暂停心跳检测，设置新的超时
3. 操作完成后，服务器发送 `{"method": "operation_end"}`
4. 插件恢复正常心跳

**异常保护**：
- 若操作超时仍未完成，按正常心跳超时处理（断开并重连）
- 若 AI 客户端在 `operation_start` 后崩溃断开，插件超时后自动恢复心跳
- 插件 UI 提供"取消当前操作"按钮，点击后发送 `{"method": "operation_cancelled"}` 给服务器，立即恢复心跳

### 2.5 UndoRedo 集成

**粒度策略：按请求合并**。一次 JSON-RPC 请求对应一个 Undo 动作，即使内部包含多步操作。

```gdscript
# 示例：一次请求中添加节点 + 设置属性 + 连接信号
func do_complex_operation(params: Dictionary, request_id: int) -> Dictionary:
    var undo_redo = plugin.get_undo_redo()
    # Action 名称使用 request_id，避免用户输入中的敏感信息出现在 Undo 历史面板
    undo_redo.create_action("MCP: op_%d" % request_id)
    # 所有 do 操作
    undo_redo.add_do_method(self, "_do_add_node", params.scene, params.type, params.name)
    undo_redo.add_do_method(self, "_do_set_property", params.name, "position", params.position)
    undo_redo.add_do_method(self, "_do_connect_signal", params.name, "pressed", params.callback)
    # 所有 undo 操作（逆序）
    undo_redo.add_undo_method(self, "_undo_connect_signal", params.name, "pressed", params.callback)
    undo_redo.add_undo_method(self, "_undo_set_property", params.name, "position")
    undo_redo.add_undo_method(self, "_undo_add_node", params.name)
    undo_redo.commit_action()
    return {"status": "ok"}
```

**Action 命名规范**：使用 `MCP: op_{request_id}` 格式，不使用用户输入的原始字符串。详细操作信息存储在 action 的 metadata 中（调试时可查看），不在编辑器 Undo 历史面板中暴露节点名、信号名等可能的敏感信息。

**节点快照**：删除/修改节点前，存储完整属性快照（类型、属性字典、子节点结构）到 `Dictionary`，确保撤销时能完整恢复。参考 Godot 内置的 `EditorUndoRedoManager` 模式。

Headless 模式下跳过 UndoRedo，直接执行。

### 2.6 只读模式

通过环境变量 `GODOT_MCP_READ_ONLY=true` 启用。

**实现方式：工具标签化**。每个工具在注册时声明 `readonly: boolean` 标签，拦截在 `ToolExecutor` 层统一执行。

只读模式下允许的工具（白名单）：

| 工具类别 | 包含的工具 |
|---------|-----------|
| 项目信息 | `list_projects`, `get_project_info`, `list_files`, `read_project_config`, `get_godot_version` |
| 场景读取 | `read_scene`, `query_scene_tree`, `inspect_node` |
| 脚本读取 | `read_script` |
| 运行/调试 | `run_project`, `stop_project`, `get_debug_output`, `run_and_verify`, `analyze_error`, `run_tests` |
| 验证 | `validate_project`, `validate_scripts`, `batch_validate` |
| 文档 | `get_class_info`, `search_classes`, `find_method`, `get_inheritance`, `godot_docs_*` |
| 运行时查询 | `game_query`, `game_wait`, `physics_body_info`, `diagnose_physics`, `physics_raycast`, `query_spatial` |
| 截图 | `capture_screenshot`, `analyze_screenshot` |
| TileMap 读取 | `tilemap_read`, `tilemap_copy` |
| 音频查询 | `audio_query` |
| 性能 | `profiler` (snapshot/get_data/get_active_processes/get_signal_connections) |
| 空间查询 | `spatial_info` (get_node_info/get_bounds/find_in_aabb) |
| 材质读取 | `material_read` |
| 动画查询 | `animation` (list_players/get_info/get_details/get_keyframes) |

只读模式下拦截的工具（黑名单）—— 所有带修改性质的操作：

| 工具类别 | 包含的工具 |
|---------|-----------|
| 场景修改 | `create_scene`, `add_node`, `edit_node`, `remove_node`, `save_scene`, `batch_add_nodes`, `load_sprite` |
| 脚本修改 | `write_script`, `edit_script` |
| 项目修改 | `create_project`, `launch_editor`, `import_resources`, `project_replace` |
| 运行时修改 | `game_input`, `signal_connect`, `signal_disconnect`, `signal_emit` |
| TileMap 修改 | `tilemap_set_cell`, `tilemap_erase_cell`, `tilemap_fill_rect`, `tilemap_paste`, `tilemap_clear`, `tilemap_set_transform` |
| 音频修改 | `audio_play`, `audio_stop`, `audio_set_param` |
| 碰撞覆盖 | `collision_overlay` |
| 材质修改 | `material_write` |
| 动画修改 | `animation` (play/stop/seek/create/delete/update_props/add_track/remove_track/add_keyframe/remove_keyframe/update_keyframe) |

拦截时返回：`{"error": {"code": -32001, "message": "Operation blocked: read-only mode enabled (GODOT_MCP_READ_ONLY=true)"}}`

### 2.7 命令转发策略

Editor 模式下，现有的 90+ 工具通过 `command_handler.gd` 统一分发到对应的 `commands/*.gd` 实现。**不复用 Headless 模式的 GDScript 文件**——两种模式的实现分离，共享类型定义但执行路径独立。

Headless 模式继续走 `godot --headless --script` 路径，无需修改。

## 3. 工具补充（P2）

### 3.1 Godot 文档查询工具

参考 6ninelives 的 `godot_docs`/`search_docs`/`get_class_docs`。

新增工具：

| 工具名 | 描述 | Headless | Editor |
|--------|------|----------|--------|
| `godot_docs_search` | 搜索 Godot 官方文档 | ✅（需 JSON 存在） | ✅ |
| `godot_docs_class` | 获取指定类的完整文档 | ✅（需 JSON 存在） | ✅ |
| `godot_docs_method` | 获取指定方法的签名和描述 | ✅（需 JSON 存在） | ✅ |

实现方式：
- Headless 模式：内嵌一个精简的类/方法数据库（从 Godot 的 `doc_data` 导出 JSON），离线查询。**JSON 缺失时返回错误**：`{"error": {"code": -32004, "message": "data/godot-classes.json not found. Run 'npx godot-mcp-enhanced generate-docs' first."}}`
- Editor 模式：直接调用 `ClassDB` API（无需 JSON 文件）
- 不依赖外部 Context7 或网络请求

**数据库生成与维护**：

| 项目 | 说明 |
|------|------|
| 生成脚本 | `scripts/generate_doc_db.js`（Node.js），调用 `godot --doctool --headless` 导出类文档，解析为 JSON |
| 存放位置 | `data/godot-classes.json` |
| 更新周期 | 每次发布新版本时手动运行，或通过 GitHub Actions 在 Godot 发布新版本时自动触发 |
| 版本锁定 | JSON 中包含 `godot_version` 字段，启动时与当前引擎版本比对，不匹配时打印警告 |

### 3.2 测试框架

参考 godot-mcp-pro 的测试工具和 6ninelives 的 `bug_fix_loop`。

新增工具：

| 工具名 | 描述 | Headless | Editor | 返回格式 |
|--------|------|----------|--------|---------|
| `test_assert` | 断言检查（节点存在、属性值、信号连接等） | ⚠️ 仅运行时 | ✅ 场景树+运行时 | `{"success": bool, "message": string}` |
| `test_stress` | 压力测试（重复创建/销毁节点，检测内存泄漏） | ⚠️ 仅运行时 | ✅ | `{"success": bool, "iterations": number, "peak_memory": string, "leaked": bool}` |

**模式可用性说明**：
- **Editor 模式**：断言检查编辑器中已打开的场景树（静态结构）和运行中游戏的节点树（动态状态）
- **Headless 模式**：需先 `run_project` 启动项目，再通过 `game_query` 获取运行时节点引用进行断言。无法检查未运行场景的静态结构

**`test_assert` 断言类型**：

| 断言 | 参数 | 示例 |
|------|------|------|
| `node_exists` | `path` | 检查节点是否存在 |
| `property_equals` | `path`, `property`, `expected` | 检查属性值 |
| `signal_connected` | `source`, `signal`, `target`, `method` | 检查信号连接 |
| `node_count` | `parent`, `count` | 检查子节点数量 |

断言失败不影响编辑器运行，仅返回错误信息。

**删除 `auto_fix_loop` 工具**。该功能本质是 AI 客户端的编排逻辑（调用 `run_and_verify` → `analyze_error` → `edit_script` 的循环），不应作为 MCP 工具暴露。改为在 README 中提供"自动修复工作流"的提示词模板，由 AI 客户端实现循环。

### 3.3 导出管理

参考 godot-mcp-pro 的导出工具。

新增工具：

| 工具名 | 描述 | Headless | Editor | 只读模式下 |
|--------|------|----------|--------|----------|
| `export_list_presets` | 列出项目中的导出预设 | ❌ | ✅ | 允许 |
| `export_get_preset` | 获取指定预设的详细配置 | ❌ | ✅ | 允许（脱敏） |
| `export_build` | 执行导出构建 | ❌ | ✅ | **拦截** |

`export_build` 标记为 `long_running: true`，自动触发心跳暂停（见 2.4 节）。默认超时按构建目标动态估算：Windows/macOS 桌面 300s，Android 600s。

**敏感路径脱敏**：`export_get_preset` 返回结果中，以下字段自动替换为 `"***"`：
- Android keystore 路径（`keystore/release`）
- macOS 签名证书路径（`codesign/identity`）
- iOS 证书/描述文件路径
- 自定义环境变量中的密钥

### 3.4 install 命令

`package.json` 中新增 `install` 命令，将编辑器插件复制到用户项目的 `addons/` 目录。

**行为**：

```bash
# 项目级安装（默认）
npx godot-mcp-enhanced install --project /path/to/godot/project

# 验证安装是否成功
npx godot-mcp-enhanced install --verify --project /path/to/godot/project
```

`--verify` 检查 `addons/godot_mcp_server/plugin.cfg` 是否存在且格式正确。

**不使用全局安装**——Godot 插件必须放在项目目录内才能被加载。安装失败时（路径含空格/权限不足）提供明确的错误信息和手动安装指引。

## 4. 更多工具（P3）

### 4.1 粒子系统

参考 godot-mcp-pro 的粒子工具。

新增工具（5 个）：

| 工具名 | 描述 |
|--------|------|
| `particles_create` | 创建 GPUParticles2D/3D 节点 |
| `particles_set_emission` | 设置发射参数（数量、方向、形状） |
| `particles_set_process` | 设置处理参数（速度、重力、阻尼） |
| `particles_load_preset` | 加载预设效果（火焰、烟雾、雨等）—— **纯参数配置**，不包含资源引用 |
| `particles_set_material` | 设置粒子材质 |

**预设为纯参数**：`particles_load_preset` 只设置数值参数（emission_rate、gravity、spread 等），不引用外部纹理或材质。需要自定义材质时，用户通过 `particles_set_material` 手动指定。

### 4.2 导航系统

新增工具（6 个）：

| 工具名 | 描述 |
|--------|------|
| `nav_create_region` | 创建 NavigationRegion3D |
| `nav_bake_mesh` | 烘焙导航网格（**同步操作，触发心跳暂停**） |
| `nav_create_agent` | 创建 NavigationAgent3D |
| `nav_set_params` | 设置导航参数（避障、路径优化等） |
| `nav_query_path` | 查询导航路径。当前 v0.7.0 已有此工具，P3 增强：新增 `collision_mask`、`custom_costs`、`map_data` 参数 |
| `nav_create_link` | 创建 NavigationLink3D（跳跃点/传送点） |

**`nav_bake_mesh` 注意事项**：
- 烘焙是 CPU 密集型同步操作，可能耗时超过心跳超时
- 执行前自动发送 `operation_start` 延长超时（见 2.4 节）
- 烘焙期间编辑器 UI 会冻结，状态面板显示"正在烘焙..."

### 4.3 AnimationTree

参考 godot-mcp-pro 的 AnimationTree 工具。

新增工具（5 个）：

| 工具名 | 描述 |
|--------|------|
| `animtree_create` | 创建 AnimationTree 节点并绑定 AnimationPlayer |
| `animtree_add_state` | 添加状态机状态 |
| `animtree_add_transition` | 添加状态转换（含条件） |
| `animtree_set_blend` | 设置混合树参数 |
| `animtree_play` | 切换到指定状态 |

## 5. 工具数量预估

| 批次 | 新增工具 | 明细 | 总工具数 |
|------|---------|------|---------|
| P0（当前 v0.7.0） | - | - | ~90 |
| P1（架构升级） | 0 | 不新增工具，UndoRedo 增强现有工具 | ~90 |
| P2（工具补充） | +8 | 文档 3 + 测试 2 + 导出 3 | ~98 |
| P3（更多工具） | +16 | 粒子 5 + 导航 6 + AnimationTree 5 | ~114 |

注：P2 相比初版减少 1（删除 `auto_fix_loop`），P3 粒子 5 + 导航 6 + AnimationTree 5 = 16。

## 6. 文件变更预估

### P1（架构升级）

| 变更类型 | 文件 |
|---------|------|
| 新增 | `addons/godot_mcp_server/` 整个插件目录（~10 个 GDScript 文件） |
| 新增 | `src/core/EditorConnection.ts` — WebSocket 客户端 + 重连逻辑 |
| 新增 | `src/core/EditorToolExecutor.ts` — 编辑器模式工具执行器 |
| 新增 | `src/core/ReadOnlyGuard.ts` — 只读模式拦截器（基于工具标签） |
| 修改 | `src/core/GodotExecutor.ts` — 增加模式判断 + 降级逻辑 |
| 修改 | `src/server.ts` — 增加模式初始化 |
| 修改 | `src/tools/*.ts` — 每个工具增加 `readonly` 标签 |
| 修改 | `package.json` — 增加 `install` / `generate-docs` 命令 |

### P2（工具补充）

| 变更类型 | 文件 |
|---------|------|
| 新增 | `src/tools/docs.ts` — 文档查询工具（3 个） |
| 新增 | `src/tools/testing.ts` — 测试框架工具（2 个） |
| 新增 | `src/tools/export.ts` — 导出管理工具（3 个） |
| 新增 | `scripts/generate_doc_db.js` — 文档数据库生成脚本 |
| 新增 | `data/godot-classes.json` — Godot 类/方法数据库 |
| 新增 | `addons/godot_mcp_server/commands/test_commands.gd` |
| 新增 | `addons/godot_mcp_server/commands/export_commands.gd` |

### P3（更多工具）

| 变更类型 | 文件 |
|---------|------|
| 新增 | `src/tools/particles.ts` |
| 新增 | `src/tools/navigation.ts` |
| 新增 | `src/tools/animtree.ts` |
| 新增 | `addons/godot_mcp_server/commands/particle_commands.gd` |
| 新增 | `addons/godot_mcp_server/commands/nav_commands.gd` |
| 新增 | `addons/godot_mcp_server/commands/animtree_commands.gd` |

## 7. 交付顺序和依赖关系

```
P1（架构基础）
├── 编辑器插件框架
├── WebSocket 通信层 + 会话恢复
├── UndoRedo 集成（按请求粒度合并）
├── 心跳 + 自动重连 + 操作执行中暂停
├── 只读模式（工具标签化）
├── install 命令
└── 降级策略（editor → headless）
    ↓
P2（工具补充 — 部分依赖 P1 的编辑器模式）
├── 文档查询（Headless + Editor 双模式）
├── 测试框架（Editor 模式下更完整）
├── 导出管理（需要 Editor 模式）
└── generate-docs 脚本
    ↓
P3（更多工具 — 依赖 P1 的编辑器模式）
├── 粒子系统
├── 导航系统（含烘焙心跳暂停）
└── AnimationTree
```

## 8. 不纳入的功能（及原因）

| 功能 | 来源 | 不纳入原因 |
|------|------|-----------|
| 语义搜索 | 6ninelives | 依赖 @xenova/transformers，体积大、启动慢，YAGNI |
| 交互式可视化器 | godotmcp | 需要额外 HTTP 服务 + 前端，复杂度高，非核心 |
| Android 部署 | pro | 用户群太小 |
| 零配置安装 | 6ninelives | 当前手动安装足够简单 |
| MeshLibrary 导出 | bradypp | 使用场景窄 |
| UID 管理 | bradypp | 可后续补，不影响核心 |
| 多模式（按工具数限制） | pro | 当前工具数未超过主流客户端限制 |
| auto_fix_loop | 6ninelives | 本质是 AI 客户端编排逻辑，不应作为 MCP 工具暴露 |

## 9. 测试策略

| 测试类型 | 覆盖范围 | 实现方式 |
|---------|---------|---------|
| 单元测试 | ReadOnlyGuard、端口分配、错误码、参数校验 | Jest，mock WebSocket |
| 集成测试 | Headless 模式现有工具 | 继续使用 Godot headless |
| 编辑器模式测试 | WebSocket 通信、UndoRedo、心跳 | `tests/editor_mode.test.ts`，mock WebSocket server |
| 端到端测试 | 完整工作流 | 手动测试（CI 中 Godot 编辑器模式不可用） |

## 附录 A：竞品版本快照

| 项目 | 版本/日期 | 工具数 | 架构 | 亮点 |
|------|----------|--------|------|------|
| godot-mcp-pro | v1.13.1 (2026-05-12) | 172 | WebSocket + Editor Plugin | 心跳检测、UndoRedo、多模式 |
| 6ninelives-godot-mcp | 2026-05-13 拉取 | 88 | WebSocket + Editor Plugin | 语义搜索、零配置、文档查询 |
| godotmcp (tomyud1) | 2026-05-13 拉取 | 42 | WebSocket + Editor Plugin | 交互式可视化器、Proxy 模式 |
| bradypp-godot-mcp | 2026-05-13 拉取 | 13 | Headless CLI | 只读模式、UID 管理 |
| godot-mcp (coding-solo) | 2026-05-13 拉取 | 12 | Headless CLI | MeshLibrary 导出 |
| **godot-mcp-enhanced (本项目)** | **v0.7.0** | **~90** | **Headless CLI** | **物理调试、TileMap、材质、验证** |

## 附录 B：审核意见响应矩阵

| # | 审核问题 | 处理方式 | 文档位置 |
|---|---------|---------|---------|
| 1 | 双模式状态管理歧义 | 明确"进程级状态"和"不缓存节点引用" | 2.1 |
| 2 | WebSocket 端口硬编码 | 增加端口分配规则和占满报错 | 2.2 |
| 3 | 心跳与长操作冲突 | 增加 operation_start/operation_end 暂停机制 | 2.4 |
| 4 | UndoRedo 粒度 | 明确按请求粒度合并 + 节点快照 | 2.5 |
| 5 | 只读模式拦截边界 | 工具标签化 + 完整白名单/黑名单 | 2.6 |
| 6 | 文档数据库维护成本 | 增加生成脚本和更新周期 | 3.1 |
| 7 | auto_fix_loop 无限循环 | 删除该工具，改为 README 提示词模板 | 3.2 |
| 8 | 导出管理权限/脱敏 | 只读模式下自动脱敏敏感路径 | 3.3 |
| 9 | 粒子预设维护 | 明确纯参数配置，不引用外部资源 | 4.1 |
| 10 | 导航烘焙与心跳 | 标记为同步操作，触发心跳暂停 | 4.2 |
| 11 | P3 工具数量 | 核对为 16（5+6+5），修正明细 | 5 |
| 12 | install 命令职责 | 明确项目级安装 + 验证命令 | 3.4 |
| 13 | 竞品版本快照 | 新增附录 A | 附录 A |
| - | 会话恢复策略 | 插件启动时广播场景树快照 | 2.3 |
| - | 降级策略 | editor 连接失败自动降级 headless | 2.1 |
| - | 错误码规范 | 新增完整错误码表 | 2.3 |
| - | 命令转发策略 | Editor/Headless 实现分离 | 2.7 |
| - | test_assert 返回格式 | 明确返回格式 | 3.2 |
| - | 测试策略 | 新增完整测试策略章节 | 9 |

### 第三轮审核补充（8 项）

| # | 审核问题 | 处理方式 | 文档位置 |
|---|---------|---------|---------|
| 14 | 降级策略用户知情权不足 | 降级时打印致命级 `[FALLBACK]` 警告；增加 `NO_FALLBACK` 强制模式 | 2.1 |
| 15 | `export_build` 未纳入心跳暂停 | 增加 `long_running: true` 通用标签机制，`export_build` 自动触发心跳暂停 | 2.4 / 3.3 |
| 16 | 会话恢复时机盲区 | 增加双向同步：服务器连接后发 `request_sync`，新客户端连接时也发快照 | 2.3 |
| 17 | 竞品名称拼写错误 | `6ninelines` → `6ninelives` | 附录 A |
| 18 | `test_assert` Headless 可行性 | 增加模式可用性标签：Headless 仅运行时，Editor 场景树+运行时 | 3.2 |
| 19 | P2 工具模式可用性矩阵 | 每个新增工具标注 ✅/⚠️/❌ Headless/Editor | 3.1 / 3.2 / 3.3 |
| 20 | `operation_start` 安全边界 | `timeout` 上限 600s；插件 UI 增加取消按钮；AI 崩溃后自动恢复 | 2.4 |
| 21 | UndoRedo Action 名称暴露敏感信息 | 命名使用 `MCP: op_{request_id}`，详情存 metadata | 2.5 |
