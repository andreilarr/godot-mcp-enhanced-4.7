extends Node

# JSON-RPC error code 分配表(I-2,sync 模块专属):
#   -32001 SYNC_ALREADY_ACTIVE   -32002 SYNC_NOT_ACTIVE   -32003 Not in scene tree
#   -32004 NO_EDITOR              -32005 NO_SCENE
# 注:这些 code 与 mcp_bridge auth(-32001/-32002)及 animation/command_handler 的
# -32002~-32004 在数字上重叠,但 sync 走 Editor WebSocket 通道,bridge 走 TCP 通道,
# 由不同 executor 处理,客户端不会混淆。新增 sync 错误时优先复用本表。

var _command_handler: Node
var _syncing: bool = false
var _node_paths: Dictionary = {}  # { instance_id (int): { path: String, type: String } }


func setup(handler: Node) -> void:
	_command_handler = handler

# I-06: null-safe EditorInterface accessor
func _get_ei() -> EditorInterface:
	var ei = Engine.get_singleton("EditorInterface") as EditorInterface
	if ei == null:
		push_error("[MCP] EditorInterface not available")
	return ei


func start_sync() -> Dictionary:
	if _syncing:
		return {"error": {"code": -32001, "message": "Sync already active"}}
	var tree = get_tree()
	if tree == null or tree.root == null:
		return {"error": {"code": -32003, "message": "Not in scene tree"}}
	_syncing = true
	_node_paths.clear()
	_cache_paths_recursive(tree.root)
	tree.connect("node_added", _on_node_added)
	tree.connect("node_removed", _on_node_removed)
	return {"result": {"success": true}}


func stop_sync() -> Dictionary:
	if not _syncing:
		return {"error": {"code": -32002, "message": "Sync not active"}}
	_syncing = false
	var tree = get_tree()
	if tree != null:
		if tree.is_connected("node_added", _on_node_added):
			tree.disconnect("node_added", _on_node_added)
		if tree.is_connected("node_removed", _on_node_removed):
			tree.disconnect("node_removed", _on_node_removed)
	_node_paths.clear()
	return {"result": {"success": true}}


func get_scene_tree() -> Dictionary:
	var ei := _get_ei()
	if ei == null: return {"error": {"code": -32004, "message": "EditorInterface not available"}}
	var root = ei.get_edited_scene_root()
	if not root:
		return {"error": {"code": -32005, "message": "No current scene"}}
	return {"result": {"success": true, "tree": _serialize_tree(root, 0, 5)}}


func _cache_paths_recursive(node: Node, depth: int = 0) -> void:
	if node and depth < 50:
		_node_paths[node.get_instance_id()] = {
			"path": str(node.get_path()),
			"type": node.get_class()
		}
		for child in node.get_children():
			_cache_paths_recursive(child, depth + 1)


func _on_node_added(node: Node) -> void:
	var edited_root = CommandHelpers.get_edited_scene_root(_command_handler.get_plugin() if _command_handler and _command_handler.has_method("get_plugin") else null)
	if edited_root != null and not edited_root.is_ancestor_of(node) and node != edited_root:
		return
	var path = str(node.get_path())
	_node_paths[node.get_instance_id()] = {
		"path": path,
		"type": node.get_class()
	}
	if _command_handler and _command_handler.has_method("send_notification"):
		_command_handler.send_notification("scene_tree_changed", {
			"type": "node_added",
			"path": path,
			"node_type": node.get_class()
		})


func _on_node_removed(node: Node) -> void:
	var edited_root = CommandHelpers.get_edited_scene_root(_command_handler.get_plugin() if _command_handler and _command_handler.has_method("get_plugin") else null)
	if edited_root != null and not edited_root.is_ancestor_of(node) and node != edited_root:
		return
	var id = node.get_instance_id()
	var cached = _node_paths.get(id, {})
	var path = cached.get("path", "<removed>") if cached is Dictionary else "<removed>"
	var node_type = cached.get("type", "Node") if cached is Dictionary else "Node"
	_node_paths.erase(id)
	if _command_handler and _command_handler.has_method("send_notification"):
		_command_handler.send_notification("scene_tree_changed", {
			"type": "node_removed",
			"path": path,
			"node_type": node_type
		})


func cleanup() -> void:
	if _syncing:
		stop_sync()


func _serialize_tree(node: Node, depth: int, max_depth: int) -> Dictionary:
	var result = {
		"name": str(node.name),
		"type": node.get_class(),
		"path": str(node.get_path())
	}
	if depth < max_depth:
		var children = []
		for child in node.get_children():
			children.append(_serialize_tree(child, depth + 1, max_depth))
		result["children"] = children
	return result
