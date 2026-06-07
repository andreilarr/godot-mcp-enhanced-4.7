@tool
extends Node

## MCP Bridge Autoload — TCP + NDJSON protocol
## Install as autoload in project.godot to enable runtime game control via MCP.
## Default port: 9081

const PORT := 9081
const MAX_AUTH_FAILS := 5
const LOCKOUT_BASE_SECONDS := 30.0
const LOCKOUT_MAX_SECONDS := 300.0
const _LOCKOUT_KEY := "localhost"
const MAX_MESSAGE_SIZE := 1048576  # 1MB
const MAX_PEERS := 5
const PROTOCOL_VERSION := "1.0"
const INACTIVITY_TIMEOUT := 60.0

var _server: TCPServer = null
var _peers: Array[StreamPeerTCP] = []
var _peer_buffers: Dictionary = {}
var _authenticated_peers: Dictionary = {}
var _auth_fail_count: Dictionary = {}
var _auth_locked_until: Dictionary = {}
var _secret: String = ""
var _secret_file: String = ""
var _crypto: Crypto = null
var _peer_last_activity: Dictionary = {}

var _recording: bool = false
var _recorded_events: Array = []
var _record_start_time: int = 0

# ─── Per-peer Monitor/Watch states (C-07) ──────────────────────────────────
const MONITOR_MAX_PROPERTIES := 20
const MONITOR_DEFAULT_MAX_SAMPLES := 500
var _monitor_states: Dictionary = {}

const WATCH_DEFAULT_MAX_EVENTS := 1000
var _watch_states: Dictionary = {}

const BLOCKED_PROPERTIES := [
	"script", "owner", "process_mode", "process_priority", "process_input",
	"process_unhandled_input", "process_unhandled_key_input", "process_internal",
	"physics_process_mode", "physics_interpolation_mode", "name", "meta",
	"input_event", "ready", "tree_entered", "tree_exited", "tree_exiting",
]

# WARNING: "get" + "get_property_list" can enumerate most public properties.
# This is intentional for debugging but be aware of the information disclosure vector.
const ALLOWED_METHODS := [
	"get", "get_class", "get_path", "get_children", "get_child", "get_child_count",
	"get_parent", "get_property_list", "has_method", "is_class", "get_instance_id",
	"get_meta", "has_meta", "has_signal", "get_signal_list", "get_signal_connection_list",
	"get_incoming_connections", "get_index", "get_groups", "is_in_group",
	"is_inside_tree", "is_part_of_edited_scene", "get_owner",
]

# ─── Lifecycle ─────────────────────────────────────────────────────────────

func _ready() -> void:
	if Engine.is_editor_hint():
		return
	# Skip Bridge startup in headless/script mode — Bridge is for runtime game control only.
	# Headless mode means MCP is driving Godot via --headless --script, not a running game.
	if DisplayServer.get_name() == "headless":
		return
	_start_server()


func _exit_tree() -> void:
	_stop_server()


func _process(_delta: float) -> void:
	if _server == null:
		return

	# Accept new connections (Godot 4.6 renamed accept() to take_connection())
	var peer: StreamPeerTCP = _server_take_connection()
	if peer != null:
		if _peers.size() >= MAX_PEERS:
			push_warning("[MCP Bridge] Max peers (%d) reached, rejecting connection" % MAX_PEERS)
			peer.disconnect_from_host()
		else:
			_peers.append(peer)
			_peer_last_activity[peer.get_instance_id()] = Time.get_ticks_msec() / 1000.0
			_peer_buffers["buf_" + str(peer.get_instance_id())] = PackedByteArray()

	# Process each peer
	var to_remove: Array[int] = []
	for i in range(_peers.size()):
		var p: StreamPeerTCP = _peers[i]
		p.poll()
		if p.get_status() != StreamPeerTCP.STATUS_CONNECTED:
			to_remove.append(i)
			continue
		# Idle timeout check
		var pid_act := p.get_instance_id()
		if _peer_last_activity.has(pid_act):
			var elapsed: float = Time.get_ticks_msec() / 1000.0 - float(_peer_last_activity[pid_act])
			if elapsed > INACTIVITY_TIMEOUT:
				push_warning("[MCP Bridge] Peer %d idle for %.0fs, disconnecting" % [pid_act, elapsed])
				p.disconnect_from_host()
				to_remove.append(i)
				continue
		if p.get_available_bytes() > 0:
			_peer_last_activity[pid_act] = Time.get_ticks_msec() / 1000.0
			var byte_count := p.get_available_bytes()
			var result := p.get_data(byte_count)
			if result[0] == OK:
				var raw_data: PackedByteArray = result[1]
				if raw_data.size() > 0:
					var pid := p.get_instance_id()
					var key := "buf_" + str(pid)
					var existing: PackedByteArray = _peer_buffers.get(key, PackedByteArray()) as PackedByteArray
					var combined: PackedByteArray = existing + raw_data
					if combined.size() > MAX_MESSAGE_SIZE:
						push_warning("[MCP Bridge] Peer %d buffer exceeded %d bytes, disconnecting" % [pid, MAX_MESSAGE_SIZE])
						p.disconnect_from_host()
						to_remove.append(i)
						continue
					_peer_buffers[key] = combined
					if _process_buffer_bytes(p, pid):
						to_remove.append(i)

	# Remove disconnected peers (reverse order to preserve indices)
	for idx in range(to_remove.size() - 1, -1, -1):
		var i: int = to_remove[idx]
		var pid := _peers[i].get_instance_id()
		_peer_buffers.erase("buf_" + str(pid))
		_authenticated_peers.erase(pid)
		_peer_last_activity.erase(pid)
		# C-07: cleanup per-peer monitor/watch state on disconnect
		_cleanup_peer_state(pid)
		# Auth fail/lockout counts persist across reconnects (all connections are localhost)
		_peers.remove_at(i)

	# ─── Property monitor sampling (C-07: per-peer) ─────────────────────────
	var dead_monitors: Array = []
	for peer_id in _monitor_states:
		var ms: Dictionary = _monitor_states[peer_id]
		if not ms.get("active", false):
			continue
		ms["frame_counter"] = int(ms["frame_counter"]) + 1
		if int(ms["frame_counter"]) < int(ms["interval_frames"]):
			continue
		ms["frame_counter"] = 0
		var node := get_node_or_null(str(ms["node_path"]))
		if node == null:
			ms["active"] = false
			(ms["samples"] as Array).append({"frame": Engine.get_process_frames(), "time": Time.get_ticks_msec() / 1000.0, "error": "node_lost", "stopped_reason": "node_lost"})
		else:
			var values: Dictionary = {}
			for prop in (ms["properties"] as Array):
				values[prop] = _jsonify(node.get(prop))
			(ms["samples"] as Array).append({
				"frame": Engine.get_process_frames(),
				"time": Time.get_ticks_msec() / 1000.0,
				"values": values
			})
			if (ms["samples"] as Array).size() >= int(ms["max_samples"]):
				(ms["samples"] as Array)[-1]["stopped_reason"] = "max_samples_reached"
				ms["active"] = false
		if not ms.get("active", false):
			dead_monitors.append(peer_id)
	for pid_key in dead_monitors:
		_monitor_states.erase(pid_key)


