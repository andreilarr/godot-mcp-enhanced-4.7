## Shared safe-value whitelist for GDScript tool operations.
## Used by both godot_operations.gd and mcp_bridge.gd.
## THIS IS THE CANONICAL SOURCE — inline copies in other files must match exactly.
class_name SafeValues

const MAX_DEPTH := 10

## Check if a value is safe for use in tool operations.
## Whitelists basic types and recursively checks containers.
static func is_safe(val: Variant, depth: int = 0) -> bool:
	if depth > MAX_DEPTH:
		return false
	if val == null:
		return true
	if val is bool or val is int or val is float or val is String or val is StringName:
		return true
	if val is Vector2 or val is Vector2i or val is Vector3 or val is Vector3i:
		return true
	if val is Color or val is Rect2 or val is Rect2i:
		return true
	if val is Transform2D or val is Transform3D or val is Basis or val is Quaternion:
		return true
	if val is Plane or val is AABB:
		return true
	if val is PackedByteArray or val is PackedInt32Array or val is PackedInt64Array:
		return true
	if val is PackedFloat32Array or val is PackedFloat64Array or val is PackedStringArray:
		return true
	if val is PackedVector2Array or val is PackedVector3Array or val is PackedColorArray:
		return true
	if val is Array:
		for item in val:
			if not is_safe(item, depth + 1):
				return false
		return true
	if val is Dictionary:
		for key in val:
			if not is_safe(key, depth + 1):
				return false
			if not is_safe(val[key], depth + 1):
				return false
		return true
	return false
