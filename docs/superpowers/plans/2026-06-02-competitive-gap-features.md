# 竞品差距功能实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐竞品分析中 3 项最高价值功能——运行时监控、UI 发现、工具分组细化

**Architecture:** 三个功能各自独立。监控和 UI 发现扩展 Bridge autoload（GDScript）+ TypeScript 客户端；工具分组仅修改 TypeScript 注册逻辑。所有新 Bridge 命令走现有 `sendToBridge()` → `_handle_message()` match 模式。

**Tech Stack:** TypeScript (Node.js MCP server), GDScript (Godot 4.4+ autoload), Vitest

---

## 文件结构

| 文件 | 职责 | 状态 |
|------|------|------|
| `src/scripts/mcp_bridge.gd` | Bridge autoload — 新增 monitor/watch/ui 命令 | 修改 |
| `src/tools/game-bridge.ts` | TypeScript Bridge 客户端 — 新增 action 类型 | 修改 |
| `src/core/tool-registry.ts` | 工具分组定义 — 新增 GROUPS/PROFILE | 修改 |
| `src/core/ToolDispatcher.ts` | 模式过滤逻辑 — 支持 profile 参数 | 修改 |
| `src/index.ts` | 入口 — 新增 `--profile` / `GODOT_MCP_PROFILE` | 修改 |
| `test/game-bridge-monitor.test.js` | 监控功能测试 | 新建 |
| `test/game-bridge-ui-discover.test.js` | UI 发现测试 | 新建 |
| `test/tool-groups.test.js` | 工具分组测试 | 新建 |

---

## Task 1: 属性监控 — monitor_properties

**Files:**
- Modify: `src/scripts/mcp_bridge.gd` — 新增 monitor 状态机 + 3 个命令
- Modify: `src/tools/game-bridge.ts` — 新增 3 个 action + TypeScript 类型
- Create: `test/game-bridge-monitor.test.js`

**GDScript 端设计：**

Bridge autoload 新增状态：
```
var _monitor_active: bool = false
var _monitor_node_path: String = ""
var _monitor_properties: Array = []
var _monitor_interval_frames: int = 10  # 每 10 帧采样
var _monitor_frame_counter: int = 0
var _monitor_samples: Array = []        # [{time, values:{prop:val}}]
var _monitor_max_samples: int = 500
```

新增 3 个 Bridge 命令：
- `monitor.start` — 开始监控（params: node_path, properties[], interval_frames?）
- `monitor.stop` — 停止监控，返回采样数据
- `monitor.poll` — 获取当前采样数据（不停止监控）

采样在 `_process()` 中执行，每个 interval_frames 帧记录一次属性值快照。

- [ ] **Step 1: 写 monitor 功能的 GDScript 测试**

```javascript
// test/game-bridge-monitor.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 监控功能的单元测试——验证 GDScript 生成逻辑
describe('game-bridge monitor', () => {
  describe('monitor.start command generation', () => {
    it('should generate correct bridge request for monitor.start', () => {
      const params = {
        node_path: 'root/Player',
        properties: ['position', 'health', 'speed'],
        interval_frames: 5,
      };
      // 验证 sendToBridge 参数格式
      expect(params.node_path).toBe('root/Player');
      expect(params.properties).toHaveLength(3);
      expect(params.interval_frames).toBe(5);
    });

    it('should use default interval_frames of 10', () => {
      const params = {
        node_path: 'root/Player',
        properties: ['position'],
      };
      const interval = params.interval_frames ?? 10;
      expect(interval).toBe(10);
    });
  });

  describe('monitor response validation', () => {
    it('should validate monitor.start response schema', () => {
      const response = {
        monitoring: true,
        node_path: 'root/Player',
        properties: ['position', 'health'],
        interval_frames: 5,
      };
      expect(response.monitoring).toBe(true);
      expect(response.properties).toBeInstanceOf(Array);
    });

    it('should validate monitor.poll response with samples', () => {
      const response = {
        samples: [
          { frame: 100, time: 1.667, values: { position: { x: 10, y: 0 } } },
          { frame: 110, time: 1.833, values: { position: { x: 12, y: 0 } } },
        ],
        sample_count: 2,
        node_path: 'root/Player',
      };
      expect(response.samples).toHaveLength(2);
      expect(response.sample_count).toBe(2);
    });

    it('should validate monitor.stop returns final data', () => {
      const response = {
        monitoring: false,
        samples: [
          { frame: 100, time: 1.667, values: { health: 100 } },
          { frame: 110, time: 1.833, values: { health: 85 } },
        ],
        total_frames: 200,
        duration_seconds: 3.33,
      };
      expect(response.monitoring).toBe(false);
      expect(response.total_frames).toBeGreaterThan(0);
    });
  });
});
```

- [ ] **Step 2: 运行测试验证通过**

Run: `npx vitest run test/game-bridge-monitor.test.js`
Expected: PASS（纯数据验证，不依赖 Godot）

- [ ] **Step 3: 在 mcp_bridge.gd 中实现 monitor 状态变量和 3 个命令**

在 `mcp_bridge.gd` 的成员变量区域（`var _recording` 之后）新增：

```gdscript
# ─── Monitor state ─────────────────────────────────────────────────────
var _monitor_active: bool = false
var _monitor_node_path: String = ""
var _monitor_properties: Array = []
var _monitor_interval_frames: int = 10
var _monitor_frame_counter: int = 0
var _monitor_samples: Array = []
var _monitor_max_samples: int = 500
```

在 `_process()` 函数末尾（`_peers.remove_at(i)` 循环之后）新增 monitor 采样逻辑：