# ─── Server management ─────────────────────────────────────────────────────

func _start_server() -> void:
	_crypto = Crypto.new()
	_secret = _generate_secret()
	_server = TCPServer.new()
	var err := _server.listen(PORT, "127.0.0.1")
	if err != OK:
		push_warning("[MCP Bridge] Failed to listen on port %d: %d" % [PORT, err])
		_server = null
		return
	print("[MCP Bridge] Listening on 127.0.0.1:%d" % PORT)
	# C-01: Secret file MUST be in project .godot/ — never fall back to tmpdir.
	# Writing to tmpdir (globally readable on Linux) allows local privilege escalation.
	var proj_dir := _get_project_dir()
	if proj_dir == "":
		push_error("[MCP Bridge][SECURITY] Cannot determine project directory — aborting Bridge startup")
		_server.stop()
		_server = null
		return
	var godot_dir := proj_dir + "/.godot"
	if not DirAccess.dir_exists_absolute(godot_dir):
		DirAccess.make_dir_recursive_absolute(godot_dir)
	_secret_file = godot_dir + "/mcp_bridge_%d.secret" % PORT
	if not _write_secret_to_file(_secret_file):
		push_error("[MCP Bridge][SECURITY] Failed to write secret to %s — aborting Bridge startup. Check directory permissions." % _secret_file)
		_server.stop()
		_server = null
		return

## Compat: Godot 4.6 renamed TCPServer.accept() to take_connection()
func _server_take_connection() -> StreamPeerTCP:
	if _server.has_method("take_connection"):
		return _server.take_connection()
	return _server.accept()


# DUPLICATE: Keep in sync with addons/godot_mcp_server/websocket_server.gd:_constant_time_compare
# Cannot share because editor plugin and game autoload have separate script contexts.
# C-05: Fixed-length comparison (always 32 bytes) to prevent timing side-channel.
func _constant_time_compare(a: String, b: String) -> bool:
	const SECRET_LEN := 32
	var result := 0
	# Always compare exactly SECRET_LEN bytes regardless of input length
	for i in range(SECRET_LEN):
		var ca := ord(a[i]) if i < a.length() else 0
		var cb := ord(b[i]) if i < b.length() else 0
		result = result | (ca ^ cb)
	# Reject if either input length differs from expected
	if a.length() != SECRET_LEN or b.length() != SECRET_LEN:
		return false
	return result == 0

# DUPLICATE: Keep in sync with addons/godot_mcp_server/websocket_server.gd:_generate_secret
# Cannot share because editor plugin and game autoload have separate script contexts.
func _generate_secret() -> String:
	var chars := "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	var result := ""
	var rng_bytes: PackedByteArray = _crypto.generate_random_bytes(64)
	var idx := 0
	while result.length() < 32 and idx < rng_bytes.size():
		var b: int = rng_bytes[idx]
		idx += 1
		# Rejection sampling: skip bytes causing modulo bias (256 % 62 = 8, skip >= 248)
		if b >= 256 - (256 % chars.length()):
			continue
		result += chars[b % chars.length()]
	# Fallback: if rejection sampling exhausted bytes, generate more (max 10 attempts)
	var fallback_attempts := 0
	while result.length() < 32 and fallback_attempts < 10:
		rng_bytes = _crypto.generate_random_bytes(64)
		idx = 0
		fallback_attempts += 1
		while result.length() < 32 and idx < rng_bytes.size():
			var b2: int = rng_bytes[idx]
			idx += 1
			if b2 >= 256 - (256 % chars.length()):
				continue
			result += chars[b2 % chars.length()]
	if result.length() < 32:
		push_error("[MCP Bridge] Failed to generate 32-char secret, using truncated value")
	return result

func _get_project_dir() -> String:
	var res_root: String = ProjectSettings.globalize_path("res://")
	if res_root != "":
		return res_root.rstrip("/")
	return ""



func _write_secret_to_file(path: String) -> bool:
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f:
		f.store_string(_secret)
		f.close()
		return true
	return false


func _stop_server() -> void:
	for p in _peers:
		if p.get_status() == StreamPeerTCP.STATUS_CONNECTED:
			p.disconnect_from_host()
	_peers.clear()
	_authenticated_peers.clear()
	_peer_last_activity.clear()
	_auth_fail_count.clear()
	_auth_locked_until.clear()
	if _server:
		_server.stop()
		if _secret_file != "" and FileAccess.file_exists(_secret_file):
			DirAccess.remove_absolute(_secret_file)
		_server = null


# ─── Protocol handling ─────────────────────────────────────────────────────

