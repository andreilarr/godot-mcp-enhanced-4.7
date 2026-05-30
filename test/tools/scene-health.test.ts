import { describe, it, expect } from 'vitest';
import { checkSceneHealth } from '../../src/tools/scene.js';

describe('checkSceneHealth — 场景健康检查', () => {
  it('应检测无脚本的孤立节点', () => {
    const content = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://player.gd" id="1"]

[node name="Root" type="Node3D"]

[node name="Player" type="CharacterBody3D" parent="."]
script = ExtResource("1")

[node name="Orphan" type="Node3D" parent="Player"]
`;
    const result = checkSceneHealth(content, 'test.tscn');
    expect(result.issues.some(i => i.includes('Orphan') && i.includes('no script'))).toBe(true);
  });

  it('应检测循环实例化', () => {
    const content = `[gd_scene load_steps=2 format=3]

[ext_resource type="PackedScene" path="res://scenes/test.tscn" id="1"]

[node name="Root" type="Node3D"]

[node name="SelfRef" parent="." instance=ExtResource("1")]
`;
    const result = checkSceneHealth(content, 'scenes/test.tscn');
    expect(result.issues.some(i => i.includes('circular') || i.includes('self-reference'))).toBe(true);
  });

  it('应对健康场景返回空问题列表', () => {
    const content = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://main.gd" id="1"]

[node name="Main" type="Node2D"]
script = ExtResource("1")

[node name="Camera2D" type="Camera2D" parent="."]
`;
    const result = checkSceneHealth(content, 'scenes/main.tscn');
    expect(result.issues).toEqual([]);
  });

  it('应检测重复的节点名（同层级）', () => {
    const content = `[gd_scene load_steps=2 format=3]

[node name="Root" type="Node3D"]

[node name="Child" type="Node3D" parent="."]

[node name="Child" type="Node3D" parent="."]
`;
    const result = checkSceneHealth(content, 'dup.tscn');
    expect(result.issues.some(i => i.includes('Duplicate') || i.includes('duplicate'))).toBe(true);
  });
});
