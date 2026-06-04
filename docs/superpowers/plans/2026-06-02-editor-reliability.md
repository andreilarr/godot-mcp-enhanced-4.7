# Editor 可靠性提升（文件冲突防护 + UndoRedo 覆盖）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在编辑器模式下添加文件冲突防护（防止静默覆盖用户正在编辑的文件）和 UndoRedo 覆盖（使 MCP 操作可通过 Ctrl+Z 撤销）。

**Architecture:** 在 GDScript 插件侧（`addons/godot_mcp_server/`）新增 `editor_guards.gd` 工具模块提供文件冲突检测，扩展现有 `undo_manager.gd` 支持 property 和 reference 操作，然后逐个命令模块接入。

**Tech Stack:** GDScript 4.x（Godot 编辑器插件），EditorUndoRedoManager API，EditorInterface API

---

## File Structure

| 操作 | 文件 | 职责 |
|------|------|------|
| **Create** | `addons/godot_mcp_server/editor_guards.gd` | 文件冲突守卫（guard_offline_scene_save、guard_text_resource_write） |
| **Modify** | `addons/godot_mcp_server/undo_manager.gd` | 扩展支持 add_do_property、add_undo_property、add_do_reference、add_undo_reference |
| **Modify** | `addons/godot_mcp_server/command_handler.gd` | 注入 editor_guards 到需要的命令模块 |
| **Modify** | `addons/godot_mcp_server/commands/scene_commands.gd` | 接入文件冲突守卫 + UndoRedo |
| **Modify** | `addons/godot_mcp_server/commands/animation_commands.gd` | 接入 UndoRedo（track/keyframe 操作） |
| **Modify** | `addons/godot_mcp_server/commands/node_commands.gd` | 补充 add_do_reference 防止 GC |

---

## Task 1: 创建 editor_guards.gd 工具模块

**Files:**
- Create: `addons/godot_mcp_server/editor_guards.gd`

- [ ] **Step 1: 创建 editor_guards.gd**