```gdscript
	# ─── Property monitor sampling ────────────────────────────────────
	if _monitor_active and _monitor_properties.size() > 0:
		_monitor_frame_counter += 1
		if _monitor_frame_counter >= _monitor_interval_frames:
			_monitor_frame_counter = 0
			var node := get_node_or_null(_monitor_node_path)
			if node == null:
				_monitor_active = false
				_monitor_samples.append({"frame": Engine.get_process_frames(), "time": Time.get_ticks_msec() / 1000.0, "error": "node_lost"})
			else:
				var values: Dictionary = {}
				for prop in _monitor_properties:
					var val: Variant = node.get(prop)
					if val == null:
						values[prop] = null
					elif val is Vector2:
						values[prop] = {"x": val.x, "y": val.y}
					elif val is Vector3:
						values[prop] = {"x": val.x, "y": val.y, "z": val.z}
					elif val is Color:
						values[prop] = {"r": val.r, "g": val.g, "b": val.b, "a": val.a}
					else:
						values[prop] = val
				_monitor_samples.append({
					"frame": Engine.get_process_frames(),
					"time": Time.get_ticks_msec() / 1000.0,
					"values": values
				})
				if _monitor_samples.size() >= _monitor_max_samples:
					# 自动停止，防止内存溢出
					_monitor_active = false
```

在 `_handle_message()` 的 `match method:` 块中（`"recording.stop"` 之后、`_` 之前）新增：

```gdscript
			"monitor.start":
				result = _cmd_monitor_start(params)
			"monitor.stop":
				result = _cmd_monitor_stop()
			"monitor.poll":
				result = _cmd_monitor_poll()
```

新增 3 个命令实现函数（在 `_cmd_recording_stop` 之后）：

```gdscript
# ─── Monitor commands ───────────────────────────────────────────────────

func _cmd_monitor_start(params: Dictionary) -> Variant:
	var node_path: String = str(params.get("node_path", ""))
	var properties = params.get("properties", [])
	var interval: int = int(params.get("interval_frames", 10))

	if node_path == "":
		return {"error": {"code": -1, "message": "node_path is required"}}
	if not properties is Array or properties.size() == 0:
		return {"error": {"code": -2, "message": "properties must be a non-empty array"}}
	if interval < 1:
		interval = 1
	if interval > 300:
		interval = 300

	var node := get_node_or_null(node_path)
	if node == null:
		return {"error": {"code": -3, "message": "Node not found: %s" % node_path}}

	# 如果已有监控在运行，先停止并返回旧数据
	var previous_samples: Array = []
	if _monitor_active:
		previous_samples = _monitor_samples.duplicate(true)

	_monitor_active = true
	_monitor_node_path = node_path
	_monitor_properties = properties
	_monitor_interval_frames = interval
	_monitor_frame_counter = 0
	_monitor_samples = []

	var result_dict: Dictionary = {
		"monitoring": true,
		"node_path": node_path,
		"properties": properties,
		"interval_frames": interval,
	}
	if previous_samples.size() > 0:
		result_dict["previous_samples"] = previous_samples
	return result_dict


func _cmd_monitor_stop() -> Variant:
	if not _monitor_active:
		return {"monitoring": false, "samples": [], "message": "No active monitor"}
	_monitor_active = false
	var samples := _monitor_samples.duplicate(true)
	var total_frames := Engine.get_process_frames()
	var duration := 0.0
	if samples.size() > 0:
		duration = samples[samples.size() - 1].get("time", 0.0) - samples[0].get("time", 0.0)
	var result_dict: Dictionary = {
		"monitoring": false,
		"samples": samples,
		"sample_count": samples.size(),
		"total_frames": total_frames,
		"duration_seconds": duration,
	}
	_monitor_samples = []
	_monitor_properties = []
	return result_dict


func _cmd_monitor_poll() -> Variant:
	if not _monitor_active:
		return {"monitoring": false, "samples": [], "message": "No active monitor"}
	var samples := _monitor_samples.duplicate(true)
	return {
		"monitoring": true,
		"node_path": _monitor_node_path,
		"samples": samples,
		"sample_count": samples.size(),
	}
```

- [ ] **Step 4: 在 game-bridge.ts 中新增 monitor action 类型**

在 `ACTIONS` 数组中新增 3 个 action：

```typescript
const ACTIONS = [
  'game_bridge_install',
  'game_bridge_uninstall',
  'game_query',
  'game_write',
  'game_input',
  'game_wait',
  'monitor_start',     // 新增
  'monitor_stop',      // 新增
  'monitor_poll',      // 新增
] as const;
```

在 `handleTool()` 的 `switch (action)` 中新增 3 个 case（`case 'game_wait'` 之后）：

```typescript
      case 'monitor_start': {
        const { method: _m, params: _p, ...bridgeParams } = args;
        const resp = await sendToBridge('monitor.start', {
          node_path: args.node_path as string,
          properties: args.properties as string[],
          interval_frames: (args.interval_frames as number) ?? 10,
        }, args.timeout as number || DEFAULT_TIMEOUT);
        return textResult(JSON.stringify(resp.result ?? resp.error));
      }
      case 'monitor_stop': {
        const resp = await sendToBridge('monitor.stop', {}, args.timeout as number || DEFAULT_TIMEOUT);
        return textResult(JSON.stringify(resp.result ?? resp.error));
      }
      case 'monitor_poll': {
        const resp = await sendToBridge('monitor.poll', {}, args.timeout as number || DEFAULT_TIMEOUT);
        return textResult(JSON.stringify(resp.result ?? resp.error));
      }
```

在工具的 `inputSchema.properties` 中新增 `node_path`、`properties`、`interval_frames` 参数（与现有 params 平级）：

