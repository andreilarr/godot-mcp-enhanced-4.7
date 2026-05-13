extends Node

func handle_open_scene(params: Dictionary) -> Dictionary:
	var path: String = params.get("scene_path", "")
	if path.is_empty():
		return {"error": {"code": -32004, "message": "scene_path is required"}}
	var ei = Engine.get_singleton("EditorInterface") as EditorInterface
	ei.open_scene_from_path(path)
	return {"result": {"status": "opened", "path": path}}

func handle_save_scene(_params: Dictionary) -> Dictionary:
	var ei = Engine.get_singleton("EditorInterface") as EditorInterface
	ei.save_scene()
	return {"result": {"status": "saved"}}