func _process_buffer_bytes(peer: StreamPeerTCP, pid: int) -> bool:
	var key := "buf_" + str(pid)
	var raw: PackedByteArray = _peer_buffers.get(key, PackedByteArray()) as PackedByteArray
	while true:
		var nl_idx := raw.find(0x0A)
		if nl_idx == -1:
			break
		var line_bytes: PackedByteArray = raw.slice(0, nl_idx)
		raw = raw.slice(nl_idx + 1)
		if line_bytes.size() == 0:
			continue
		var line := line_bytes.get_string_from_utf8()
		if line == "" and line_bytes.size() > 0:
			push_warning("[MCP Bridge] Invalid UTF-8 in message from peer %d, disconnecting" % pid)
			peer.disconnect_from_host()
			_peer_buffers[key] = raw
			return true
		if not _authenticated_peers.has(pid):
			
			if _auth_locked_until.has(_LOCKOUT_KEY):
				var locked_until: float = _auth_locked_until[_LOCKOUT_KEY]
				if Time.get_ticks_msec() / 1000.0 < locked_until:
					peer.put_data((JSON.stringify({"id": null, "error": {"code": -32002, "message": "Too many auth failures, temporarily locked"}}) + "\n").to_utf8_buffer())
					peer.disconnect_from_host()
					_peer_buffers[key] = raw
					return true
				else:
					_auth_locked_until.erase(_LOCKOUT_KEY)
					_auth_fail_count[_LOCKOUT_KEY] = 0
			var parsed: Variant = JSON.parse_string(line)
			var incoming_secret: String = ""
			if parsed is Dictionary and parsed.get("params") is Dictionary:
				incoming_secret = str(parsed["params"].get("secret", ""))
			if parsed is Dictionary and parsed.get("method") == "auth" and _constant_time_compare(incoming_secret, _secret):
				_authenticated_peers[pid] = true
				_auth_fail_count.erase(_LOCKOUT_KEY)
				peer.put_data((JSON.stringify({"id": parsed.get("id"), "result": {"authenticated": true}}) + "\n").to_utf8_buffer())
				continue
			else:
				var fails: int = int(_auth_fail_count.get(_LOCKOUT_KEY, 0)) + 1
				_auth_fail_count[_LOCKOUT_KEY] = fails
				if fails >= MAX_AUTH_FAILS:
					var lockout_time := minf(LOCKOUT_BASE_SECONDS * pow(2.0, (float(fails) / MAX_AUTH_FAILS) - 1.0), LOCKOUT_MAX_SECONDS)
					_auth_locked_until[_LOCKOUT_KEY] = Time.get_ticks_msec() / 1000.0 + lockout_time
				peer.put_data((JSON.stringify({"id": null, "error": {"code": -32001, "message": "Authentication required"}}) + "\n").to_utf8_buffer())
				peer.disconnect_from_host()
				_peer_buffers[key] = raw
				return true
		var response := _handle_message(line, pid)
		peer.put_data((response + "\n").to_utf8_buffer())
	_peer_buffers[key] = raw
	return false

func _handle_message(raw: String, pid: int) -> String:
	var parsed: Variant
	parsed = JSON.parse_string(raw)
	if parsed == null or not (parsed is Dictionary):
		return JSON.stringify({"id": null, "error": {"code": -32700, "message": "Parse error"}})

	var msg: Dictionary = parsed
	var id: Variant = msg.get("id", null)
	var method: String = str(msg.get("method", ""))
	var params: Dictionary = {}
	if msg.get("params") is Dictionary:
		params = msg["params"]

	var result: Variant = null
	var error: Dictionary = {}

	match method:
		"ping":
			result = _cmd_ping()
		"get_tree":
			result = _cmd_get_tree(params)
		"find_nodes":
			result = _cmd_find_nodes(params)
		"get_node_properties":
			result = _cmd_get_node_properties(params)
		"set_node_property":
			result = _cmd_set_node_property(params)
		"call_method":
			result = _cmd_call_method(params)
		"send_key":
			result = _cmd_send_key(params)
		"send_mouse_click":
			result = _cmd_send_mouse_click(params)
		"send_mouse_move":
			result = _cmd_send_mouse_move(params)
		"send_text":
			result = _cmd_send_text(params)
		"wait_for_node":
			result = _cmd_wait_for_node(params)
		"wait_for_property":
			result = _cmd_wait_for_property(params)
		"take_screenshot":
			result = _cmd_take_screenshot(params)
		"get_performance":
			result = _cmd_get_performance()
		"get_viewport_info":
			result = _cmd_get_viewport_info()
		"recording.start":
			result = _cmd_recording_start()
		"recording.stop":
			result = _cmd_recording_stop()
		"monitor.start":
			result = _cmd_monitor_start(params, pid)
		"monitor.stop":
			result = _cmd_monitor_stop(pid)
		"monitor.poll":
			result = _cmd_monitor_poll(pid)
		"watch.start":
			result = _cmd_watch_start(params, pid)
		"watch.stop":
			result = _cmd_watch_stop(pid)
		"watch.poll":
			result = _cmd_watch_poll(pid)
		"find_ui_elements":
			result = _cmd_find_ui_elements(params)
		"click_button":
			result = _cmd_click_button(params)
		_:
			error = {"code": -32601, "message": "Method not found: %s" % method}

	# Promote command-level errors to top-level so TS client sees them.
	# TS sendToBridge only checks resp.error (top-level), never result.error.
	if error.is_empty() and result is Dictionary and result.has("error"):
		error = result["error"]
		result = null
	if error.is_empty():
		return JSON.stringify({"id": id, "result": result})
	else:
		return JSON.stringify({"id": id, "error": error})


# ─── Command implementations ────────────────────────────────────────────────

func _cmd_ping() -> Dictionary:
	var scene_path := ""
	if get_tree().current_scene:
		scene_path = get_tree().current_scene.scene_file_path
	return {"pong": true, "version": PROTOCOL_VERSION, "scene": scene_path, "fps": Engine.get_frames_per_second()}