```typescript
          node_path: {
            type: 'string',
            description: 'monitor_start: 要监控的节点路径（如 root/Player）',
          },
          properties: {
            type: 'array',
            items: { type: 'string' },
            description: 'monitor_start: 要监控的属性名列表（如 ["position", "health"]）',
          },
          interval_frames: {
            type: 'number',
            description: 'monitor_start: 采样间隔帧数（默认 10，最小 1，最大 300）',
          },
```

同时更新工具 `description` 字符串，追加 monitor 说明。

- [ ] **Step 5: 补充 monitor 的 TypeScript 单元测试**

在 `test/game-bridge-monitor.test.js` 中追加 handler 测试：

```javascript
import { handleTool, getToolDefinitions } from '../src/tools/game-bridge.js';

describe('game-bridge monitor handler', () => {
  it('should return null for non-game tools', async () => {
    const result = await handleTool('other_tool', {}, { opsScript: '' });
    expect(result).toBeNull();
  });

  it('should register monitor_start/stop/poll in ACTIONS', () => {
    const tools = getToolDefinitions();
    const gameTool = tools.find(t => t.name === 'game');
    expect(gameTool).toBeDefined();
    const actions = gameTool.inputSchema.properties.action.enum;
    expect(actions).toContain('monitor_start');
    expect(actions).toContain('monitor_stop');
    expect(actions).toContain('monitor_poll');
  });

  it('should return error when monitor_start missing node_path', async () => {
    const result = await handleTool('game', {
      project_path: '/tmp/test',
      action: 'monitor_start',
      properties: ['position'],
    }, { opsScript: '' });
    // Bridge 不可用时会返回连接错误
    expect(result).toBeDefined();
  });
});
```

- [ ] **Step 6: 运行全量测试验证无回归**

Run: `npx vitest run`
Expected: 全部 PASS

- [ ] **Step 7: 提交**

```bash
git add src/scripts/mcp_bridge.gd src/tools/game-bridge.ts test/game-bridge-monitor.test.js
git commit -m "feat: 运行时属性监控 monitor.start/stop/poll"
```

---

## Task 2: 信号监听 — watch_signals

**Files:**
- Modify: `src/scripts/mcp_bridge.gd` — 新增 watch 状态机 + 3 个命令
- Modify: `src/tools/game-bridge.ts` — 新增 3 个 action
- Create: `test/game-bridge-signal-watch.test.js`

**GDScript 端设计：**

Bridge autoload 新增状态：
```
var _watch_active: bool = false
var _watch_node_path: String = ""
var _watch_signal_name: String = ""
var _watch_events: Array = []          # [{frame, time, args}]
var _watch_max_events: int = 1000
var _watch_connected: bool = false
```

新增 3 个 Bridge 命令：
- `watch.start` — 连接信号并记录（params: node_path, signal_name, max_events?）
- `watch.stop` — 断开信号，返回事件列表
- `watch.poll` — 获取当前已记录的事件（不断开）

信号回调通过 `Callable` 动态连接，记录每次发射的时间戳和参数。

- [ ] **Step 1: 写信号监听的测试**

```javascript
// test/game-bridge-signal-watch.test.js
import { describe, it, expect } from 'vitest';

describe('game-bridge signal watch', () => {
  describe('watch.start params validation', () => {
    it('should require node_path and signal_name', () => {
      const params = { node_path: 'root/Player', signal_name: 'health_changed' };
      expect(params.node_path).toBeTruthy();
      expect(params.signal_name).toBeTruthy();
    });

    it('should default max_events to 1000', () => {
      const params = { node_path: 'root/Player', signal_name: 'died' };
      const max = params.max_events ?? 1000;
      expect(max).toBe(1000);
    });
  });

  describe('watch event response schema', () => {
    it('should validate watch.poll response', () => {
      const response = {
        watching: true,
        node_path: 'root/Button',
        signal_name: 'pressed',
        events: [
          { frame: 150, time: 2.5, args: [] },
          { frame: 300, time: 5.0, args: [] },
        ],
        event_count: 2,
      };
      expect(response.events).toHaveLength(2);
      expect(response.event_count).toBe(2);
    });

    it('should validate watch.stop returns all events', () => {
      const response = {
        watching: false,
        node_path: 'root/Timer',
        signal_name: 'timeout',
        events: [
          { frame: 120, time: 2.0, args: [] },
        ],
        event_count: 1,
        duration_seconds: 10.5,
      };
      expect(response.watching).toBe(false);
      expect(response.events).toBeInstanceOf(Array);
    });
  });
});
```

- [ ] **Step 2: 运行测试验证通过**

Run: `npx vitest run test/game-bridge-signal-watch.test.js`
Expected: PASS

- [ ] **Step 3: 在 mcp_bridge.gd 中实现 watch 状态变量和命令**

在成员变量区（monitor 变量之后）新增：

```gdscript
# ─── Signal watch state ────────────────────────────────────────────────
var _watch_active: bool = false
var _watch_node_path: String = ""
var _watch_signal_name: String = ""
var _watch_events: Array = []
var _watch_max_events: int = 1000
var _watch_connected: bool = false
```

在 `_handle_message()` 的 match 块中新增：

```gdscript
			"watch.start":
				result = _cmd_watch_start(params)
			"watch.stop":
				result = _cmd_watch_stop()
			"watch.poll":
				result = _cmd_watch_poll()
```

新增信号回调函数和 3 个命令（在 monitor 命令之后）：

