# 2026-06-07 MCP 工具使用验证报告

> 使用 `D:\workspace\projects\godot-test-project` 实际项目，按 CLAUDE.md 和 `.claude/rules/godot-mcp-*.md` 中的规则逐项验证工具使用。

## 验证结果总览

| # | 验证项 | 规则文件 | 结果 | 说明 |
|---|--------|---------|------|------|
| 1 | read_scene | core | ✅ 通过 | Headless 读取 .tscn 正常 |
| 2 | execute_gdscript 片段模式 | core | ⚠️ 有偏差 | 基本流程正确，load_autoloads 有差异 |
| 3 | edit_script search_and_replace | core | ✅ 通过 | CRLF 安全、行号鲁棒、auto_validate 正常 |
| 4 | add_node + save_scene 持久化 | core | ⚠️ 有偏差 | 持久化正确，但 remove_node 路径格式文档不清 |
| 5 | ui_build_layout | ui | ⚠️ 有偏差 | 需额外传 scene_path，规则示例未体现 |
| 6 | validate_scripts + run_and_verify | core | ⚠️ 有偏差 | 功能正确但 run_and_verify 导致进程残留 |
| 7 | Bridge 连接流程 | bridge | ❌ 受阻 | 进程管理 bug 阻断验证 |
| 8 | screenshot capture | core | ✅ 通过 | 2D/3D 差异符合文档描述 |

---

## 发现的 Bug 和规则偏差（按严重性排序）

### 🔴 CRITICAL: V-01 run_and_verify 与 run_project 进程状态冲突

**现象：**
- `run_and_verify` 启动的 headless Godot 进程（15s 超时后残留）
- `stop_project` 返回 "No project is currently running"
- `run_project` 报错 "another Godot process is running (started by run_project, running for 68s)"
- 手动杀 OS 进程后状态仍然不同步

**影响：** Bridge 相关验证完全阻断。后续所有 run_project 调用被锁。

**根因推测：** 两个工具使用不同的进程状态跟踪机制：
1. `run_and_verify` 通过 headless executor 启动进程 → 进程注册在 executor 状态中
2. `stop_project` 只检查 runtime 模块的进程状态
3. `run_project` 检查全局 Godot 进程注册表

**违反的规则：** core 规则未提及 `run_and_verify` 可能导致进程残留，也未提供清理指引。

**建议修复：**
1. `run_and_verify` 应确保 headless 进程超时后被清理
2. `stop_project` 应能清理所有类型的残留进程
3. core 规则应补充进程管理注意事项

---

### 🟡 IMPORTANT: V-02 load_autoloads=true 片段模式 get_root() 失败

**现象：**
```
execute_gdscript(code="var x = get_root().get_child_count()", load_autoloads=true)
→ "Function 'get_root()' not found in base self."
```

**影响：** 用户按 core 规则"片段模式自动包装为 extends SceneTree"使用 `get_root()` 会失败。

**违反的规则：** core 规则明确说"片段模式无需 extends，代码自动包装为 extends SceneTree"，但 `load_autoloads=true` 时包装方式不同（使用 `extends Node` + `--scene` loader），`get_root()` 不可用。

**建议修复：** core 规则需补充说明 `load_autoloads=true` 时片段包装行为差异，或修复 `wrapSnippetAsNode` 使 `get_root()` 可用。

---

### 🟡 IMPORTANT: V-03 load_autoloads=true 不直接暴露 autoload 节点

**现象：**
```
execute_gdscript(extends SceneTree, load_autoloads=true)
for child in get_root().get_children():
  → ["autoload"]  // 只有这一个子节点，MCPBridge 不直接可见
```

**影响：** 无法按 Bridge 规则示例直接访问 autoload 单例（如 MCPBridge）。

**建议修复：** 规则文档需说明 autoload 的实际加载层级结构，或提供正确的 autoload 访问方式。

---

### 🟡 IMPORTANT: V-04 remove_node 路径格式文档不明确

**现象：**
```
remove_node(node_path="Main/ValidationLabel")  → "Node not found: /Main/ValidationLabel"
remove_node(node_path="ValidationLabel")        → "Node not found: /ValidationLabel"
remove_node(node_path="Main#ValidationLabel")   → ✅ 成功
```

**影响：** 用户按直觉使用 `/` 分隔路径或裸节点名均失败，需使用 `#` 格式。

**违反的规则：** core 规则中 remove_node 的 `node_path` 参数说明为"节点路径"，但未明确格式规范。

**建议修复：** 在 rules 文件中明确 remove_node 的路径格式为 `父名#子名`。

---

### 🟢 ADVISORY: V-05 ui_build_layout 必须传 scene_path

**现象：**
```
ui_build_layout(parent_path="root", ...)           → "Failed to load scene: <project_path>"
ui_build_layout(parent_path="root", scene_path="scenes/main.tscn", ...) → ✅ 成功
```

**影响：** UI 规则示例代码未传 `scene_path`，用户复制示例会失败。

**违反的规则：** UI 规则的 ui_build_layout 示例未包含 `scene_path` 参数。

**建议修复：** UI 规则所有 ui_build_layout 示例应包含 `scene_path` 参数，并标注为必填。

---

## 符合规则的工具（无偏差）

以下工具完全按照 rules 文件中的描述工作：

| 工具 | 验证内容 |
|------|---------|
| `read_scene` | 返回完整场景树（19节点）、资源、连接 |
| `execute_gdscript`（不含 load_autoloads） | 片段模式包装、`_mcp_output`、`_mcp_done` 均正常 |
| `edit_script` search_and_replace | 内容匹配、CRLF 安全、auto_validate 通过 |
| `add_node` + `save_scene` | 持久化到 .tscn，节点数 19→20 验证通过 |
| `remove_node`（正确路径格式后） | 正确删除节点并保存 |
| `validate_scripts` | 50 脚本验证，0 错误，38 lint 警告 |
| `run_and_verify` | 一键运行 + 错误分析（注意进程残留副作用） |
| `screenshot capture` | 正确保存，3D (73.7KB) vs 2D (8.6KB) 差异与文档一致 |
| `ui_build_layout`（传 scene_path 后） | Flexbox→Container 翻译正确 |
| `node_create_3d` | 运行时创建 Node3D 成功（不持久化，符合规则） |