```gdscript
# addons/godot_mcp_server/editor_guards.gd
# 文件冲突守卫 — 防止 MCP 静默覆盖编辑器中打开的文件
extends Node

var _plugin: EditorPlugin

func setup(plugin: EditorPlugin) -> void:
	_plugin = plugin


func get_open_scene_paths() -> Array:
	var paths: Array = []
	if _plugin == null:
		return paths
	var ei: EditorInterface = _plugin.get_editor_interface()
	if ei == null:
		return paths
	var open_scenes: PackedStringArray = ei.get_open_scenes()
	for scene_path: String in open_scenes:
		var normalized: String = _normalize_path(scene_path)
		if not normalized.is_empty() and normalized not in paths:
			paths.append(normalized)
	# 也包含当前活跃场景
	var root: Node = ei.get_edited_scene_root()
	if root != null and not root.scene_file_path.is_empty():
		var active: String = _normalize_path(root.scene_file_path)
		if active not in paths:
			paths.append(active)
	return paths


func is_scene_path_open(path: String) -> bool:
	var normalized: String = _normalize_path(path)
	if normalized.is_empty():
		return false
	return normalized in get_open_scene_paths()


func is_active_scene_path(path: String) -> bool:
	if _plugin == null:
		return false
	var ei: EditorInterface = _plugin.get_editor_interface()
	var root: Node = ei.get_edited_scene_root()
	if root == null:
		return false
	return _normalize_path(root.scene_file_path) == _normalize_path(path)


func guard_offline_scene_save(path: String) -> Dictionary:
	"""检查场景文件是否在编辑器中打开，如果打开则返回错误阻止离线保存。"""
	var normalized: String = _normalize_path(path)
	if not _is_scene_resource_path(normalized):
		return {}
	if is_scene_path_open(normalized):
		return {
			"error": {
				"code": -32009,
				"message": "Refusing to save open scene '%s' outside the Godot editor state" % normalized,
				"data": {
					"path": normalized,
					"open_scenes": get_open_scene_paths(),
					"suggestion": "Use live editor changes plus save_scene, or close the scene before offline edits."
				}
			}
		}
	return {}


func guard_save_inactive_open_scene(path: String) -> Dictionary:
	"""检查是否在从活跃场景保存另一个已打开的非活跃场景。"""
	var normalized: String = _normalize_path(path)
	if is_scene_path_open(normalized) and not is_active_scene_path(normalized):
		return {
			"error": {
				"code": -32009,
				"message": "Refusing to save inactive open scene '%s' from the active editor scene" % normalized,
				"data": {
					"path": normalized,
					"suggestion": "Open the target scene tab before saving it, or close it first."
				}
			}
		}
	return {}


func guard_text_resource_write(path: String, force: bool = false) -> Dictionary:
	"""检查脚本/着色器是否在编辑器脚本编辑器中打开。"""
	if force:
		return {}
	if not _is_text_resource_path(path):
		return {}
	var target: String = _normalize_path(path)
	if target.is_empty():
		return {}
	# 检查着色器缓存
	if _is_shader_resource_path(target):
		if ResourceLoader.has_cached(target):
			return {
				"error": {
					"code": -32009,
					"message": "Refusing to write open shader resource '%s'" % target,
					"data": {"suggestion": "Close the file in Godot's shader editor or pass force=true."}
				}
			}
		return {}
	# 检查脚本编辑器
	if _plugin == null:
		return {}
	var ei: EditorInterface = _plugin.get_editor_interface()
	var script_editor = ei.get_script_editor()
	if script_editor == null:
		return {}
	for open_resource in script_editor.get_open_scripts():
		if open_resource is Resource:
			var resource_path: String = _normalize_path((open_resource as Resource).resource_path)
			if resource_path == target:
				return {
					"error": {
						"code": -32009,
						"message": "Refusing to write open text resource '%s' outside the script editor state" % target,
						"data": {"suggestion": "Close the file in Godot's script editor or pass force=true."}
					}
				}
	return {}


func _normalize_path(path: String) -> String:
	if path.is_empty():
		return ""
	if path.begins_with("res://") or path.begins_with("user://"):
		return path.simplify_path()
	# 尝试 localize
	if _plugin != null:
		var ei: EditorInterface = _plugin.get_editor_interface()
		if ei != null:
			var res_path: String = ProjectSettings.localize_path(path)
			if not res_path.is_empty():
				return res_path.simplify_path()
	return path.simplify_path()


func _is_scene_resource_path(path: String) -> bool:
	var ext: String = path.get_extension().to_lower()
	return ext == "tscn" or ext == "scn"


func _is_text_resource_path(path: String) -> bool:
	var ext: String = path.get_extension().to_lower()
	return ext == "gd" or ext == "gdshader" or ext == "gdshaderinc" or ext == "shader" or ext == "tscn"


func _is_shader_resource_path(path: String) -> bool:
	var ext: String = path.get_extension().to_lower()
	return ext == "gdshader" or ext == "gdshaderinc" or ext == "shader"
```

- [ ] **Step 2: 在 command_handler.gd 中注册 editor_guards**

在 `command_handler.gd` 的 `setup()` 方法中，在 `_undo_manager` 初始化之后添加：

```gdscript
# 在 var 声明区新增:
var _editor_guards: Node

# 在 setup() 中，_undo_manager 初始化之后添加:
_editor_guards = preload("editor_guards.gd").new()
_editor_guards.setup(plugin)
add_child(_editor_guards)
```

同时把 `_editor_guards` 传给需要它的命令模块。修改 `_scene_commands` 初始化：

```gdscript
_scene_commands = preload("commands/scene_commands.gd").new()
_scene_commands.setup(_undo_manager, _editor_guards)
add_child(_scene_commands)
```

在 `cleanup()` 中添加 `_editor_guards` 的清理：

```gdscript
if _editor_guards:
	if _editor_guards.has_method("cleanup"): _editor_guards.cleanup()
	_editor_guards.queue_free()
	_editor_guards = null
```

- [ ] **Step 3: 提交 Task 1**

```
feat: add editor_guards.gd — file conflict guard module
```

---

## Task 2: 扩展 undo_manager.gd 支持 property 和 reference 操作

**Files:**
- Modify: `addons/godot_mcp_server/undo_manager.gd`

- [ ] **Step 1: 在 undo_manager.gd 末尾添加新方法**

在现有 `_add_method_call` 函数之后添加以下方法：

