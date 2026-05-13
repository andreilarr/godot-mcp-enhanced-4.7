extends Node

var _plugin: EditorPlugin

func setup(plugin: EditorPlugin) -> void:
	_plugin = plugin

func create_action(request_id: int, do_methods: Array, undo_methods: Array) -> void:
	var undo_redo = _plugin.get_undo_redo()
	undo_redo.create_action("MCP: op_%d" % request_id)
	for m in do_methods:
		undo_redo.add_do_method(m.target, m.method, m.args)
	for m in undo_methods:
		undo_redo.add_undo_method(m.target, m.method, m.args)
	undo_redo.commit_action()