func _cmd_get_tree(params: Dictionary) -> Variant:
	var max_depth: int = int(params.get("max_depth", 10))
	var root_node := get_tree().root
	if root_node == null:
		return {"tree": [], "scene": ""}
	var scene_path := ""
	if get_tree().current_scene:
		scene_path = get_tree().current_scene.scene_file_path
	var counter := [0]
	return {"tree": [_serialize_node(root_node, max_depth, 0, counter)], "scene": scene_path}


func _serialize_node(node: Node, max_depth: int, depth: int, counter: Array, max_nodes: int = 2000) -> Dictionary:
	if counter[0] >= max_nodes:
		return _node_info(node)
	counter[0] += 1
	var info := _node_info(node)
	if depth < max_depth:
		var children: Array = []
		for child in node.get_children():
			if counter[0] >= max_nodes:
				break
			children.append(_serialize_node(child, max_depth, depth + 1, counter, max_nodes))
		if children.size() > 0:
			info["children"] = children
	return info


func _node_info(node: Node) -> Dictionary:
	var info := {
		"name": node.name,
		"type": node.get_class(),
		"path": str(node.get_path()),
	}
	if node is CanvasItem:
		info["visible"] = node.visible
	if node is Node2D:
		info["position"] = {"x": node.position.x, "y": node.position.y}
	if node is Node3D:
		info["position"] = {"x": node.position.x, "y": node.position.y, "z": node.position.z}
	return info


func _cmd_find_nodes(params: Dictionary) -> Dictionary:
	var pattern: String = str(params.get("pattern", ""))
	var type_filter: String = str(params.get("type", ""))
	var group: String = str(params.get("group", ""))
	var max_results: int = int(params.get("limit", 100))
	if max_results > 500:
		max_results = 500
	var results: Array = _traverse_tree(
		func(node: Node) -> bool:
			if pattern != "" and not node.name.match(pattern):
				return false
			if type_filter != "" and not node.is_class(type_filter):
				return false
			if group != "" and not node.is_in_group(group):
				return false
			return true,
		{"max_results": max_results}
	)
	var serialized: Array = []
	for node in results:
		serialized.append(_node_info(node))
	return {"nodes": serialized, "count": serialized.size()}





func _cmd_get_node_properties(params: Dictionary) -> Variant:
	var path: String = str(params.get("path", ""))
	var node := get_node_or_null(path)
	if node == null:
		return {"error": {"code": -1, "message": "Node not found: %s" % path}}
	var props: Dictionary = {}
	for prop in node.get_property_list():
		var name: String = prop["name"]
		if name.begins_with("_") or name.begins_with("theme_override") or name in BLOCKED_PROPERTIES:
			continue
		var val: Variant = node.get(name)
		if val is Resource:
			val = {"type": val.get_class(), "path": val.resource_path if val.resource_path else ""}
		elif val is Node:
			val = str(val.get_path())
		props[name] = val
	return {"properties": props, "node": path}


func _cmd_set_node_property(params: Dictionary) -> Variant:
	var path: String = str(params.get("path", ""))
	var prop: String = str(params.get("property", ""))
	if not params.has("value"):
		return {"error": {"code": -6, "message": "Missing required parameter: value"}}
	var value: Variant = params["value"]
	var node := get_node_or_null(path)
	if node == null:
		return {"error": {"code": -1, "message": "Node not found: %s" % path}}
	if _is_blocked_property(prop):
		return {"error": {"code": -2, "message": "Blocked property: %s" % prop}}
	if not _is_safe_value(value):
		var type_info: String = "null" if value == null else value.get_class()
		return {"error": {"code": -3, "message": "Value type not allowed: %s" % type_info}}
	node.set(prop, value)
	return {"success": true, "node": path, "property": prop}


func _cmd_call_method(params: Dictionary) -> Variant:
	var path: String = str(params.get("path", ""))
	var method: String = str(params.get("method", ""))
	var args: Array = []
	if params.get("args") is Array:
		args = params["args"]
	var node := get_node_or_null(path)
	if node == null:
		return {"error": {"code": -1, "message": "Node not found: %s" % path}}
	if not method in ALLOWED_METHODS:
		return {"error": {"code": -2, "message": "Method not allowed: %s" % method}}
	if not node.has_method(method):
		return {"error": {"code": -3, "message": "Method not found: %s" % method}}
	if args.size() > 8:
		return {"error": {"code": -4, "message": "Too many arguments (max 8)"}}
	if method == "get" and args.size() > 0 and args[0] is String:
		if _is_blocked_property(args[0]):
			return {"error": {"code": -5, "message": "Blocked property via get(): %s" % args[0]}}
	var result: Variant = node.callv(method, args)
	return {"result": _jsonify(result)}


func _jsonify(val: Variant) -> Variant:
	if val is Vector2:
		return {"x": val.x, "y": val.y}
	if val is Vector2i:
		return {"x": val.x, "y": val.y}
	if val is Vector3:
		return {"x": val.x, "y": val.y, "z": val.z}
	if val is Vector3i:
		return {"x": val.x, "y": val.y, "z": val.z}
	if val is Color:
		return {"r": val.r, "g": val.g, "b": val.b, "a": val.a}
	if val is Rect2:
		return {"x": val.position.x, "y": val.position.y, "w": val.size.x, "h": val.size.y}
	if val is Rect2i:
		return {"x": val.position.x, "y": val.position.y, "w": val.size.x, "h": val.size.y}
	if val is Transform2D:
		return {"x": val.origin.x, "y": val.origin.y}
	if val is Transform3D:
		return {"x": val.origin.x, "y": val.origin.y, "z": val.origin.z}
	if val is Resource:
		return {"type": val.get_class(), "path": val.resource_path if val.resource_path else ""}
	if val is Node:
		return str(val.get_path())
	return val