```gdscript
## 创建带 property 操作的 undo action
func create_action_with_props(request_id: int, do_props: Array, undo_props: Array) -> void:
	var undo_redo = _plugin.get_undo_redo()
	undo_redo.create_action("MCP: op_%d" % request_id)
	for p in do_props:
		undo_redo.add_do_property(p.target, p.property, p.value)
		if p.value is Resource or p.value is Node:
			undo_redo.add_do_reference(p.value)
	for p in undo_props:
		undo_redo.add_undo_property(p.target, p.property, p.value)
		if p.value is Resource or p.value is Node:
			undo_redo.add_undo_reference(p.value)
	undo_redo.commit_action()


## 创建混合 action（methods + properties + references）
func create_action_mixed(request_id: int, do_ops: Array, undo_ops: Array) -> void:
	"""do_ops/undo_ops 中每个元素是 Dictionary，格式:
	{"type": "method", "target": Object, "method": String, "args": Array}
	{"type": "property", "target": Object, "property": String, "value": Variant}
	{"type": "reference", "value": Variant}  # add_do_reference / add_undo_reference
	"""
	var undo_redo = _plugin.get_undo_redo()
	undo_redo.create_action("MCP: op_%d" % request_id)
	for op in do_ops:
		_apply_op(undo_redo, "do", op)
	for op in undo_ops:
		_apply_op(undo_redo, "undo", op)
	undo_redo.commit_action()


func _apply_op(undo_redo: UndoRedo, mode: String, op: Dictionary) -> void:
	var op_type: String = op.get("type", "method")
	match op_type:
		"method":
			_add_method_call(undo_redo, mode, op)
		"property":
			var target: Object = op.target
			var prop: String = op.property
			var val = op.value
			if mode == "do":
				undo_redo.add_do_property(target, prop, val)
			else:
				undo_redo.add_undo_property(target, prop, val)
		"reference":
			var val = op.value
			if mode == "do":
				undo_redo.add_do_reference(val)
			else:
				undo_redo.add_undo_reference(val)
```

- [ ] **Step 2: 给现有 create_action 的 add_child 添加 add_do_reference**

修改 `node_commands.gd` 的 `handle_add_node` 中的 undo 调用，加上 reference 防止 GC：

在 `node_commands.gd:43-47` 修改为：

```gdscript
_undo_manager.create_action_mixed(request_id,
	[
		{"type": "method", "target": parent_node, "method": "add_child", "args": [cls]},
		{"type": "method", "target": cls, "method": "set_owner", "args": [root]},
		{"type": "reference", "value": cls}
	],
	[
		{"type": "method", "target": parent_node, "method": "remove_child", "args": [cls]}
	]
)
```

- [ ] **Step 3: 提交 Task 2**

```
feat: extend undo_manager — add property, reference, and mixed action support
```

---

## Task 3: scene_commands.gd 接入文件冲突防护 + UndoRedo

**Files:**
- Modify: `addons/godot_mcp_server/commands/scene_commands.gd`

- [ ] **Step 1: 添加 setup 方法和成员变量**

在文件顶部 `extends Node` 之后添加：

```gdscript
var _undo_manager: Node
var _editor_guards: Node

func setup(undo_manager: Node, editor_guards: Node) -> void:
	_undo_manager = undo_manager
	_editor_guards = editor_guards
```

- [ ] **Step 2: 给 handle_save_scene 添加文件冲突防护**

替换 `handle_save_scene` 整个方法：

```gdscript
func handle_save_scene(params: Dictionary) -> Dictionary:
	var save_path: String = params.get("path", "")
	var ei = Engine.get_singleton("EditorInterface") as EditorInterface
	var root = ei.get_edited_scene_root()

	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open"}}

	# 如果没有指定路径，使用当前场景路径
	if save_path.is_empty():
		save_path = root.scene_file_path
	if save_path.is_empty():
		return {"error": {"code": -32004, "message": "No save path and scene has no file path"}}

	# 守卫：不允许保存非活跃的已打开场景
	if _editor_guards != null:
		var guard = _editor_guards.guard_save_inactive_open_scene(save_path)
		if not guard.is_empty():
			return guard

	# 守卫：如果路径不同于当前场景，检查是否在其他标签页打开
	var normalized: String = _normalize_project_path(save_path)
	if _editor_guards != null and not normalized.is_empty():
		if root.scene_file_path.is_empty() or _normalize_project_path(root.scene_file_path) != normalized:
			# 保存到不同路径 — 确保目标不是已打开的其他场景
			var offline_guard = _editor_guards.guard_offline_scene_save(normalized)
			if not offline_guard.is_empty():
				return offline_guard

	# 使用 EditorInterface 保存（保留 undo 历史）
	var err: int
	var save_method: String
	if root.scene_file_path.is_empty() or _normalize_project_path(root.scene_file_path) != normalized:
		ei.save_scene_as(normalized)
		err = OK
		save_method = "save_scene_as"
	else:
		err = ei.save_scene()
		save_method = "save_scene"

	if err != OK:
		return {"error": {"code": -32000, "message": "Save failed via %s: %s" % [save_method, error_string(err)]}}

	return {"result": {"status": "saved", "path": normalized, "method": save_method}}
```

