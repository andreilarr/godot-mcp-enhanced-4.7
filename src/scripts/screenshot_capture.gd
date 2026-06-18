extends SceneTree

## Screenshot capture for Godot MCP Enhanced.
##
## Usage:
##   godot --path <project> --script screenshot_capture.gd <output_path> [scene_path] [max_frames] [viewport_size]
##   可选命名参数: --wait-node <name_or_path>  --wait-text <substring>
##
## Parameters (positional, after --script):
##   output_path   — absolute path for PNG output (required)
##   scene_path    — res:// path to scene (optional)
##   max_frames    — frames to wait before capture (default: 10)
##   viewport_size — WxH format, e.g. 1280x720 (default: 1280x720)
##
## Named (optional):
##   --wait-node <name_or_path> — 等待该节点出现再截图。支持节点名(递归查找)或路径:
##                                 相对 root 如 "A/B",绝对路径 /root/A/B 会自动 strip 前缀
##   --wait-text <substring>    — 等待任一 Label/RichTextLabel 的 text 包含该子串再截图
##
## 流程: 优先等条件(wait-node/wait-text)满足 → 条件满足或超时(CONDITION_WAIT_MAX_FRAMES 帧)后
##       再等 max_frames 帧 → 截图
## 超时保护: 条件等待超过 CONDITION_WAIT_MAX_FRAMES(300帧≈5s@60fps,独立于 max_frames)仍未满足,
##           放弃等待直接截图(避免无限阻塞)
##
## Platform notes:
##   - On Windows, headless mode returns null viewport textures.
##     Use windowed mode (omit --headless) for reliable screenshots.
##   - On Linux/macOS, --headless --rendering-driver opengl3 may work.

const CONDITION_WAIT_MAX_FRAMES := 300  # 条件等待超时(≈5s@60fps),独立于 max_frames(I-2:避免与倒计时帧数耦合)

var _output_path := ""
var _scene_path := ""
var _max_frames := 10
var _frames_left := 0
var _wait_node := ""
var _wait_text := ""
var _condition_satisfied := false
var _condition_waited := 0


func _init() -> void:
	_parse_args()
	_frames_left = _max_frames

	if _output_path == "":
		push_error("[SCREENSHOT] Error: output_path is required")
		printerr("[SCREENSHOT] Usage: godot --path <project> --script screenshot_capture.gd <output_path> [scene] [frames] [WxH]")
		quit(1)
		return

	print("[SCREENSHOT] Output: %s" % _output_path)
	print("[SCREENSHOT] Scene: %s" % (_scene_path if _scene_path else "(default)"))
	print("[SCREENSHOT] Frames: %d" % _max_frames)
	if _wait_node != "" or _wait_text != "":
		print("[SCREENSHOT] Wait: node=%s text=%s" % [_wait_node, _wait_text])

	# Use process_frame signal (reliable for SceneTree scripts)
	# Must use call_deferred for scene loading after autoloads initialize
	process_frame.connect(_on_process_frame)
	call_deferred("_deferred_load_scene")


func _parse_args() -> void:
	var args := OS.get_cmdline_args()
	var script_idx := args.find("--script")
	if script_idx == -1:
		script_idx = args.find("-s")

	if script_idx < 0:
		return

	var param_idx := script_idx + 2  # skip --script and script path

	if param_idx < args.size():
		_output_path = args[param_idx]
		# I-06/I-08: Block path traversal in screenshot output path (raw + uri-decoded)
		var decoded := _output_path.uri_decode()
		if ".." in _output_path or ".." in decoded:
			push_error("[SCREENSHOT] Error: output_path must not contain '..'")
			_output_path = ""
	if param_idx + 1 < args.size() and not args[param_idx + 1].is_valid_int():
		_scene_path = args[param_idx + 1]
		param_idx += 1
	if param_idx + 1 < args.size():
		_max_frames = int(args[param_idx + 1])
	if param_idx + 2 < args.size():
		var size_str: String = args[param_idx + 2]
		if "x" in size_str:
			var parts := size_str.split("x")
			if parts.size() == 2:
				var w := int(parts[0])
				var h := int(parts[1])
				if w > 0 and h > 0:
					DisplayServer.window_set_size(Vector2i(w, h))
					print("[SCREENSHOT] Viewport: %dx%d" % [w, h])

	# 命名参数(可选,独立于位置参数解析)
	for i in range(args.size()):
		if args[i] == "--wait-node" and i + 1 < args.size():
			_wait_node = args[i + 1]
		elif args[i] == "--wait-text" and i + 1 < args.size():
			_wait_text = args[i + 1]


func _deferred_load_scene() -> void:
	if _scene_path == "":
		print("[SCREENSHOT] No scene specified, capturing default")
		return

	if not ResourceLoader.exists(_scene_path):
		push_error("[SCREENSHOT] Scene not found: %s" % _scene_path)
		quit(1)
		return

	var res = load(_scene_path)
	if res == null:
		push_error("[SCREENSHOT] Failed to load: %s" % _scene_path)
		quit(1)
		return

	var inst = res.instantiate()
	if inst == null:
		push_error("[SCREENSHOT] Failed to instantiate: %s" % _scene_path)
		quit(1)
		return

	get_root().add_child(inst)
	print("[SCREENSHOT] Scene loaded, waiting %d frames..." % _max_frames)


