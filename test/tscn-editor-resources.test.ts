import { describe, it, expect } from 'vitest';
import { addExtResource, addSubResource } from '../src/tscn-editor.js';

const BASE_TSCN = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://player.gd" id="1"]

[node name="Root" type="Node2D"]
script = ExtResource("1")
`;

describe('addExtResource', () => {
  it('adds new ext_resource and returns new id', () => {
    const result = addExtResource(BASE_TSCN, 'Texture2D', 'res://icon.svg');
    expect(result.success).toBe(true);
    expect(result.id).toBe('2');
    expect(result.scene).toContain('[ext_resource type="Texture2D" path="res://icon.svg" id="2"]');
    // Should contain the original ext_resource too
    expect(result.scene).toContain('[ext_resource type="Script" path="res://player.gd" id="1"]');
  });

  it('deduplicates by path (returns existing id, does not add duplicate entry)', () => {
    const result = addExtResource(BASE_TSCN, 'Script', 'res://player.gd');
    expect(result.success).toBe(true);
    expect(result.id).toBe('1');
    expect(result.scene).toBeUndefined();
  });

  it('increments load_steps for new resource', () => {
    const result = addExtResource(BASE_TSCN, 'Texture2D', 'res://icon.svg');
    expect(result.scene).toContain('load_steps=3');
  });

  it('does NOT increment load_steps for dedup', () => {
    const result = addExtResource(BASE_TSCN, 'Script', 'res://player.gd');
    // Dedup returns no scene, so load_steps is unchanged
    expect(result.scene).toBeUndefined();
  });

  it('handles scene without load_steps (adds load_steps=2)', () => {
    const noSteps = `[gd_scene format=3]

[ext_resource type="Script" path="res://player.gd" id="1"]

[node name="Root" type="Node2D"]
script = ExtResource("1")
`;
    const result = addExtResource(noSteps, 'Texture2D', 'res://icon.svg');
    expect(result.success).toBe(true);
    expect(result.scene).toContain('load_steps=2');
  });
});

describe('addSubResource', () => {
  it('adds new sub_resource and returns generated id', () => {
    const result = addSubResource(BASE_TSCN, 'RectangleShape2D', { size: 'Vector2(100, 50)' });
    expect(result.success).toBe(true);
    expect(result.id).toBe('RectangleShape2D_1');
    expect(result.scene).toContain('[sub_resource type="RectangleShape2D" id="RectangleShape2D_1"]');
    expect(result.scene).toContain('size = Vector2(100, 50)');
  });

  it('increments load_steps', () => {
    const result = addSubResource(BASE_TSCN, 'RectangleShape2D', { size: 'Vector2(100, 50)' });
    expect(result.scene).toContain('load_steps=3');
  });
});