在文件末尾（`_property_exists_and_type_ok` 之前）添加辅助方法：

```gdscript
func _normalize_project_path(path: String) -> String:
	if path.is_empty():
		return ""
	if path.begins_with("res://") or path.begins_with("user://"):
		return path.simplify_path()
	return ProjectSettings.localize_path(path).simplify_path()
```

- [ ] **Step 3: 给 handle_instance_scene 添加 UndoRedo**

修改 `handle_instance_scene` 中 `parent.add_child(instance)` 和 `instance.owner = root` 部分（约 L68-69）：

替换：
```gdscript
	parent.add_child(instance)
	instance.owner = root
```

为：
```gdscript
	if _undo_manager != null:
		_undo_manager.create_action_mixed(0,
			[
				{"type": "method", "target": parent, "method": "add_child", "args": [instance]},
				{"type": "method", "target": instance, "method": "set_owner", "args": [root]},
				{"type": "reference", "value": instance}
			],
			[
				{"type": "method", "target": parent, "method": "remove_child", "args": [instance]}
			]
		)
	else:
		parent.add_child(instance)
		instance.owner = root
```

- [ ] **Step 4: 给 handle_set_instance_property 添加 UndoRedo**

修改 `handle_set_instance_property` 中直接 `target.set(prop_name, prop_value)` 的部分（约 L107）：

替换：
```gdscript
	target.set(prop_name, prop_value)
	return {"result": {"node": str(target.name), "property": prop_name}}
```

为：
```gdscript
	var old_value = target.get(prop_name)
	if _undo_manager != null:
		_undo_manager.create_action_mixed(0,
			[
				{"type": "property", "target": target, "property": prop_name, "value": prop_value}
			],
			[
				{"type": "property", "target": target, "property": prop_name, "value": old_value}
			]
		)
	else:
		target.set(prop_name, prop_value)
	return {"result": {"node": str(target.name), "property": prop_name}}
```

- [ ] **Step 5: 提交 Task 3**

```
feat: scene_commands — add file conflict guard + UndoRedo for instance/property ops
```

---

## Task 4: animation_commands.gd 接入 UndoRedo

**Files:**
- Modify: `addons/godot_mcp_server/commands/animation_commands.gd`

- [ ] **Step 1: 添加 _undo_manager 成员和 setup 扩展**

在文件顶部 `var _plugin: EditorPlugin` 后添加：

```gdscript
var _undo_manager: Node
```

修改 `setup` 方法签名（保持向后兼容）：

```gdscript
func setup(plugin: EditorPlugin, undo_manager: Node = null) -> void:
	_plugin = plugin
	_undo_manager = undo_manager
```

对应修改 `command_handler.gd` 中 `_animation_commands` 的初始化：

```gdscript
_animation_commands = preload("commands/animation_commands.gd").new()
_animation_commands.setup(plugin, _undo_manager)
add_child(_animation_commands)
```

- [ ] **Step 2: 给 handle_animation_track 的 add/remove 添加 UndoRedo**

**add action**（约 L30-52），替换直接的 `anim.add_track(...)` 调用：

