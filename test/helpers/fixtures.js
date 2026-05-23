// test/helpers/fixtures.js

/** 最小可运行 Godot 项目 */
export const MINIMAL_PROJECT = {
  'project.godot': `; Engine configuration file.
[application]
config/name="TestProject"
config/features=PackedStringArray("4.2")
run/main_scene="res://scenes/main.tscn"

[rendering]
renderer/rendering_method="gl_compatibility"
`,
  'scenes/main.tscn': `[gd_scene load_steps=2 format=3 uid="uid://test001"]

[ext_resource type="Script" path="res://scripts/main.gd" id="1"]

[node name="Root" type="Node2D"]

[node name="Main" type="Node2D" parent="."]
script = ExtResource("1")
`,
  'scripts/main.gd': `extends Node2D

func _ready():
\tpass
`,
};