# ─── Shared tree traversal ──────────────────────────────────────────────────
# Callback receives each node; return true to include in results.
func _traverse_tree(callback: Callable, opts: Dictionary = {}) -> Array:
	var root_node: Node = opts.get("root", get_tree().root) as Node
	var max_results: int = int(opts.get("max_results", 500))
	var max_visited: int = int(opts.get("max_visited", 5000))
	if root_node == null:
		return []
	var results: Array = []
	var stack: Array[Node] = [root_node]
	var visited: int = 0
	while stack.size() > 0 and results.size() < max_results and visited < max_visited:
		var node: Node = stack.pop_back()
		if node == null:
			continue
		visited += 1
		if callback.call(node):
			results.append(node)
		var children := node.get_children()
		for i in range(children.size() - 1, -1, -1):
			stack.append(children[i])
	return results




func _is_blocked_property(prop: String) -> bool:
	if prop.begins_with("_"):
		return true
	if prop.begins_with("theme_override"):
		return true
	if prop in BLOCKED_PROPERTIES:
		return true
	if "." in prop:
		for segment in prop.split("."):
			if segment == "" or segment.begins_with("_") or segment in BLOCKED_PROPERTIES:
				return true
	if ":" in prop or "/" in prop:
		return true
	return false


# ─── Input simulation ──────────────────────────────────────────────────────

func _cmd_send_key(params: Dictionary) -> Variant:
	var key: String = str(params.get("key", ""))
	var pressed: bool = params.get("pressed", true)
	var keycode: int = _key_from_string(key)
	if keycode == 0:
		return {"error": {"code": -1, "message": "Unknown key: %s" % key}}
	var event := InputEventKey.new()
	event.keycode = keycode
	event.pressed = pressed
	Input.parse_input_event(event)
	return {"success": true, "key": key}


func _key_from_string(key: String) -> int:
	var mapping := {
		"enter": KEY_ENTER, "escape": KEY_ESCAPE, "space": KEY_SPACE,
		"tab": KEY_TAB, "shift": KEY_SHIFT, "ctrl": KEY_CTRL, "alt": KEY_ALT,
		"up": KEY_UP, "down": KEY_DOWN, "left": KEY_LEFT, "right": KEY_RIGHT,
		"a": KEY_A, "b": KEY_B, "c": KEY_C, "d": KEY_D, "e": KEY_E,
		"f": KEY_F, "g": KEY_G, "h": KEY_H, "i": KEY_I, "j": KEY_J,
		"k": KEY_K, "l": KEY_L, "m": KEY_M, "n": KEY_N, "o": KEY_O,
		"p": KEY_P, "q": KEY_Q, "r": KEY_R, "s": KEY_S, "t": KEY_T,
		"u": KEY_U, "v": KEY_V, "w": KEY_W, "x": KEY_X, "y": KEY_Y, "z": KEY_Z,
		"0": KEY_0, "1": KEY_1, "2": KEY_2, "3": KEY_3, "4": KEY_4,
		"5": KEY_5, "6": KEY_6, "7": KEY_7, "8": KEY_8, "9": KEY_9,
	}
	var upper := key.to_lower()
	if mapping.has(upper):
		return mapping[upper]
	return 0


func _cmd_send_mouse_click(params: Dictionary) -> Variant:
	var x: float = float(params.get("x", 0))
	var y: float = float(params.get("y", 0))
	var button: int = int(params.get("button", 1))
	var pressed: bool = params.get("pressed", true)
	var event := InputEventMouseButton.new()
	event.position = Vector2(x, y)
	event.button_index = button
	event.pressed = pressed
	event.global_position = Vector2(x, y)
	Input.parse_input_event(event)
	return {"success": true, "x": x, "y": y, "button": button}


func _cmd_send_mouse_move(params: Dictionary) -> Variant:
	var x: float = float(params.get("x", 0))
	var y: float = float(params.get("y", 0))
	var event := InputEventMouseMotion.new()
	event.position = Vector2(x, y)
	event.global_position = Vector2(x, y)
	Input.parse_input_event(event)
	return {"success": true, "x": x, "y": y}


func _cmd_send_text(params: Dictionary) -> Variant:
	var text: String = str(params.get("text", ""))
	if text.length() > 1000:
		return {"error": {"code": -1, "message": "Text too long: %d chars (max 1000)" % text.length()}}
	for ch in text:
		var event := InputEventKey.new()
		event.unicode = ch.unicode_at(0)
		event.pressed = true
		Input.parse_input_event(event)
		event.pressed = false
		Input.parse_input_event(event)
	return {"success": true, "characters": text.length()}


# ─── Wait commands (sync check, not async) ──────────────────────────────────

func _cmd_wait_for_node(params: Dictionary) -> Variant:
	var path: String = str(params.get("path", ""))
	var node := get_node_or_null(path)
	return {"exists": node != null, "path": path}


func _cmd_wait_for_property(params: Dictionary) -> Variant:
	var path: String = str(params.get("path", ""))
	var prop: String = str(params.get("property", ""))
	var expected: Variant = params.get("value")
	var node := get_node_or_null(path)
	if node == null:
		return {"error": {"code": -1, "message": "Node not found: %s" % path}}
	if _is_blocked_property(prop):
		return {"error": {"code": -2, "message": "Blocked property: %s" % prop}}
	var current: Variant = node.get(prop)
	# I-07: Safety check on read value to prevent leaking complex types (Resource, Script, etc.)
	if not _is_safe_value(current):
		return {"match": false, "property": prop, "current": "<unsupported type>", "expected": _jsonify(expected)}
	var match_result: bool = str(current) == str(expected)
	return {"match": match_result, "property": prop, "current": _jsonify(current), "expected": _jsonify(expected)}


# ─── Visual ─────────────────────────────────────────────────────────────────

func _cmd_take_screenshot(params: Dictionary) -> Variant:
	var path: String = str(params.get("path", "user://mcp_screenshot.png"))
	# Normalize and check traversal
	var clean_path: String = path.replace("\\", "/").uri_decode()
	if not clean_path.begins_with("user://"):
		return {"error": {"code": -1, "message": "Screenshot path must start with user://"}}
	# Check each segment for traversal
	for segment in clean_path.substr(8).split("/"):
		if segment == ".." or segment == ".":
			return {"error": {"code": -1, "message": "Screenshot path contains directory traversal"}}
	var viewport := get_viewport()
	var img := viewport.get_texture().get_image()
	var err := img.save_png(clean_path)
	if err != OK:
		return {"error": {"code": -2, "message": "Failed to save screenshot: error %d" % err}}
	return {"success": true, "path": clean_path, "size": {"x": img.get_width(), "y": img.get_height()}}