```gdscript
			"add":
				var track_type: String = params.get("track_type", "value")
				var type_map = {
					"value": Animation.TYPE_VALUE,
					"position_3d": Animation.TYPE_POSITION_3D,
					"rotation_3d": Animation.TYPE_ROTATION_3D,
					"scale_3d": Animation.TYPE_SCALE_3D,
					"blend_shape": Animation.TYPE_BLEND_SHAPE,
					"method": Animation.TYPE_METHOD,
					"bezier": Animation.TYPE_BEZIER,
					"audio": Animation.TYPE_AUDIO,
					"animation": Animation.TYPE_ANIMATION,
				}
				if not type_map.has(track_type):
					return {"error": {"code": -32004, "message": "Invalid track_type: " + track_type}}
				var track_path: String = params.get("track_path", "")
				var idx = anim.get_track_count()  # 新轨道将追加到此索引
				var insert_at = params.get("insert_at")

				if _undo_manager != null:
					# do: add_track + set_path + move (如果 insert_at)
					# undo: remove_track
					var do_ops: Array = [
						{"type": "method", "target": anim, "method": "add_track", "args": [type_map[track_type]]},
					]
					if track_path != "":
						do_ops.append({"type": "method", "target": anim, "method": "track_set_path", "args": [idx, NodePath(track_path)]})
					if insert_at != null and int(insert_at) >= 0 and int(insert_at) < anim.get_track_count() + 1:
						do_ops.append({"type": "method", "target": anim, "method": "move_track", "args": [idx, int(insert_at)]})
						idx = int(insert_at)
					_undo_manager.create_action_mixed(0, do_ops, [
						{"type": "method", "target": anim, "method": "remove_track", "args": [idx]}
					])
				else:
					idx = anim.add_track(type_map[track_type])
					if track_path != "":
						anim.track_set_path(idx, track_path)
					if insert_at != null and int(insert_at) >= 0 and int(insert_at) < anim.get_track_count():
						anim.move_track(idx, int(insert_at))

				return {"result": {"animation": anim_name, "track_index": idx, "type": track_type, "status": "track_added"}}
```

**remove action**（约 L53-61），替换直接的 `anim.remove_track(ti)`：

```gdscript
			"remove":
				var track_index = params.get("track_index")
				if track_index == null:
					return {"error": {"code": -32004, "message": "track_index is required for remove"}}
				var ti = int(track_index)
				if ti < 0 or ti >= anim.get_track_count():
					return {"error": {"code": -32004, "message": "track_index out of range: " + str(ti)}}

				if _undo_manager != null:
					# 捕获旧轨道数据用于 undo
					var old_type: int = anim.track_get_type(ti)
					var old_path: NodePath = anim.track_get_path(ti)
					# 捕获所有关键帧
					var old_keys: Array = []
					for k in anim.track_get_key_count(ti):
						old_keys.append({
							"time": anim.track_get_key_time(ti, k),
							"value": anim.track_get_key_value(ti, k),
							"transition": anim.track_get_key_transition(ti, k),
						})
					# undo: 重新 add_track + set_path + insert keys
					var undo_ops: Array = [
						{"type": "method", "target": anim, "method": "add_track", "args": [old_type]},
						{"type": "method", "target": anim, "method": "track_set_path", "args": [ti, old_path]},
					]
					for key in old_keys:
						undo_ops.append({"type": "method", "target": anim, "method": "track_insert_key", "args": [ti, key.time, key.value, key.transition]})
					_undo_manager.create_action_mixed(0, [
						{"type": "method", "target": anim, "method": "remove_track", "args": [ti]}
					], undo_ops)
				else:
					anim.remove_track(ti)

				return {"result": {"animation": anim_name, "track_index": ti, "status": "track_removed"}}
```

- [ ] **Step 3: 给 handle_animation_keyframe 的 add/remove/update 添加 UndoRedo**

**add action**（约 L94-102）：

```gdscript
			"add":
				var time = params.get("time")
				if time == null:
					return {"error": {"code": -32004, "message": "time is required for add"}}
				var value = params.get("value")
				var transition = params.get("transition")
				var trans_val = float(transition) if transition != null else 1.0
				var key_idx: int

				if _undo_manager != null:
					# 检查是否已存在该时间点的关键帧（upsert 模式）
					var existing_idx = _find_key_at_time(anim, ti, float(time))
					if existing_idx >= 0:
						# 更新现有关键帧
						var old_val = anim.track_get_key_value(ti, existing_idx)
						var old_trans = anim.track_get_key_transition(ti, existing_idx)
						_undo_manager.create_action_mixed(0, [
							{"type": "method", "target": anim, "method": "track_set_key_value", "args": [ti, existing_idx, value]},
							{"type": "method", "target": anim, "method": "track_set_key_transition", "args": [ti, existing_idx, trans_val]},
						], [
							{"type": "method", "target": anim, "method": "track_set_key_value", "args": [ti, existing_idx, old_val]},
							{"type": "method", "target": anim, "method": "track_set_key_transition", "args": [ti, existing_idx, old_trans]},
						])
						key_idx = existing_idx
					else:
						# 新增关键帧
						_undo_manager.create_action_mixed(0, [
							{"type": "method", "target": anim, "method": "track_insert_key", "args": [ti, float(time), value, trans_val]},
						], [
							{"type": "method", "target": anim, "method": "track_remove_key", "args": [ti, anim.get_track_count(ti)]},
						])
						key_idx = _find_key_at_time(anim, ti, float(time))
				else:
					key_idx = anim.track_insert_key(ti, float(time), value, trans_val)

				return {"result": {"animation": anim_name, "track_index": ti, "keyframe_index": key_idx, "time": float(time), "status": "keyframe_added"}}
```

