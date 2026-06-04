---
description: "editor websocket editor_sync_start editor_sync_stop editor_get_scene_tree launch_editor 编辑器 场景树同步 undo plugin addons godot_mcp_server"
alwaysApply: false
---

> 适用于 godot-mcp-enhanced v0.16.0+

## 概述与架构

Editor 模式通过 WebSocket JSON-RPC 2.0 连接 Godot 编辑器内的 GDScript 插件，实时操作当前打开的场景。

- **插件位置**：`addons/godot_mcp_server/`（需安装在目标项目中）
- **连接机制**：launch_editor 启动编辑器后，服务端自动检测 WebSocket 连接（端口 13100）
- **回退策略**：无编辑器连接时自动回退到 Headless 模式；设置 `GODOT_MCP_NO_FALLBACK=true` 禁止回退

## 工具清单与对比

### Editor 独有工具

| 工具 | 说明 |
|------|------|
| `editor_sync_start` | 启动场景树实时监听，推送 node_added/node_removed 事件 |
| `editor_sync_stop` | 停止场景树监听 |
| `editor_get_scene_tree` | 获取编辑器当前场景树完整快照 |

### 仅 Headless 可用

| 工具 | 原因 |
|------|------|
| `execute_gdscript` | 独立进程执行，不适合编辑器环境 |
| `query_scene_tree` | Headless 专用，用 editor_get_scene_tree 替代 |
| `inspect_node` | Headless 专用 |

### 行为差异

| 工具 | Headless | Editor |
|------|----------|--------|
| `add_node` | 需指定 scene_path，创建后需 save_scene | 操作当前打开场景，实时刷新 |
| `edit_node` | 需指定 scene_path | 操作当前场景中的节点 |
| `remove_node` | 需确认令牌 | 需确认令牌 + 支持 undo |
| 其他工具 | 自动路由到 headless 执行 | 未知工具名自动 forward 到插件 |

## 使用指南

### 连接流程

1. 确认目标项目已安装 `addons/godot_mcp_server/` 插件
2. 调用 `launch_editor(project_path)` 启动编辑器
3. 服务端自动检测 WebSocket 连接（最长等待约 10 秒）
4. 连接成功后，工具调用自动路由到编辑器

### 场景树同步

- `editor_sync_start` 连接 SceneTree 的 node_added/node_removed 信号
- 事件通过 EditorToolExecutor 缓冲（最大 10000 条），超出时丢弃最旧记录
- 编辑器断开重连后，同步自动恢复
- `editor_get_scene_tree` 获取当前快照（不依赖 sync 状态）

## 调用示例

### 启动编辑器并同步场景树

```
// 1. 启动编辑器
launch_editor(project_path="D:/projects/my-game")

// 2. 启动场景树监听
editor_sync_start(project_path="D:/projects/my-game")
// → 返回: { status: "ok", message: "Scene tree sync started" }

// 3. 获取当前场景树
editor_get_scene_tree(project_path="D:/projects/my-game")
// → 返回: { nodes: [...], root: "Node3D", child_count: 15 }
```

### 错误：编辑器未安装插件

```
editor_sync_start(project_path="D:/projects/my-game")
// → 返回: {
//     error: "EDITOR_NOT_CONNECTED",
//     message: "These tools require editor mode with plugin connection.
//               Use headless query_scene_tree as alternative."
//   }
// 解决：在 Godot 编辑器中安装 addons/godot_mcp_server/ 插件并重启编辑器
```

## 常见陷阱

- **插件未安装**：editor_sync 工具返回 EDITOR_NOT_CONNECTED。需要手动安装插件到项目。
- **编辑器启动慢**：大型项目首次启动可能超过 10 秒。可分两步操作：先 launch_editor，等几秒后再 sync。
- **forward 机制**：未明确处理的工具名会自动转发到编辑器插件，可能产生意外行为。
- **断开重连**：编辑器崩溃或关闭后，sync 状态自动清理。需要重新 launch_editor。
- **端口冲突**：默认端口 13100，如果被占用需检查编辑器插件配置。