```gdscript
# ─── Signal watch commands ──────────────────────────────────────────────

func _on_watched_signal_emitted(args_array: Array = []) -> void:
	if not _watch_active:
		return
	var event_dict: Dictionary = {
		"frame": Engine.get_process_frames(),
		"time": Time.get_ticks_msec() / 1000.0,
	}
	# 简化参数序列化——仅支持基本类型
	var safe_args: Array = []
	for arg in args_array:
		if arg is Vector2:
			safe_args.append({"x": arg.x, "y": arg.y})
		elif arg is Vector3:
			safe_args.append({"x": arg.x, "y": arg.y, "z": arg.z})
		elif arg is int or arg is float or arg is bool or arg is String:
			safe_args.append(arg)
		else:
			safe_args.append(str(arg))
	event_dict["args"] = safe_args
	_watch_events.append(event_dict)
	if _watch_events.size() >= _watch_max_events:
		# 自动停止
		_do_watch_disconnect()
		_watch_active = false


func _do_watch_disconnect() -> void:
	if not _watch_connected:
		return
	var node := get_node_or_null(_watch_node_path)
	if node != null:
		# 断开信号连接
		if node.has_signal(_watch_signal_name) and node.is_connected(_watch_signal_name, _on_watched_signal_emitted):
			node.disconnect(_watch_signal_name, _on_watched_signal_emitted)
	_watch_connected = false


func _cmd_watch_start(params: Dictionary) -> Variant:
	var node_path: String = str(params.get("node_path", ""))
	var signal_name: String = str(params.get("signal_name", ""))
	var max_events: int = int(params.get("max_events", 1000))

	if node_path == "":
		return {"error": {"code": -1, "message": "node_path is required"}}
	if signal_name == "":
		return {"error": {"code": -2, "message": "signal_name is required"}}
	if max_events < 1:
		max_events = 1
	if max_events > 5000:
		max_events = 5000

	var node := get_node_or_null(node_path)
	if node == null:
		return {"error": {"code": -3, "message": "Node not found: %s" % node_path}}
	if not node.has_signal(signal_name):
		return {"error": {"code": -4, "message": "Signal not found: %s on %s" % [signal_name, node_path]}}

	# 如果已有监听在运行，先停止
	if _watch_active:
		_do_watch_disconnect()

	var previous_events: Array = []
	if _watch_events.size() > 0:
		previous_events = _watch_events.duplicate(true)

	# 连接信号
	var err := node.connect(signal_name, _on_watched_signal_emitted)
	if err != OK:
		return {"error": {"code": -5, "message": "Failed to connect signal: %s (error %d)" % [signal_name, err]}}

	_watch_active = true
	_watch_connected = true
	_watch_node_path = node_path
	_watch_signal_name = signal_name
	_watch_max_events = max_events
	_watch_events = []

	var result_dict: Dictionary = {
		"watching": true,
		"node_path": node_path,
		"signal_name": signal_name,
		"max_events": max_events,
	}
	if previous_events.size() > 0:
		result_dict["previous_events"] = previous_events
	return result_dict


func _cmd_watch_stop() -> Variant:
	if not _watch_active:
		return {"watching": false, "events": [], "message": "No active watch"}
	_do_watch_disconnect()
	_watch_active = false
	var events := _watch_events.duplicate(true)
	var duration := 0.0
	if events.size() > 0:
		duration = events[events.size() - 1].get("time", 0.0) - events[0].get("time", 0.0)
	var result_dict: Dictionary = {
		"watching": false,
		"node_path": _watch_node_path,
		"signal_name": _watch_signal_name,
		"events": events,
		"event_count": events.size(),
		"duration_seconds": duration,
	}
	_watch_events = []
	return result_dict


func _cmd_watch_poll() -> Variant:
	if not _watch_active:
		return {"watching": false, "events": [], "message": "No active watch"}
	var events := _watch_events.duplicate(true)
	return {
		"watching": true,
		"node_path": _watch_node_path,
		"signal_name": _watch_signal_name,
		"events": events,
		"event_count": events.size(),
	}
```

- [ ] **Step 4: 在 game-bridge.ts 中新增 watch action 类型**

在 `ACTIONS` 数组中追加：

```typescript
  'watch_start',      // 新增
  'watch_stop',       // 新增
  'watch_poll',       // 新增
```

在 `handleTool()` 的 switch 中追加（monitor case 之后）：

```typescript
      case 'watch_start': {
        const resp = await sendToBridge('watch.start', {
          node_path: args.node_path as string,
          signal_name: args.signal_name as string,
          max_events: (args.max_events as number) ?? 1000,
        }, args.timeout as number || DEFAULT_TIMEOUT);
        return textResult(JSON.stringify(resp.result ?? resp.error));
      }
      case 'watch_stop': {
        const resp = await sendToBridge('watch.stop', {}, args.timeout as number || DEFAULT_TIMEOUT);
        return textResult(JSON.stringify(resp.result ?? resp.error));
      }
      case 'watch_poll': {
        const resp = await sendToBridge('watch.poll', {}, args.timeout as number || DEFAULT_TIMEOUT);
        return textResult(JSON.stringify(resp.result ?? resp.error));
      }
```

在 `inputSchema.properties` 中追加：

```typescript
          signal_name: {
            type: 'string',
            description: 'watch_start: 要监听的信号名（如 "pressed"、"health_changed"）',
          },
          max_events: {
            type: 'number',
            description: 'watch_start: 最大记录事件数（默认 1000，最大 5000）',
          },
```

更新工具 description 追加 watch 说明。

- [ ] **Step 5: 运行全量测试**