func _cmd_get_performance() -> Dictionary:
	return {
		"fps": Performance.get_monitor(Performance.TIME_FPS),
		"frame_time": Performance.get_monitor(Performance.TIME_PROCESS),
		"physics_time": Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS),
		"object_count": Performance.get_monitor(Performance.OBJECT_COUNT),
		"node_count": Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
	}


func _cmd_get_viewport_info() -> Dictionary:
	var vp := get_viewport()
	return {
		"size": {"x": vp.get_visible_rect().size.x, "y": vp.get_visible_rect().size.y},
	}


# ─── Recording ───────────────────────────────────────────────────────────────

func _cmd_recording_start() -> Variant:
	if _recording:
		return {"error": {"code": -1, "message": "Recording already in progress"}}
	_recording = true
	_recorded_events = []
	_record_start_time = Time.get_ticks_msec()
	return {"status": "recording", "message": "Input events are being captured"}


func _cmd_recording_stop() -> Variant:
	if not _recording:
		return {"error": {"code": -1, "message": "No recording in progress"}}
	_recording = false
	var duration_ms: int = Time.get_ticks_msec() - _record_start_time
	var events: Array = _recorded_events.duplicate()
	_recorded_events = []
	return {"version": 1, "duration_ms": duration_ms, "events": events, "event_count": events.size()}


# ─── Monitor commands ───────────────────────────────────────────────────

func _cmd_monitor_start(params: Dictionary, pid: int) -> Variant:
	var node_path: String = str(params.get("node_path", ""))
	var properties = params.get("properties", [])
	var interval: int = int(params.get("interval_frames", 10))

	if node_path == "":
		return {"error": {"code": -1, "message": "node_path is required"}}
	if not properties is Array or properties.size() == 0:
		return {"error": {"code": -2, "message": "properties must be a non-empty array"}}
	if properties.size() > MONITOR_MAX_PROPERTIES:
		return {"error": {"code": -6, "message": "Too many properties (%d, max %d)" % [properties.size(), MONITOR_MAX_PROPERTIES]}}
	if interval < 1:
		interval = 1
	if interval > 300:
		interval = 300

	var node := get_node_or_null(node_path)
	if node == null:
		return {"error": {"code": -3, "message": "Node not found: %s" % node_path}}

	# I-11: filter out blocked property names
	var filtered_props: Array = []
	for prop in properties:
		if not _is_blocked_property(str(prop)):
			filtered_props.append(prop)
	if filtered_props.size() == 0:
		return {"error": {"code": -7, "message": "All requested properties are blocked"}}

	var previous_samples: Array = []
	if _monitor_states.has(pid) and _monitor_states[pid].get("active", false):
		previous_samples = (_monitor_states[pid]["samples"] as Array).duplicate(true)

	_monitor_states[pid] = {
		"active": true,
		"node_path": node_path,
		"properties": filtered_props,
		"interval_frames": interval,
		"frame_counter": 0,
		"samples": [],
		"max_samples": MONITOR_DEFAULT_MAX_SAMPLES,
	}

	var result_dict: Dictionary = {
		"monitoring": true,
		"node_path": node_path,
		"properties": properties,
		"interval_frames": interval,
	}
	if previous_samples.size() > 0:
		result_dict["previous_samples"] = previous_samples
	return result_dict


func _cmd_monitor_stop(pid: int) -> Variant:
	if not _monitor_states.has(pid):
		return {"monitoring": false, "samples": [], "sample_count": 0, "message": "No active monitor for this peer"}
	var ms: Dictionary = _monitor_states[pid]
	if not ms.get("active", false):
		# I-03: monitor may have auto-stopped; return reason + samples
		var old_samples := (ms["samples"] as Array).duplicate(true)
		var reason := ""
		if old_samples.size() > 0:
			var last: Dictionary = old_samples[-1]
			if last.has("stopped_reason"):
				reason = last["stopped_reason"]
		var msg := "No active monitor"
		if reason != "":
			msg = "Monitor stopped: %s" % reason
		_monitor_states.erase(pid)
		return {"monitoring": false, "samples": old_samples, "sample_count": old_samples.size(), "stopped_reason": reason, "message": msg}
	ms["active"] = false
	var samples := (ms["samples"] as Array).duplicate(true)
	var duration := 0.0
	if samples.size() > 0:
		duration = samples[samples.size() - 1].get("time", 0.0) - samples[0].get("time", 0.0)
	# I-03: extract stopped_reason from last sample
	var stopped_reason: String = ""
	if samples.size() > 0:
		var last: Dictionary = samples[-1]
		if last.has("stopped_reason"):
			stopped_reason = last["stopped_reason"]
	var result_dict: Dictionary = {
		"monitoring": false,
		"samples": samples,
		"sample_count": samples.size(),
		"total_frames": Engine.get_process_frames(),
		"duration_seconds": duration,
	}
	if stopped_reason != "":
		result_dict["stopped_reason"] = stopped_reason
	_monitor_states.erase(pid)
	return result_dict


func _cmd_monitor_poll(pid: int) -> Variant:
	if not _monitor_states.has(pid):
		return {"monitoring": false, "samples": [], "message": "No active monitor for this peer"}
	var ms: Dictionary = _monitor_states[pid]
	if not ms.get("active", false):
		# I-03: return last stopped_reason
		var last_reason: String = ""
		if (ms["samples"] as Array).size() > 0:
			var last: Dictionary = (ms["samples"] as Array)[-1]
			if last.has("stopped_reason"):
				last_reason = last["stopped_reason"]
		var msg := "No active monitor"
		if last_reason != "":
			msg = "Monitor stopped: %s" % last_reason
		return {"monitoring": false, "samples": [], "stopped_reason": last_reason, "message": msg}
	var samples := (ms["samples"] as Array).duplicate(true)
	return {
		"monitoring": true,
		"node_path": str(ms["node_path"]),
		"samples": samples,
		"sample_count": samples.size(),
	}


