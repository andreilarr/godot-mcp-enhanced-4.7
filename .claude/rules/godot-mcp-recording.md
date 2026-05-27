---
description: "recording recording_start recording_stop recording_save recording_load recording_play 录制 回放 输入事件 bridge E2E 测试 regression 操作复现 输入捕获 事件重放"
alwaysApply: false
---

> 适用于 godot-mcp-enhanced v0.14.0+

## 概述与架构

录制系统捕获用户输入事件（键盘/鼠标），序列化为 JSON，可在后续回放。

- **依赖**：Game Bridge 必须已连接（输入事件通过 Bridge 发送和捕获）
- **存储位置**：`res://recordings/recording_*.json`（项目内）
- **使用场景**：E2E 测试用例录制、回归测试、Bug 复现、操作自动化

## 工具清单

| 工具 | 说明 | 前提 |
|------|------|------|
| `recording_start` | 开始捕获输入事件 | Bridge 已连接 |
| `recording_stop` | 停止捕获，返回事件 JSON | 录制进行中 |
| `recording_save` | 保存到 res://recordings/ | events_json 参数 |
| `recording_load` | 从文件加载录制 | 文件名匹配 recording_*.json |
| `recording_play` | 回放录制的输入事件 | Bridge 已连接 + events_json |

## 使用指南

### 完整流程

```
1. game_bridge_install → 安装 Bridge（一次性）
2. run_project → 启动游戏
3. game_query(method="ping") → 确认 Bridge 连接
4. recording_start → 开始录制
5. [用户操作 / game_input 模拟输入]
6. recording_stop → 停止录制，获取 events_json
7. recording_save(file_name) → 保存到文件
--- 后续使用 ---
8. recording_load(file_name) → 加载录制
9. recording_play(events_json, speed=1.0) → 回放
```

### 事件格式

```json
{
  "version": 1,
  "duration_ms": 5420,
  "events": [
    { "type": "key", "keycode": 87, "pressed": true, "timestamp_ms": 120 },
    { "type": "mouse_click", "x": 640, "y": 360, "button": 1, "pressed": true, "timestamp_ms": 2300 },
    { "type": "key", "keycode": 87, "pressed": false, "timestamp_ms": 4100 }
  ]
}
```

### 文件命名与安全

- **自动命名**：`recording_YYYYMMDD_HHmmss.json`（如 `recording_20260527_143022.json`）
- **强制格式**：文件名必须匹配 `recording_*.json`，否则报 `INVALID_FILE_NAME`
- **路径遍历防护**：文件名禁止包含 `/`、`\`、`..`

## 调用示例

### 完整录制→保存→加载→回放

```
// 1. 开始录制
recording_start(project_path="D:/game")
// → { status: "ok", message: "Recording started" }

// 2. [模拟玩家操作]
game_input(method="send_key", params={ "key": "Key_W", "pressed": true })
game_input(method="send_mouse_click", params={ "x": 320, "y": 240, "button": "left", "pressed": true })

// 3. 停止录制
recording_stop(project_path="D:/game")
// → { events_json: "{\"version\":1,\"duration_ms\":1200,\"events\":[...]}" }

// 4. 保存到文件
recording_save(project_path="D:/game", file_name="recording_test_login.json", events_json="<从 stop 获取>")
// → { status: "ok", path: "res://recordings/recording_test_login.json" }

// 5. 后续加载并回放
recording_load(project_path="D:/game", file_name="recording_test_login.json")
// → { events_json: "..." }

recording_play(project_path="D:/game", events_json="<从 load 获取>", speed=1.0)
// → { status: "ok", events_played: 5 }
```

### 与 game_wait 结合的 E2E 测试

```
// 录制一次操作，后续自动回放 + 验证
recording_load(project_path="D:/game", file_name="recording_open_menu.json")
recording_play(project_path="D:/game", events_json="<loaded>", speed=2.0)
game_wait(method="wait_for_node", params={ "path": "root/CanvasLayer/OptionsMenu" })
game_query(method="get_node_properties", params={ "path": "root/CanvasLayer/OptionsMenu", "properties": ["visible"] })
// → { visible: true } — 测试通过
```

### 错误：Bridge 未连接

```
recording_start(project_path="D:/game")
// → { error: "BRIDGE_NOT_CONNECTED", message: "Recording requires an active game bridge connection" }
// 解决：1. 确认已 game_bridge_install
//       2. 确认游戏正在运行（F5）
//       3. 确认 game_query(method="ping") 返回成功
```

## 常见陷阱

- **Bridge 是硬依赖**：recording_start/recording_play 都需要 Bridge 连接。没有 Bridge 则无法录制或回放。
- **文件名格式严格**：`recording_test.json`（❌ 不匹配）、`recording_test_login.json`（✅ 匹配）。必须以 `recording_` 开头、`.json` 结尾。
- **回放时序**：speed > 1.0 会加速回放，但可能因游戏帧率跟不上导致事件丢失。建议 E2E 测试使用 speed=1.0。
- **录制文件存储在项目内**：`res://recordings/` 下的文件会随项目版本控制。敏感录制应在 .gitignore 中排除。
- **事件类型有限**：仅捕获键盘（key）和鼠标（mouse_click）事件。触摸、手柄等不适用。