**remove action**（约 L103-109）：

```gdscript
			"remove":
				var keyframe_index = params.get("keyframe_index")
				if keyframe_index == null:
					return {"error": {"code": -32004, "message": "keyframe_index is required for remove"}}
				var ki = int(keyframe_index)

				if _undo_manager != null:
					# 捕获旧关键帧数据
					var old_time: float = anim.track_get_key_time(ti, ki)
					var old_val = anim.track_get_key_value(ti, ki)
					var old_trans: float = anim.track_get_key_transition(ti, ki)
					_undo_manager.create_action_mixed(0, [
						{"type": "method", "target": anim, "method": "track_remove_key", "args": [ti, ki]},
					], [
						{"type": "method", "target": anim, "method": "track_insert_key", "args": [ti, old_time, old_val, old_trans]},
					])
				else:
					anim.track_remove_key(ti, ki)

				return {"result": {"animation": anim_name, "track_index": ti, "keyframe_index": ki, "status": "keyframe_removed"}}
```

**update action**（约 L110-124）：

```gdscript
			"update":
				var keyframe_index = params.get("keyframe_index")
				if keyframe_index == null:
					return {"error": {"code": -32004, "message": "keyframe_index is required for update"}}
				var ki = int(keyframe_index)

				if _undo_manager != null:
					# 捕获旧值
					var old_val = anim.track_get_key_value(ti, ki)
					var old_trans: float = anim.track_get_key_transition(ti, ki)
					var old_time: float = anim.track_get_key_time(ti, ki)
					var do_ops: Array = []
					var undo_ops: Array = []
					var value = params.get("value")
					if value != null:
						do_ops.append({"type": "method", "target": anim, "method": "track_set_key_value", "args": [ti, ki, value]})
						undo_ops.append({"type": "method", "target": anim, "method": "track_set_key_value", "args": [ti, ki, old_val]})
					var transition = params.get("transition")
					if transition != null:
						do_ops.append({"type": "method", "target": anim, "method": "track_set_key_transition", "args": [ti, ki, float(transition)]})
						undo_ops.append({"type": "method", "target": anim, "method": "track_set_key_transition", "args": [ti, ki, old_trans]})
					var time = params.get("time")
					if time != null:
						do_ops.append({"type": "method", "target": anim, "method": "track_set_key_time", "args": [ti, ki, float(time)]})
						undo_ops.append({"type": "method", "target": anim, "method": "track_set_key_time", "args": [ti, ki, old_time]})
					_undo_manager.create_action_mixed(0, do_ops, undo_ops)
				else:
					var value = params.get("value")
					if value != null:
						anim.track_set_key_value(ti, ki, value)
					var transition = params.get("transition")
					if transition != null:
						anim.track_set_key_transition(ti, ki, float(transition))
					var time = params.get("time")
					if time != null:
						anim.track_set_key_time(ti, ki, float(time))

				return {"result": {"animation": anim_name, "track_index": ti, "keyframe_index": ki, "status": "keyframe_updated"}}
```

- [ ] **Step 4: 在文件末尾添加 _find_key_at_time 辅助方法**

```gdscript
func _find_key_at_time(anim: Animation, track_index: int, time: float) -> int:
	for key_index: int in anim.track_get_key_count(track_index):
		if is_equal_approx(anim.track_get_key_time(track_index, key_index), time):
			return key_index
	return -1
```

- [ ] **Step 5: 提交 Task 4**

```
feat: animation_commands — add UndoRedo for track and keyframe operations
```

---

## Task 5: 验证 + 发版