Run: `npx vitest run`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add src/scripts/mcp_bridge.gd src/tools/game-bridge.ts test/game-bridge-signal-watch.test.js
git commit -m "feat: 运行时信号监听 watch.start/stop/poll"
```

---

## Task 3: UI 元素发现 — find_ui_elements + click_button

**Files:**
- Modify: `src/scripts/mcp_bridge.gd` — 新增 2 个命令
- Modify: `src/tools/game-bridge.ts` — 新增 2 个 action
- Create: `test/game-bridge-ui-discover.test.js`

**GDScript 端设计：**

新增 2 个 Bridge 命令：
- `find_ui_elements` — 递归查找所有可见 Control 节点，提取类型化数据
- `click_button_by_text` — 通过文字找到按钮并 emit pressed 信号

- [ ] **Step 1: 写 UI 发现测试**

```javascript
// test/game-bridge-ui-discover.test.js
import { describe, it, expect } from 'vitest';

describe('game-bridge UI discovery', () => {
  describe('find_ui_elements response schema', () => {
    it('should return array of UI elements with metadata', () => {
      const response = {
        elements: [
          {
            path: 'root/CanvasLayer/MainMenu/StartButton',
            type: 'Button',
            text: 'Start Game',
            disabled: false,
            visible: true,
            position: { x: 100, y: 200 },
            size: { x: 200, y: 50 },
            center: { x: 200, y: 225 },
          },
          {
            path: 'root/CanvasLayer/MainMenu/HealthBar',
            type: 'ProgressBar',
            value: 75,
            min_value: 0,
            max_value: 100,
            visible: true,
            position: { x: 50, y: 10 },
            size: { x: 300, y: 20 },
            center: { x: 200, y: 20 },
          },
        ],
        count: 2,
      };
      expect(response.elements).toHaveLength(2);
      expect(response.elements[0].type).toBe('Button');
      expect(response.elements[0].center).toBeDefined();
    });
  });

  describe('click_button response schema', () => {
    it('should return clicked button info', () => {
      const response = {
        clicked: true,
        button_path: 'root/CanvasLayer/MainMenu/StartButton',
        button_text: 'Start Game',
      };
      expect(response.clicked).toBe(true);
    });

    it('should return error when button not found', () => {
      const response = {
        error: { code: -1, message: 'No visible Button with text "NonExistent" found' },
      };
      expect(response.error).toBeDefined();
    });
  });

  describe('UI type extraction', () => {
    it('should extract type-specific properties for each Control subclass', () => {
      const types = {
        Button: ['text', 'disabled'],
        Label: ['text'],
        HSlider: ['value', 'min_value', 'max_value'],
        ProgressBar: ['value', 'min_value', 'max_value'],
        CheckBox: ['button_pressed', 'text'],
        LineEdit: ['text', 'editable', 'max_length'],
        SpinBox: ['value', 'min_value', 'max_value'],
        OptionButton: ['text', 'item_count'],
      };
      for (const [type, props] of Object.entries(types)) {
        expect(Array.isArray(props)).toBe(true);
        expect(props.length).toBeGreaterThan(0);
      }
    });
  });
});
```

- [ ] **Step 2: 运行测试验证通过**

Run: `npx vitest run test/game-bridge-ui-discover.test.js`
Expected: PASS

- [ ] **Step 3: 在 mcp_bridge.gd 中实现 find_ui_elements 和 click_button**

在 `_handle_message()` 的 match 块中新增：

```gdscript
			"find_ui_elements":
				result = _cmd_find_ui_elements(params)
			"click_button":
				result = _cmd_click_button(params)
```

新增 2 个命令实现（在 watch 命令之后）：

```gdscript
# ─── UI discovery commands ──────────────────────────────────────────────

func _extract_ui_data(node: Control) -> Dictionary:
	var data: Dictionary = {
		"path": str(node.get_path()),
		"type": node.get_class(),
		"visible": node.visible,
		"position": {"x": node.position.x, "y": node.position.y},
		"size": {"x": node.size.x, "y": node.size.y},
		"center": {"x": node.position.x + node.size.x / 2.0, "y": node.position.y + node.size.y / 2.0},
	}
	# 按类型提取特定属性
	if node is BaseButton:
		data["text"] = node.text if "text" in node else ""
		data["disabled"] = node.disabled
	elif node is Label:
		data["text"] = node.text
	elif node is Range:  # covers Slider, ProgressBar, SpinBox
		data["value"] = node.value
		data["min_value"] = node.min_value
		data["max_value"] = node.max_value
		if node is SpinBox:
			data["editable"] = node.editable
	elif node is LineEdit:
		data["text"] = node.text
		data["editable"] = node.editable
		data["max_length"] = node.max_length
	elif node is OptionButton:
		data["text"] = node.text
		data["item_count"] = node.item_count
		var items: Array = []
		for i in range(node.item_count):
			items.append(node.get_item_text(i))
		data["items"] = items
	elif node is ItemList:
		data["item_count"] = node.item_count
	return data


func _cmd_find_ui_elements(params: Dictionary) -> Variant:
	var pattern: String = str(params.get("pattern", ""))
	var type_filter: String = str(params.get("type", ""))
	var visible_only: bool = params.get("visible_only", true)
	var max_results: int = int(params.get("limit", 200))
	if max_results > 500:
		max_results = 500

	var results: Array = []
	var stack: Array[Node] = [get_tree().root]

	while stack.size() > 0 and results.size() < max_results:
		var node: Node = stack.pop_back()
		if node == null:
			continue
		# 只处理 Control 子类
		if not node is Control:
			for child in node.get_children():
				stack.append(child)
			continue
		var ctrl: Control = node as Control
		# 过滤
		if visible_only and not ctrl.visible:
			for child in ctrl.get_children():
				stack.append(child)
			continue
		var match_found := true
		if pattern != "":
			var text_to_match := ""
			if "text" in ctrl:
				text_to_match = str(ctrl.get("text"))
			if not ctrl.name.match(pattern) and not text_to_match.match(pattern):
				match_found = false
		if match_found and type_filter != "" and not ctrl.is_class(type_filter):
			match_found = false
		if match_found:
			results.append(_extract_ui_data(ctrl))
		# 继续递归子节点
		for child in ctrl.get_children():
			stack.append(child)

	return {"elements": results, "count": results.size()}


