import { describe, it, expect } from 'vitest';
import { validateSceneFile } from '../../src/tools/validation.js';

describe('validateSceneFile — .tscn/.tres 结构验证', () => {
  it('应对有效的 .tscn 文件返回空错误', () => {
    const content = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://player.gd" id="1"]

[node name="Player" type="CharacterBody3D"]
script = ExtResource("1")
`;
    const result = validateSceneFile(content, 'scenes/player.tscn', '/project');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('应检测缺失的 [gd_scene]/[gd_resource] 头', () => {
    const content = `[node name="Player" type="Node3D"]
`;
    const result = validateSceneFile(content, 'scenes/bad.tscn', '/project');
    expect(result.errors).toContainEqual(
      expect.stringContaining('Missing [gd_scene] or [gd_resource] header')
    );
  });

  it('应检测重复的 sub_resource id', () => {
    const content = `[gd_scene load_steps=3 format=3]

[sub_resource type="CapsuleShape3D" id="CapsuleShape3D_abc"]
radius = 0.5

[sub_resource type="CapsuleShape3D" id="CapsuleShape3D_abc"]
radius = 1.0

[node name="Player" type="CharacterBody3D"]
`;
    const result = validateSceneFile(content, 'scenes/dup.tscn', '/project');
    expect(result.errors).toContainEqual(
      expect.stringContaining('Duplicate sub_resource id: CapsuleShape3D_abc')
    );
  });

  it('应检测重复的 ext_resource id', () => {
    const content = `[gd_scene load_steps=3 format=3]

[ext_resource type="Script" path="res://a.gd" id="1"]
[ext_resource type="Script" path="res://b.gd" id="1"]

[node name="Player" type="CharacterBody3D"]
`;
    const result = validateSceneFile(content, 'scenes/dup_ext.tscn', '/project');
    expect(result.errors).toContainEqual(
      expect.stringContaining('Duplicate ext_resource id: 1')
    );
  });

  it('应对有效的 .tres 资源文件正常工作', () => {
    const content = `[gd_resource type="Environment" format=3]

[resource]
background_mode = 1
`;
    const result = validateSceneFile(content, 'assets/env.tres', '/project');
    expect(result.errors).toEqual([]);
  });

  it('应检测空文件', () => {
    const result = validateSceneFile('', 'empty.tscn', '/project');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('不应为不同的 sub_resource id 报错', () => {
    const content = `[gd_scene load_steps=3 format=3]

[sub_resource type="CapsuleShape3D" id="CapsuleShape3D_001"]
radius = 0.5

[sub_resource type="BoxShape3D" id="BoxShape3D_002"]
size = Vector3(1, 1, 1)

[node name="Player" type="CharacterBody3D"]
`;
    const result = validateSceneFile(content, 'scenes/ok.tscn', '/project');
    expect(result.errors).toEqual([]);
  });
});
