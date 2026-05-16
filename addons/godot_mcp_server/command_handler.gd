extends Node

var _scene_commands: Node
var _node_commands: Node
var _test_commands: Node
var _export_commands: Node
var _particle_commands: Node
var _nav_commands: Node
var _animtree_commands: Node
var _sync_commands: Node
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

	_test_commands = preload("commands/test_commands.gd").new()
	_test_commands.setup(plugin)
	add_child(_test_commands)

	_export_commands = preload("commands/export_commands.gd").new()
	_export_commands.setup(plugin)
	add_child(_export_commands)

	_particle_commands = preload("commands/particle_commands.gd").new()
	_particle_commands.setup(plugin)
	add_child(_particle_commands)

	_nav_commands = preload("commands/nav_commands.gd").new()
	_nav_commands.setup(plugin)
	add_child(_nav_commands)

	_animtree_commands = preload("commands/animtree_commands.gd").new()
	_animtree_commands.setup(plugin)
	add_child(_animtree_commands)

	_sync_commands = preload("commands/sync_commands.gd").new()
	_sync_commands.setup(self)
	add_child(_sync_commands)

func cleanup() -> void:
	if _sync_commands:
		_sync_commands.cleanup()

func handle(method: String, params: Dictionary, request_id: int) -> Dictionary:
	match method:
		"open_scene":
			return _scene_commands.handle_open_scene(params)
		"save_scene":
			return _scene_commands.handle_save_scene(params)
		"instance_scene":
			return _scene_commands.handle_instance_scene(params)
		"set_instance_property":
			return _scene_commands.handle_set_instance_property(params)
		"add_node":
			return _node_commands.handle_add_node(params, request_id)
		"test_assert":
			return _test_commands.handle_test_assert(params)
		"export_list_presets":
			return _export_commands.handle_export_list_presets(params)
		"export_get_preset":
			return _export_commands.handle_export_get_preset(params)
		"export_build":
			return _export_commands.handle_export_build(params)
		"particles_create":
			return _particle_commands.handle_particles_create(params, request_id)
		"particles_set_emission":
			return _particle_commands.handle_particles_set_emission(params)
		"particles_set_process":
			return _particle_commands.handle_particles_set_process(params)
		"particles_load_preset":
			return _particle_commands.handle_particles_load_preset(params)
		"particles_set_material":
			return _particle_commands.handle_particles_set_material(params)
		"nav_create_region":
			return _nav_commands.handle_nav_create_region(params, request_id)
		"nav_bake_mesh":
			return _nav_commands.handle_nav_bake_mesh(params)
		"nav_create_agent":
			return _nav_commands.handle_nav_create_agent(params, request_id)
		"nav_set_params":
			return _nav_commands.handle_nav_set_params(params)
		"nav_create_link":
			return _nav_commands.handle_nav_create_link(params, request_id)
		"animtree_create":
			return _animtree_commands.handle_animtree_create(params, request_id)
		"animtree_add_state":
			return _animtree_commands.handle_animtree_add_state(params)
		"animtree_add_transition":
			return _animtree_commands.handle_animtree_add_transition(params)
		"animtree_set_blend":
			return _animtree_commands.handle_animtree_set_blend(params)
		"animtree_play":
			return _animtree_commands.handle_animtree_play(params)
		"editor_sync_start":
			return _sync_commands.start_sync()
		"editor_sync_stop":
			return _sync_commands.stop_sync()
		"editor_get_scene_tree":
			return _sync_commands.get_scene_tree()
		_:
			return {"error": {"code": -32601, "message": "Unknown method: %s" % method}}


func send_notification(method: String, params: Dictionary) -> void:
	# Forward to plugin's WebSocket/TCP notification channel
	var plugin = get_parent()
	if plugin and plugin.has_method("send_mcp_notification"):
		plugin.send_mcp_notification(method, params)