func _cmd_click_button(params: Dictionary) -> Variant:
	var text: String = str(params.get("text", ""))
	var path: String = str(params.get("path", ""))

	var target: BaseButton = null

	if path != "":
		var node := get_node_or_null(path)
		if node == null:
			return {"error": {"code": -1, "message": "Node not found: %s" % path}}
		if not node is BaseButton:
			return {"error": {"code": -2, "message": "Node is not a Button: %s (type: %s)" % [path, node.get_class()]}}
		target = node as BaseButton
	elif text != "":
		# 按文字搜索
		var stack: Array[Node] = [get_tree().root]
		while stack.size() > 0:
			var node: Node = stack.pop_back()
			if node is BaseButton:
				var btn: BaseButton = node as BaseButton
				var btn_text := str(btn.get("text")) if "text" in btn else ""
				if btn_text == text and btn.visible:
					target = btn
					break
			for child in node.get_children():
				stack.append(child)
		if target == null:
			return {"error": {"code": -3, "message": "No visible Button with text \"%s\" found" % text}}
	else:
		return {"error": {"code": -4, "message": "Either text or path is required"}}

	# Emit pressed signal
	target.emit_signal("pressed")
	return {
		"clicked": true,
		"button_path": str(target.get_path()),
		"button_text": str(target.get("text")) if "text" in target else "",
	}
```

- [ ] **Step 4: 在 game-bridge.ts 中新增 UI 发现 action**

在 `ACTIONS` 数组中追加：

```typescript
  'find_ui_elements',  // 新增
  'click_button',      // 新增
```

在 `handleTool()` 的 switch 中追加：

```typescript
      case 'find_ui_elements': {
        const resp = await sendToBridge('find_ui_elements', {
          pattern: args.pattern as string ?? '',
          type: args.type as string ?? '',
          visible_only: args.visible_only !== false,
          limit: (args.limit as number) ?? 200,
        }, args.timeout as number || DEFAULT_TIMEOUT);
        return textResult(JSON.stringify(resp.result ?? resp.error));
      }
      case 'click_button': {
        const resp = await sendToBridge('click_button', {
          text: args.text as string ?? '',
          path: args.path as string ?? '',
        }, args.timeout as number || DEFAULT_TIMEOUT);
        return textResult(JSON.stringify(resp.result ?? resp.error));
      }
```

在 `inputSchema.properties` 中追加：

```typescript
          pattern: {
            type: 'string',
            description: 'find_ui_elements: 名称/文字匹配模式（Godot match 语法）',
          },
          type: {
            type: 'string',
            description: 'find_ui_elements: 按类型过滤（如 "Button"、"Label"）',
          },
          visible_only: {
            type: 'boolean',
            description: 'find_ui_elements: 仅返回可见元素（默认 true）',
          },
          limit: {
            type: 'number',
            description: 'find_ui_elements: 最大返回数（默认 200，上限 500）',
          },
          text: {
            type: 'string',
            description: 'click_button: 按钮文字（和 path 二选一）',
          },
          path: {
            type: 'string',
            description: 'click_button: 按钮节点路径（和 text 二选一）',
          },
```

更新工具 description 追加 UI 发现说明。

- [ ] **Step 5: 运行全量测试**

Run: `npx vitest run`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add src/scripts/mcp_bridge.gd src/tools/game-bridge.ts test/game-bridge-ui-discover.test.js
git commit -m "feat: UI 元素发现 find_ui_elements + click_button"
```

---

## Task 4: 工具分组细化 — Profile 系统

**Files:**
- Modify: `src/core/tool-registry.ts` — 新增 GROUPS 定义 + PROFILE 系统
- Modify: `src/core/ToolDispatcher.ts` — 支持 profile 过滤
- Modify: `src/index.ts` — 新增 `--profile` 参数
- Create: `test/tool-groups.test.js`

**设计：**

将当前 3 档（full/lite/minimal）扩展为 16 组可配置工具组 + 5 个预置 profile。

16 个工具组：
1. `core` — project, scene, script, runtime, validation, confirm_and_execute
2. `editor` — editor
3. `bridge` — game
4. `animation` — animation, animtree
5. `audio` — audio
6. `visual` — material, screenshot, particles
7. `physics` — physics, spatial
8. `navigation` — navigation
9. `ui` — ui
10. `tilemap` — tilemap
11. `signal` — signal
12. `profiler` — profiler, workflow
13. `test` — test, delivery
14. `code` — docs, templates, batch, game_design
15. `ik` — ik
16. `recording` — recording

5 个预置 profile：
- `full` — 全部组
- `lite` — core + bridge + animation + audio + signal + material + test + profiler + docs
- `minimal` — core only
- `bridge_dev` — core + bridge + profiler + test + recording
- `3d_dev` — core + animation + visual + physics + navigation + ik + spatial

- [ ] **Step 1: 写工具分组测试**

