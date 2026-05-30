import { describe, it, expect } from 'vitest';
import { mergeTscn } from '../../src/tools/scene.js';

describe('mergeTscn — .tscn 合并冲突修复', () => {
  const ours = `[gd_scene load_steps=3 format=3]

[ext_resource type="Script" path="res://a.gd" id="1"]
[ext_resource type="Script" path="res://b.gd" id="2"]

[node name="Root" type="Node3D"]

[node name="Player" type="CharacterBody3D" parent="."]
script = ExtResource("1")

[node name="Enemy" type="CharacterBody3D" parent="."]
script = ExtResource("2")
`;

  const theirs = `[gd_scene load_steps=3 format=3]

[ext_resource type="Script" path="res://a.gd" id="1"]
[ext_resource type="Script" path="res://c.gd" id="2"]

[node name="Root" type="Node3D"]

[node name="Player" type="CharacterBody3D" parent="."]
script = ExtResource("1")

[node name="Boss" type="CharacterBody3D" parent="."]
script = ExtResource("2")
`;

  it('应合并两个分支的 ext_resource（去重 + 合并新资源）', () => {
    const result = mergeTscn(ours, theirs);
    expect(result).toContain('res://a.gd');
    expect(result).toContain('res://b.gd');
    expect(result).toContain('res://c.gd');
  });

  it('应合并两个分支的 node（ours + theirs 新增节点）', () => {
    const result = mergeTscn(ours, theirs);
    expect(result).toContain('name="Player"');
    expect(result).toContain('name="Enemy"');
    expect(result).toContain('name="Boss"');
  });

  it('应保留有效的 [gd_scene] 头', () => {
    const result = mergeTscn(ours, theirs);
    expect(result).toContain('[gd_scene');
  });

  it('对相同内容应返回原样', () => {
    const result = mergeTscn(ours, ours);
    expect(result).toContain('res://a.gd');
    expect(result).toContain('res://b.gd');
    expect(result).toContain('name="Enemy"');
  });

  it('应重新编号合并后的 ext_resource id', () => {
    const result = mergeTscn(ours, theirs);
    const extMatches = result.match(/\[ext_resource[^[]*id="(\d+)"/g);
    expect(extMatches).toBeTruthy();
    const ids = extMatches!.map(m => m.match(/id="(\d+)"/)![1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
