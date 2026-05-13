extends Node

var _undo_manager: Node

func setup(undo_manager: Node) -> void:
	_undo_manager = undo_manager

func handle_add_node(params: Dictionary, request_id: int) -> Dictionary:
	var ei = Engine.get_singleton("EditorInterface") as EditorInterface
	var root = ei.get_edited_scene_root()
	if not root:
		return {"error": {"code": -32003, "message": "No scene loaded"}}

	var node_type: String = params.get("node_type", "Node")
	var node_name: String = params.get("node_name", "NewNode")
	var parent_path: String = params.get("parent_node_path", "")

	var parent_node: Node = root
	if not parent_path.is_empty():
		parent_node = root.get_node(parent_path)
		if not parent_node:
			return {"error": {"code": -32002, "message": "Parent not found: %s" % parent_path}}

	var cls = ClassDB.instantiate(node_type)
	if not cls:
		return {"error": {"code": -32000, "message": "Cannot instantiate: %s" % node_type}}
	cls.name = node_name

	_undo_manager.create_action(request_id,
		[{"target": parent_node, "method": "add_child", "args": [cls]},
		 {"target": cls, "method": "set_owner", "args": [root]}],
		[{"target": parent_node, "method": "remove_child", "args": [cls]}]
	)
	return {"result": {"node_path": str(cls.get_path()), "status": "created"}}