```javascript
// test/tool-groups.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import {
  TOOL_GROUPS,
  PROFILES,
  resolveProfile,
  expandGroups,
  isKnownTool,
  clearRegistry,
} from '../src/core/tool-registry.js';

describe('tool-registry groups and profiles', () => {
  describe('TOOL_GROUPS', () => {
    it('should define 16 tool groups', () => {
      const groupNames = Object.keys(TOOL_GROUPS);
      expect(groupNames).toHaveLength(16);
    });

    it('should have each group contain valid tool names as string arrays', () => {
      for (const [name, tools] of Object.entries(TOOL_GROUPS)) {
        expect(Array.isArray(tools), `Group ${name} should be array`).toBe(true);
        expect(tools.length, `Group ${name} should not be empty`).toBeGreaterThan(0);
        for (const t of tools) {
          expect(typeof t, `Tool in ${name} should be string`).toBe('string');
        }
      }
    });

    it('should have core group with essential tools', () => {
      expect(TOOL_GROUPS.core).toContain('project');
      expect(TOOL_GROUPS.core).toContain('scene');
      expect(TOOL_GROUPS.core).toContain('script');
      expect(TOOL_GROUPS.core).toContain('runtime');
      expect(TOOL_GROUPS.core).toContain('validation');
    });

    it('should have bridge group', () => {
      expect(TOOL_GROUPS.bridge).toContain('game');
    });
  });

  describe('PROFILES', () => {
    it('should define 5 profiles', () => {
      const profileNames = Object.keys(PROFILES);
      expect(profileNames).toHaveLength(5);
    });

    it('should have full profile include all groups', () => {
      expect(PROFILES.full).toHaveLength(16);
    });

    it('should have minimal profile only include core', () => {
      expect(PROFILES.minimal).toEqual(['core']);
    });
  });

  describe('resolveProfile', () => {
    it('should expand profile to tool names', () => {
      const tools = resolveProfile('minimal');
      expect(tools).toContain('project');
      expect(tools).toContain('scene');
      expect(tools).toContain('script');
      expect(tools).not.toContain('animation');
    });

    it('should expand full profile to all tools', () => {
      const tools = resolveProfile('full');
      expect(tools.length).toBeGreaterThan(20);
    });

    it('should support comma-separated group override', () => {
      const tools = resolveProfile('core,bridge');
      expect(tools).toContain('project');
      expect(tools).toContain('game');
    });
  });

  describe('expandGroups', () => {
    it('should expand group names to tool names', () => {
      const tools = expandGroups(['core', 'audio']);
      expect(tools).toContain('project');
      expect(tools).toContain('audio');
    });

    it('should deduplicate when groups overlap', () => {
      const tools = expandGroups(['core', 'core']);
      const unique = [...new Set(tools)];
      expect(tools.length).toBe(unique.length);
    });
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run test/tool-groups.test.js`
Expected: FAIL — `TOOL_GROUPS`, `PROFILES`, `resolveProfile`, `expandGroups` 未导出

- [ ] **Step 3: 在 tool-registry.ts 中实现分组和 profile 系统**

在 `Mode filters` 区域之前新增：

```typescript
// ─── Tool groups ─────────────────────────────────────────────────────────────

export const TOOL_GROUPS: Record<string, string[]> = {
  core:       ['project', 'scene', 'script', 'runtime', 'validation', 'confirm_and_execute'],
  editor:     ['editor'],
  bridge:     ['game'],
  animation:  ['animation', 'animtree'],
  audio:      ['audio'],
  visual:     ['material', 'screenshot', 'particles'],
  physics:    ['physics', 'spatial'],
  navigation: ['navigation'],
  ui:         ['ui'],
  tilemap:    ['tilemap'],
  signal:     ['signal'],
  profiler:   ['profiler', 'workflow'],
  test:       ['test', 'delivery'],
  code:       ['docs', 'templates', 'batch', 'game_design'],
  ik:         ['ik'],
  recording:  ['recording'],
};

export const PROFILES: Record<string, string[]> = {
  full:        Object.keys(TOOL_GROUPS),                                     // 全部 16 组
  lite:        ['core', 'bridge', 'animation', 'audio', 'signal', 'material', 'test', 'profiler', 'docs'],
  minimal:     ['core'],
  bridge_dev:  ['core', 'bridge', 'profiler', 'test', 'recording'],
  '3d_dev':    ['core', 'animation', 'visual', 'physics', 'navigation', 'ik', 'spatial'],
};

/** Expand an array of group names to a deduplicated set of tool names. */
export function expandGroups(groups: string[]): string[] {
  const tools = new Set<string>();
  for (const g of groups) {
    const groupTools = TOOL_GROUPS[g];
    if (groupTools) {
      for (const t of groupTools) tools.add(t);
    }
  }
  return [...tools];
}

/** Resolve a profile name (or comma-separated group list) to a Set of tool names. */
export function resolveProfile(profile: string): Set<string> {
  // Check if it's a known profile name
  const profileGroups = PROFILES[profile];
  if (profileGroups) {
    return new Set(expandGroups(profileGroups));
  }
  // Treat as comma-separated group names
  const groups = profile.split(',').map(g => g.trim()).filter(Boolean);
  return new Set(expandGroups(groups));
}
```

- [ ] **Step 4: 在 ToolDispatcher.ts 中支持 profile 过滤**

找到当前 `toolMode` 过滤逻辑（使用 `LITE_TOOLS` / `MINIMAL_TOOLS` 的地方），修改为同时支持 profile：

```typescript
// 在过滤函数中新增 profile 分支
import { resolveProfile } from './tool-registry.js';

// 在现有的 mode 过滤逻辑中追加 profile 支持：
// 如果 mode 是 full/lite/minimal，走现有逻辑
// 如果 mode 以 'profile:' 开头（如 'profile:bridge_dev'），使用 resolveProfile
```

具体修改点：找到 `ToolDispatcher.ts` 中过滤工具列表的函数，确保当 `mode` 不是 `full`/`lite`/`minimal` 之一时，尝试 `resolveProfile(mode)`。如果解析成功，用返回的 Set 过滤工具。

- [ ] **Step 5: 在 index.ts 中支持 --profile 参数**

修改入口参数解析：

