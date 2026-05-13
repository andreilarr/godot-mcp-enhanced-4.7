extends Node

var _scene_commands: Node
var _node_commands: Node
var _undo_manager: Node

func setup(plugin: EditorPlugin) -> void:
	_undo_manager = preload("undo_manager.gd").new()
	_undo_manager.setup(plugin)
	add_child(_undo_manager)

	_scene_commands = preload("commands/scene_commands.gd").new()
	add_child(_scene_commands)

	_node_commands = preload("commands/node_commands.gd").new()
	_node_commands.setup(_undo_manager)
	add_child(_node_commands)

func handle(method: String, params: Dictionary, request_id: int) -> Dictionary:
	match method:
		"open_scene":
			return _scene_commands.handle_open_scene(params)
		"save_scene":
			return _scene_commands.handle_save_scene(params)
		"add_node":
			return _node_commands.handle_add_node(params, request_id)
		_:
			return {"error": {"code": -32601, "message": "Unknown method: %s" % method}}