# --- Signal watch commands (C-07: per-peer) ---

func _on_watched_signal_0(pid: int) -> void:
	_record_watch_event([], pid)

func _on_watched_signal_1(arg0: Variant, pid: int) -> void:
	_record_watch_event([arg0], pid)

func _on_watched_signal_2(arg0: Variant, arg1: Variant, pid: int) -> void:
	_record_watch_event([arg0, arg1], pid)

func _on_watched_signal_3(arg0: Variant, arg1: Variant, arg2: Variant, pid: int) -> void:
	_record_watch_event([arg0, arg1, arg2], pid)

func _on_watched_signal_4(arg0: Variant, arg1: Variant, arg2: Variant, arg3: Variant, pid: int) -> void:
	_record_watch_event([arg0, arg1, arg2, arg3], pid)


func _record_watch_event(raw_args: Array, peer_id: int) -> void:
	if not _watch_states.has(peer_id):
		return
	var ws: Dictionary = _watch_states[peer_id]
	if not ws.get("active", false):
		return
	var safe_args: Array = []
	for arg in raw_args:
		safe_args.append(_jsonify(arg))
	(ws["events"] as Array).append({
		"frame": Engine.get_process_frames(),
		"time": Time.get_ticks_msec() / 1000.0,
		"args": safe_args,
	})
	if (ws["events"] as Array).size() >= int(ws["max_events"]):
		_do_watch_disconnect(peer_id)
		ws["active"] = false


func _do_watch_disconnect(peer_id: int) -> void:
	if not _watch_states.has(peer_id):
		return
	var ws: Dictionary = _watch_states[peer_id]
	if not ws.get("connected", false):
		return
	var node := get_node_or_null(str(ws.get("node_path", "")))
	if node != null:
		var callable := _get_watch_callable(peer_id)
		var signal_name: String = str(ws.get("signal_name", ""))
		if node.has_signal(signal_name) and node.is_connected(signal_name, callable):
			node.disconnect(signal_name, callable)
	ws["connected"] = false


func _get_watch_callable(peer_id: int) -> Callable:
	var ws: Dictionary = _watch_states.get(peer_id, {})
	var sig_list := []
	var node := get_node_or_null(str(ws.get("node_path", "")))
	var signal_name: String = str(ws.get("signal_name", ""))
	if node != null and node.has_signal(signal_name):
		sig_list = node.get_signal_list()
	for sig_info in sig_list:
		if sig_info.get("name", "") == signal_name:
			var arg_count: int = sig_info.get("args", []).size()
			match arg_count:
				0: return _on_watched_signal_0.bind(peer_id)
				1: return _on_watched_signal_1.bind(peer_id)
				2: return _on_watched_signal_2.bind(peer_id)
				3: return _on_watched_signal_3.bind(peer_id)
				4: return _on_watched_signal_4.bind(peer_id)
				_: return _on_watched_signal_0.bind(peer_id)
	return _on_watched_signal_0.bind(peer_id)


func _cmd_watch_start(params: Dictionary, pid: int) -> Variant:
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

	# If this peer already watching, disconnect first
	if _watch_states.has(pid) and _watch_states[pid].get("active", false):
		_do_watch_disconnect(pid)

	var previous_events: Array = []
	if _watch_states.has(pid) and (_watch_states[pid].get("events") as Array).size() > 0:
		previous_events = (_watch_states[pid]["events"] as Array).duplicate(true)

	# Set state before resolving callable
	_watch_states[pid] = {
		"active": false,
		"node_path": node_path,
		"signal_name": signal_name,
		"events": [],
		"max_events": max_events,
		"connected": false,
	}

	var callable := _get_watch_callable(pid)
	var err := node.connect(signal_name, callable)
	if err != OK:
		_watch_states.erase(pid)
		return {"error": {"code": -5, "message": "Failed to connect signal: %s (error %d)" % [signal_name, err]}}

	_watch_states[pid]["active"] = true
	_watch_states[pid]["connected"] = true

	var result_dict: Dictionary = {
		"watching": true,
		"node_path": node_path,
		"signal_name": signal_name,
		"max_events": max_events,
	}
	if previous_events.size() > 0:
		result_dict["previous_events"] = previous_events
	return result_dict


func _cmd_watch_stop(pid: int) -> Variant:
	if not _watch_states.has(pid):
		return {"watching": false, "events": [], "event_count": 0, "message": "No active watch for this peer"}
	var ws: Dictionary = _watch_states[pid]
	_do_watch_disconnect(pid)
	ws["active"] = false
	var events := (ws["events"] as Array).duplicate(true)
	var duration := 0.0
	if events.size() > 0:
		duration = events[events.size() - 1].get("time", 0.0) - events[0].get("time", 0.0)
	var result_dict: Dictionary = {
		"watching": false,
		"events": events,
		"event_count": events.size(),
		"node_path": str(ws.get("node_path", "")),
		"signal_name": str(ws.get("signal_name", "")),
		"duration_seconds": duration,
	}
	_watch_states.erase(pid)
	return result_dict


func _cmd_watch_poll(pid: int) -> Variant:
	if not _watch_states.has(pid) or not _watch_states[pid].get("active", false):
		return {"watching": false, "events": [], "message": "No active watch for this peer"}
	var ws: Dictionary = _watch_states[pid]
	var events := (ws["events"] as Array).duplicate(true)
	return {
		"watching": true,
		"node_path": str(ws.get("node_path", "")),
		"signal_name": str(ws.get("signal_name", "")),
		"events": events,
		"event_count": events.size(),
	}


# C-07: cleanup per-peer state on disconnect
func _cleanup_peer_state(pid: int) -> void:
	if _watch_states.has(pid):
		_do_watch_disconnect(pid)
		_watch_states.erase(pid)
	if _monitor_states.has(pid):
		_monitor_states.erase(pid)