## 检查条件等待是否满足(wait_node 出现 / wait_text 命中)
func _condition_met() -> bool:
	if _wait_node != "":
		# 优先按节点名递归查找
		var node := get_root().find_child(_wait_node, true, false)
		if node == null:
			# 回退按路径查找。get_node_or_null 从 root Viewport 只接受相对路径,
			# 绝对路径(/root/...)会报错(I-1 修复),需 strip /root/ 或前导 /
			var path := _wait_node
			if path.begins_with("/root/"):
				path = path.substr(6)  # 去掉 "/root/"(6 字符)
			elif path.begins_with("/"):
				path = path.lstrip("/")
			if path != "":
				node = get_root().get_node_or_null(path)
		if node == null:
			return false
	if _wait_text != "":
		if not _has_text(get_root(), _wait_text):
			return false
	return true


## 递归查找任一 Label/RichTextLabel 的 text 包含 substring。
## 注(I-3 backlog): 每帧从 root 全树递归;深场景树(>1000 节点)条件等待阶段可能感知开销。
##                   若需优化,可加可选 wait_text_root 参数限定搜索子树。当前功能正确,暂不优化。
func _has_text(node: Node, substring: String) -> bool:
	if node is Label or node is RichTextLabel:
		var t := str(node.get("text"))
		if t.find(substring) != -1:
			return true
	for c in node.get_children():
		if _has_text(c, substring):
			return true
	return false


## 采样检测图片是否为均匀色（空白）。采样约 100 个像素，
## 如果 95% 以上与第一个像素颜色一致则判定为空白。
func _detect_blank_image(img: Image) -> bool:
	var w := img.get_width()
	var h := img.get_height()
	if w == 0 or h == 0:
		return true

	var total_pixels := w * h
	var step := maxi(1, total_pixels / 100)
	var first_color: Color = img.get_pixel(0, 0)
	var sample_count := 0
	var uniform_count := 0

	for i in range(0, total_pixels, step):
		var x := i % w
		var y := i / w
		var c := img.get_pixel(x, y)
		sample_count += 1
		if abs(c.r - first_color.r) < 0.01 and abs(c.g - first_color.g) < 0.01 and abs(c.b - first_color.b) < 0.01 and abs(c.a - first_color.a) < 0.01:
			uniform_count += 1

	return sample_count > 0 and float(uniform_count) / float(sample_count) > 0.95


func _on_process_frame() -> void:
	# 阶段1: 条件等待(wait-node/wait-text)。满足或超时后才进入帧倒计时
	if not _condition_satisfied:
		if _wait_node != "" or _wait_text != "":
			_condition_waited += 1
			if _condition_met():
				_condition_satisfied = true
				print("[SCREENSHOT] Condition met after %d frame(s)" % _condition_waited)
			elif _condition_waited >= CONDITION_WAIT_MAX_FRAMES:
				# 超时保护:放弃条件等待,直接进入帧倒计时(避免无限阻塞)
				_condition_satisfied = true
				print("[SCREENSHOT] Condition wait TIMEOUT after %d frame(s), capturing anyway" % _condition_waited)
			else:
				return  # 继续等待条件
		else:
			_condition_satisfied = true  # 无条件,立即进入倒计时

	# 阶段2: 帧倒计时(条件满足后)
	if _frames_left <= 0:
		return
	_frames_left -= 1
	if _frames_left > 0:
		return

	# Capture screenshot
	var vp := get_root().get_viewport()
	var tex := vp.get_texture()
	var img := tex.get_image()

	if img == null:
		push_error("[SCREENSHOT] Image is null - rendering not available")
		printerr("[SCREENSHOT] Image is null. Headless mode may not support rendering on this platform.")
		printerr("[SCREENSHOT] Try running without --headless flag.")
		quit(1)
		return

	# Ensure output directory exists
	var dir := _output_path.get_base_dir()
	if dir != "" and not DirAccess.dir_exists_absolute(dir):
		DirAccess.make_dir_recursive_absolute(dir)

	var err := img.save_png(_output_path)
	if err == OK:
		var global_path := ProjectSettings.globalize_path(_output_path)
		print("[SCREENSHOT] SAVED: %s (%dx%d)" % [global_path, img.get_width(), img.get_height()])
		# 空白检测：采样像素判断是否为均匀色（2D headless 渲染限制）
		if _detect_blank_image(img):
			print("[SCREENSHOT] WARNING: BLANK_DETECTED - This is a known limitation of Godot headless mode.")
			print("[SCREENSHOT] HINT: 2D CanvasItem content (ColorRect/Sprite2D/Label) cannot render in headless mode.")
			print("[SCREENSHOT] HINT: Use Game Bridge take_screenshot (requires running game via F5 or run_project),")
			print("[SCREENSHOT] HINT: or Editor mode screenshot, or provide a screenshot and use screenshot analyze.")
	else:
		push_error("[SCREENSHOT] Save failed: error %d" % err)
		printerr("[SCREENSHOT] Could not save to: %s (error %d)" % [_output_path, err])

	quit(0)