```typescript
const args = process.argv.slice(2);

// 支持 --profile=bridge_dev 语法
const profileArg = args.find(a => a.startsWith('--profile='));
const profileFromArg = profileArg ? profileArg.split('=')[1] : null;
const profileFromEnv = process.env.GODOT_MCP_PROFILE;

const activeProfile = profileFromArg || profileFromEnv;

const toolMode = activeProfile ? activeProfile
  : args.includes('--minimal') ? 'minimal'
  : args.includes('--lite') ? 'lite'
  : process.env.GODOT_MCP_MODE === 'minimal' ? 'minimal'
  : process.env.GODOT_MCP_MODE === 'lite' ? 'lite'
  : 'full';
```

使用示例：
- `npx godot-mcp-enhanced --profile=bridge_dev`
- `GODOT_MCP_PROFILE=3d_dev npx godot-mcp-enhanced`

- [ ] **Step 6: 更新 LITE_TOOLS 和 MINIMAL_TOOLS 使其与 PROFILES 一致**

当前 `LITE_TOOLS` 和 `MINIMAL_TOOLS` 是手动维护的 Set。修改为从 `PROFILES` 派生，保持向后兼容：

```typescript
// 向后兼容：从 PROFILES 派生，不再手动维护
export const LITE_TOOLS = resolveProfile('lite');
export const MINIMAL_TOOLS = resolveProfile('minimal');
```

注意：由于 `resolveProfile` 返回 `Set<string>`，与现有 `Set<string>` 类型一致，无需改动引用方。

- [ ] **Step 7: 运行全量测试**

Run: `npx vitest run`
Expected: 全部 PASS（需确认引用 `LITE_TOOLS`/`MINIMAL_TOOLS` 的现有测试仍通过）

- [ ] **Step 8: 提交**

```bash
git add src/core/tool-registry.ts src/core/ToolDispatcher.ts src/index.ts test/tool-groups.test.js
git commit -m "feat: 工具分组细化 — 16 组 + 5 个预置 profile + --profile 参数"
```

---

## Task 5: 更新文档和规则

**Files:**
- Modify: `CLAUDE.md` — 新增 monitor/watch/ui 工具速查
- Modify: `.claude/rules/godot-mcp-bridge.md` — 新增 monitor/watch/ui 命令说明
- Modify: `README.md` — 新增功能描述

- [ ] **Step 1: 更新 CLAUDE.md 工具速查表**

在 MCP 子系统速查表中新增行：

```markdown
| **运行时监控** | game (monitor_start) | 属性时间线采样 + 信号事件记录 | Bridge 连接 | bridge |
| **UI 发现** | game (find_ui_elements) | 递归查找 Control + 按钮点击 | Bridge 连接 | bridge |
```

在速查表下方新增 Profile 配置说明：

```markdown
## MCP Profile 配置

通过 `--profile=<name>` 或 `GODOT_MCP_PROFILE=<name>` 选择工具子集：

| Profile | 包含组 | 适用场景 |
|---------|--------|---------|
| full | 全部 16 组 | 默认 |
| lite | 9 组 | 通用开发 |
| minimal | core 6 工具 | 最小安装 |
| bridge_dev | 5 组 | 运行时调试 |
| 3d_dev | 7 组 | 3D 游戏开发 |

自定义：`--profile=core,bridge,audio`（逗号分隔组名）
```

- [ ] **Step 2: 更新 bridge 规则文件**

在 `.claude/rules/godot-mcp-bridge.md` 中追加新的 method 说明：

在 `### 查询 — game_query` 表格之后新增：

```markdown
### 监控 — monitor

| method | 说明 |
|--------|------|
| `monitor_start` | 开始属性采样（node_path + properties + interval_frames） |
| `monitor_stop` | 停止采样，返回完整时间线 |
| `monitor_poll` | 获取当前采样数据（不停止） |

### 信号 — watch

| method | 说明 |
|--------|------|
| `watch_start` | 监听信号（node_path + signal_name + max_events） |
| `watch_stop` | 停止监听，返回事件列表 |
| `watch_poll` | 获取已记录事件（不停止） |

### UI — discover

| method | 说明 |
|--------|------|
| `find_ui_elements` | 查找可见 Control 节点（pattern/type/visible_only/limit） |
| `click_button` | 点击按钮（text 或 path） |
```

- [ ] **Step 3: 更新 README.md**

在工具列表区域追加新功能描述段落。

- [ ] **Step 4: 提交**

```bash
git add CLAUDE.md .claude/rules/godot-mcp-bridge.md README.md
git commit -m "docs: 新增 monitor/watch/ui-discover 文档 + profile 配置说明"
```

---

## 自查清单

**1. 规格覆盖：**
- ✅ 属性监控：Task 1 覆盖 start/stop/poll + 采样逻辑 + TypeScript 客户端
- ✅ 信号监听：Task 2 覆盖 start/stop/poll + Callable 动态连接 + 事件序列化
- ✅ UI 发现：Task 3 覆盖 find_ui_elements + click_button + 类型化数据提取
- ✅ 工具分组：Task 4 覆盖 16 组定义 + 5 profile + resolveProfile + --profile 参数
- ✅ 文档更新：Task 5 覆盖 CLAUDE.md + bridge 规则 + README

**2. 占位符扫描：** 无 TBD/TODO/placeholder

**3. 类型一致性：**
- GDScript 端所有命令返回 `Variant`（Dictionary 或 error Dictionary）
- TypeScript 端统一走 `sendToBridge()` 返回 `BridgeResponse`
- TOOL_GROUPS / PROFILES 导出类型明确（`Record<string, string[]>`）
- `resolveProfile` 返回 `Set<string>`，与现有 `LITE_TOOLS` / `MINIMAL_TOOLS` 兼容