# ─── UI discovery commands ──────────────────────────────────────────────

func _extract_ui_data(ctrl: Control) -> Dictionary:
	var data: Dictionary = {
		"path": str(ctrl.get_path()),
		"type": ctrl.get_class(),
		"visible": ctrl.visible,
		"position": {"x": ctrl.position.x, "y": ctrl.position.y},
		"size": {"x": ctrl.size.x, "y": ctrl.size.y},
		"center": {"x": ctrl.position.x + ctrl.size.x / 2.0, "y": ctrl.position.y + ctrl.size.y / 2.0},
	}
	if ctrl is BaseButton:
		data["text"] = str(ctrl.get("text")) if ctrl.get("text") != null else ""
		data["disabled"] = ctrl.disabled
	elif ctrl is Label:
		data["text"] = ctrl.text
	elif ctrl is Range:
		data["value"] = ctrl.value
		data["min_value"] = ctrl.min_value
		data["max_value"] = ctrl.max_value
		if ctrl is SpinBox:
			data["editable"] = ctrl.editable
	elif ctrl is LineEdit:
		data["text"] = ctrl.text
		data["editable"] = ctrl.editable
		data["max_length"] = ctrl.max_length
	elif ctrl is OptionButton:
		data["text"] = ctrl.text
		data["item_count"] = ctrl.item_count
		var items: Array = []
		for i in range(ctrl.item_count):
			items.append(ctrl.get_item_text(i))
		data["items"] = items
	elif ctrl is ItemList:
		data["item_count"] = ctrl.item_count
	return data


func _cmd_find_ui_elements(params: Dictionary) -> Variant:
	var pattern: String = str(params.get("pattern", ""))
	var type_filter: String = str(params.get("type", ""))
	var visible_only: bool = params.get("visible_only", true)
	var max_results: int = int(params.get("limit", 200))
	if max_results > 500:
		max_results = 500

	# A-06: 复用 _traverse_tree + callback 过滤
	var results: Array = _traverse_tree(
		func(node: Node) -> bool:
			if not node is Control:
				return false
			var ctrl: Control = node as Control
			if visible_only and not ctrl.visible:
				return false
			if pattern != "":
				var text_to_match := ""
				if "text" in ctrl:
					text_to_match = str(ctrl.get("text"))
				if not ctrl.name.match(pattern) and not text_to_match.match(pattern):
					return false
			if type_filter != "" and not ctrl.is_class(type_filter):
				return false
			return true,
		{"max_results": max_results, "max_visited": 5000}
	)

	var extracted: Array = []
	for node in results:
		extracted.append(_extract_ui_data(node as Control))
	return {"elements": extracted, "count": extracted.size()}


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
		var stack: Array = [get_tree().root]
		while stack.size() > 0:
			var node: Node = stack.pop_back()
			# Traverse children first so disabled parents don't block child discovery
			for child in node.get_children():
				stack.append(child)
			if node is BaseButton:
				var btn: BaseButton = node as BaseButton
				if btn.disabled:
					continue  # I-02: skip disabled buttons
				var btn_text := str(btn.get("text")) if btn.get("text") != null else ""
				if btn_text == text and btn.visible:
					target = btn
					break
		if target == null:
			return {"error": {"code": -3, "message": "No visible Button with text \"%s\" found" % text}}
	else:
		return {"error": {"code": -4, "message": "Either text or path is required"}}

	# I-02: skip disabled buttons
	if target.disabled:
		return {"error": {"code": -5, "message": "Button is disabled: %s" % str(target.get_path())}}

	target.emit_signal("pressed")
	return {
		"clicked": true,
		"button_path": str(target.get_path()),
		"button_text": str(target.get("text")) if target.get("text") != null else "",
	}


func _input(event: InputEvent) -> void:
	if not _recording:
		return
	var time_ms: int = Time.get_ticks_msec() - _record_start_time
	if event is InputEventKey:
		_recorded_events.append({"type": "key", "keycode": event.keycode, "pressed": event.pressed, "shift": event.shift_pressed, "ctrl": event.ctrl_pressed, "alt": event.alt_pressed, "time_offset": time_ms})
	elif event is InputEventMouseButton:
		_recorded_events.append({"type": "mouse_click", "position": [event.position.x, event.position.y], "button": event.button_index, "pressed": event.pressed, "time_offset": time_ms})
	elif event is InputEventMouseMotion:
		_recorded_events.append({"type": "mouse_move", "position": [event.position.x, event.position.y], "time_offset": time_ms})


## 内联安全类型检查（替代 SafeValues 类引用，autoload 环境无法引用 safe_values.gd）
## 覆盖 JSON 反序列化可产生的类型 + StringName（GDScript 内部调用）
const _MAX_SAFE_DEPTH := 10

func _is_safe_value(value: Variant, depth: int = 0) -> bool:
	if value == null:
		return true
	if value is bool or value is int or value is float or value is String or value is StringName:
		return true
	# Keep in sync with safe_values.gd — geometric + PackedArray types
	if value is Vector2 or value is Vector2i or value is Vector3 or value is Vector3i:
		return true
	if value is Color or value is Rect2 or value is Rect2i:
		return true
	if value is Transform2D or value is Transform3D or value is Basis or value is Quaternion:
		return true
	if value is Plane or value is AABB:
		return true
	if value is PackedByteArray or value is PackedInt32Array or value is PackedInt64Array:
		return true
	if value is PackedFloat32Array or value is PackedFloat64Array or value is PackedStringArray:
		return true
	if value is PackedVector2Array or value is PackedVector3Array or value is PackedColorArray:
		return true
	if depth >= _MAX_SAFE_DEPTH:
		return false
	if value is Array:
		for item in value:
			if not _is_safe_value(item, depth + 1):
				return false
		return true
	if value is Dictionary:
		for key in value:
			if not _is_safe_value(key, depth + 1) or not _is_safe_value(value[key], depth + 1):
				return false
		return true
	return false
