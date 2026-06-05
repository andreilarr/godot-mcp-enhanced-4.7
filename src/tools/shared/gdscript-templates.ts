// GDScript template constants shared across tool modules.
// Uses readonly string[] to prevent JS variable interpolation into GDScript code.

export const MARKER_RESULT = '___MCP_RESULT___';
export const MARKER_ERROR = '___MCP_ERROR___';

export const TYPE_WHITELIST = [
  'Node3D', 'MeshInstance3D', 'StaticBody3D', 'RigidBody3D',
  'CharacterBody3D', 'Camera3D', 'Light3D', 'DirectionalLight3D',
  'OmniLight3D', 'SpotLight3D', 'CollisionShape3D', 'RayCast3D',
  'Area3D', 'Marker3D', 'PathFollow3D', 'VisibleOnScreenNotifier3D',
] as const;

/** _mcp_get_root() — 获取场景根节点（缓存） */
export const GD_MCP_GET_ROOT: readonly string[] = [
  'func _mcp_get_root() -> Node:',
  '\tif _mcp_root != null:',
  '\t\treturn _mcp_root',
  '\tif root != null:',
  '\t\t_mcp_root = root',
  '\t\treturn _mcp_root',
  '\tvar ml: Variant = Engine.get_main_loop()',
  '\tif ml != null and ml is SceneTree and ml.root != null:',
  '\t\t_mcp_root = ml.root',
  '\t\treturn _mcp_root',
  '\treturn null',
];

/** _mcp_get_node() — 按路径获取节点（精确版：只在根节点上下文跳过 "root"） */
export const GD_MCP_GET_NODE: readonly string[] = [
  'func _mcp_get_node(path: NodePath) -> Node:',
  '\tvar _p: String = str(path)',
  '\tif _p.begins_with("/"):',
  '\t\t_p = _p.substr(1)',
  '\tvar _r: Node = _mcp_get_root()',
  '\tif _r == null:',
  '\t\treturn null',
  '\t# Fallback: root.get_node() may fail in headless _initialize()',
  '\tvar _node: Node = _r.get_node_or_null(_p)',
  '\tif _node != null:',
  '\t\treturn _node',
  '\t# Manual traversal for headless compatibility',
  '\tvar _parts: PackedStringArray = _p.split("/")',
  '\t_node = _r',
  '\tfor _part in _parts:',
  '\t\tif _part == "":',
  '\t\t\tcontinue',
  '\t\tvar _found: bool = false',
  '\t\tfor _ch in _node.get_children():',
  '\t\t\tif _ch.name == _part:',
  '\t\t\t\t_node = _ch',
  '\t\t\t\t_found = true',
  '\t\t\t\tbreak',
  '\t\tif not _found:',
  '\t\t\tif _part == "root" and _node == _r:',
  '\t\t\t\tcontinue',
  '\t\t\treturn null',
  '\treturn _node',
];

/** _mcp_load_main_scene() — 加载主场景 */
export const GD_MCP_LOAD_MAIN_SCENE: readonly string[] = [
  'func _mcp_load_main_scene() -> void:',
  '\tvar _r: Node = _mcp_get_root()',
  '\tif _r == null:',
  '\t\treturn',
  '\tvar _sp: Variant = ProjectSettings.get_setting("application/run/main_scene")',
  '\tif _sp != null and _sp != "":',
  '\t\tvar _sr = load(_sp)',
  '\t\tif _sr:',
  '\t\t\t_r.add_child(_sr.instantiate())',
];

/** _mcp_output() — 记录输出 */
export const GD_MCP_OUTPUT: readonly string[] = [
  'func _mcp_output(key: String, value: Variant) -> void:',
  '\t_mcp_outputs.append({"key": key, "value": str(value)})',
];

export const SCENE_TREE_HEADER = [
  'extends SceneTree',
  '',
  'var _mcp_outputs: Array = []',
  'var _mcp_root: Node = null',
  'var _mcp_scene_instance: Node = null',
  '',
  ...GD_MCP_GET_ROOT,
  '',
  ...GD_MCP_GET_NODE,
  '',
  ...GD_MCP_LOAD_MAIN_SCENE,
  '',
  // SCENE_TREE_HEADER 独有：场景加载和导航辅助
  'func _mcp_load_scene(sp: String) -> bool:',
  '	var _r: Node = _mcp_get_root()',
  '	if _r == null:',
  '		_mcp_output("error", "Scene root not available")',
  '		return false',
  '	if _mcp_scene_instance != null:',
  '		if _mcp_scene_instance.get_parent() != null:',
  '			_mcp_scene_instance.get_parent().remove_child(_mcp_scene_instance)',
  '		_mcp_scene_instance.queue_free()',
  '		_mcp_scene_instance = null',
  '	var _sr = load(sp)',
  '	if _sr == null:',
  '		_mcp_output("error", "Failed to load scene: " + sp)',
  '		return false',
  '	_mcp_scene_instance = _sr.instantiate()',
  '	_r.add_child(_mcp_scene_instance)',
  '	return true',
  '',
  'func _mcp_get_scene_node(path: String) -> Node:',
  '	# Search within loaded scene instance (avoids root/SceneName prefix issue)',
  '	if _mcp_scene_instance != null:',
  '		var _p: String = path',
  '		while _p.begins_with("/"):',
  '			_p = _p.substr(1)',
  '		# Strip leading "root/" or "root" prefix',
  '		if _p.begins_with("root/"):',
  '			_p = _p.substr(5)',
  '		elif _p == "root":',
  '			_p = ""',
  '		# Strip scene root name if present (e.g. "Main/UILayer/..." -> "UILayer/...")',
  '		if _p != "" and _mcp_scene_instance.name.length() > 0:',
  '			var _scene_name: String = _mcp_scene_instance.name + "/"',
  '			if _p.begins_with(_scene_name):',
  '				_p = _p.substr(_scene_name.length())',
  '			elif _p == _mcp_scene_instance.name:',
  '				_p = ""',
  '		if _p == "":',
  '			return _mcp_scene_instance',
  '		var _node: Node = _mcp_scene_instance.get_node_or_null(_p)',
  '		if _node != null:',
  '			return _node',
  '	# Fallback to global search',
  '	return _mcp_get_node(path)',
  '',
  ...GD_MCP_OUTPUT,
  '',
  'func _mcp_done() -> void:',
  '	print("' + MARKER_RESULT + '" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))',
  '	if Engine.get_main_loop() == self:',
  '		quit(0)',
].join('\n');