**Files:**
- Verify: `addons/godot_mcp_server/editor_guards.gd`
- Verify: `addons/godot_mcp_server/undo_manager.gd`
- Verify: `addons/godot_mcp_server/commands/scene_commands.gd`
- Verify: `addons/godot_mcp_server/commands/animation_commands.gd`
- Verify: `addons/godot_mcp_server/commands/node_commands.gd`
- Verify: `addons/godot_mcp_server/command_handler.gd`

- [ ] **Step 1: 运行 TypeScript 全量测试**

```bash
cd D:/GitHub/godot-mcp-enhanced && npx vitest run 2>&1 | tail -20
```

Expected: 全部通过（GDScript 文件改动不影响 TS 测试，但需确认无破坏性变更）

- [ ] **Step 2: 运行 GDScript 语法验证**

使用 MCP 工具 `validate_scripts` 验证所有修改的 `.gd` 文件语法正确。

- [ ] **Step 3: 手动验证文件冲突防护**

在 Godot 编辑器中：
1. 打开一个场景文件
2. 通过 MCP 调用 `save_scene` 尝试保存同一场景
3. 验证返回错误码 `-32009`（`Refusing to save open scene...`）

- [ ] **Step 4: 手动验证 UndoRedo**

在 Godot 编辑器中：
1. 通过 MCP `add_node` 添加一个节点
2. 在编辑器中 Ctrl+Z
3. 验证节点被移除

- [ ] **Step 5: 更新 CHANGELOG**

```
## v0.17.0 — Editor Reliability

### Added
- **P1 文件冲突防护**: `editor_guards.gd` — 防止 MCP 静默覆盖编辑器中打开的场景/脚本
  - `guard_offline_scene_save`: 检测场景是否在编辑器中打开
  - `guard_save_inactive_open_scene`: 防止从活跃场景保存非活跃已打开场景
  - `guard_text_resource_write`: 检测脚本/着色器是否在脚本编辑器中打开
- **P0 UndoRedo 覆盖**: 扩展 `undo_manager.gd` 支持 property/reference/mixed 操作
  - `scene_commands`: instance_scene、set_instance_property、save_scene 支持 UndoRedo + 文件守卫
  - `animation_commands`: track add/remove、keyframe add/remove/update 支持 UndoRedo
  - `node_commands`: add_node 补充 add_do_reference 防止 GC

### Changed
- `undo_manager.gd` 新增 `create_action_with_props`、`create_action_mixed` 方法
- `command_handler.gd` 新增 `_editor_guards` 模块并注入到 scene_commands
```

- [ ] **Step 6: 提交发版**

```bash
git add -A
git commit -m "feat: v0.17.0 — file conflict guard + UndoRedo coverage for editor mode"
```

---

## Self-Review

### 1. Spec Coverage

| 需求 | 对应 Task |
|------|-----------|
| guard_offline_scene_save | Task 1 + Task 3 |
| guard_text_resource_write | Task 1 |
| guard_save_inactive_open_scene | Task 1 + Task 3 |
| UndoRedo scene_commands (instance, property) | Task 3 |
| UndoRedo animation_commands (track, keyframe) | Task 4 |
| UndoRedo node_commands (add_do_reference) | Task 2 |
| undo_manager 扩展 | Task 2 |
| command_handler 注入 | Task 1 + Task 2 |

### 2. Placeholder Scan

无 TBD/TODO/占位符。所有步骤包含完整代码。

### 3. Type Consistency

- `create_action_mixed` 在 Task 2 定义，在 Task 2/3/4 中调用，参数格式一致：`{"type": "method"|"property"|"reference", ...}`
- `setup()` 方法签名：`scene_commands.setup(_undo_manager, _editor_guards)`、`animation_commands.setup(plugin, _undo_manager)` 与 command_handler.gd 注入匹配
- 错误码统一使用 `-32009`（与 pro 版 error_conflict 一致）

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open | 8 issues, 1 critical gap |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |

**UNRESOLVED:** 0 unresolved decisions — all 6 questions answered
**VERDICT:** ENG review completed with 8 issues found. 3 CRITICAL (add_do_reference misuse, keyframe undo index bug, track undo incompleteness), 2 IMPORTANT (DRY violation, animation_curve missing undo), 3 ADVISORY. All issues have agreed resolutions. Ready to implement after applying fixes.
