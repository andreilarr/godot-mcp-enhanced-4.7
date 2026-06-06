import { describe, it, expect } from 'vitest';
import { addNodes } from '../src/tscn-editor.js';
import type { AddNodeParams } from '../src/tscn-editor.js';

const SIMPLE_SCENE = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://player.gd" id="1"]

[node name="Root" type="Node2D"]
script = ExtResource("1")
`;

const NESTED_SCENE = `[gd_scene format=3]

[node name="Level" type="Node2D"]

[node name="Player" type="CharacterBody2D" parent="."]

[node name="Sprite" type="Sprite2D" parent="Player"]
`;

describe('addNodes', () => {
  it('returns immediate success for empty array', () => {
    const result = addNodes(SIMPLE_SCENE, []);
    expect(result.success).toBe(true);
    expect(result.fallback).toBe(false);
    expect(result.scene).toBe(SIMPLE_SCENE);
  });

  it('adds multiple nodes in one pass', () => {
    const nodes: Array<AddNodeParams> = [
      { parent: '.', name: 'Enemy', type: 'CharacterBody2D' },
      { parent: '.', name: 'Camera', type: 'Camera2D' },
    ];

    const result = addNodes(SIMPLE_SCENE, nodes);
    expect(result.success).toBe(true);
    expect(result.fallback).toBe(false);
    expect(result.scene).toContain('[node name="Enemy" type="CharacterBody2D" parent="."]');
    expect(result.scene).toContain('[node name="Camera" type="Camera2D" parent="."]');
  });

  it('returns fallback=true if any node has unsupported props', () => {
    const nodes: Array<AddNodeParams> = [
      { parent: '.', name: 'Enemy', type: 'CharacterBody2D' },
      { parent: '.', name: 'Bad', type: 'Node', properties: { arr: [1, 2, 3] } },
    ];

    const result = addNodes(SIMPLE_SCENE, nodes);
    expect(result.success).toBe(true);
    expect(result.fallback).toBe(true);
    // Should not have modified the scene
    expect(result.scene).toBeUndefined();
  });

  it('preserves all existing nodes when adding', () => {
    const nodes: Array<AddNodeParams> = [
      { parent: 'Player', name: 'HealthBar', type: 'Control' },
    ];

    const result = addNodes(NESTED_SCENE, nodes);
    expect(result.success).toBe(true);
    // Original nodes still present
    expect(result.scene).toContain('[node name="Level" type="Node2D"]');
    expect(result.scene).toContain('[node name="Player" type="CharacterBody2D" parent="."]');
    expect(result.scene).toContain('[node name="Sprite" type="Sprite2D" parent="Player"]');
    // New node present
    expect(result.scene).toContain('[node name="HealthBar" type="Control" parent="Player"]');
  });

  it('returns error if any individual addNode fails', () => {
    const nodes: Array<AddNodeParams> = [
      { parent: '.', name: 'Good', type: 'Node2D' },
      { parent: 'NonExistent', name: 'Bad', type: 'Node2D' },
    ];

    const result = addNodes(SIMPLE_SCENE, nodes);
    expect(result.success).toBe(false);
    expect(result.message).toContain('Parent node not found');
  });

  it('threads scene content through sequential adds', () => {
    const nodes: Array<AddNodeParams> = [
      { parent: '.', name: 'UI', type: 'CanvasLayer' },
      { parent: 'UI', name: 'HUD', type: 'Control' },
    ];

    const result = addNodes(SIMPLE_SCENE, nodes);
    expect(result.success).toBe(true);
    expect(result.fallback).toBe(false);
    expect(result.scene).toContain('[node name="UI" type="CanvasLayer" parent="."]');
    expect(result.scene).toContain('[node name="HUD" type="Control" parent="UI"]');
  });

  it('handles single node in array', () => {
    const nodes: Array<AddNodeParams> = [
      { parent: '.', name: 'Solo', type: 'Node2D', properties: { visible: false } },
    ];

    const result = addNodes(SIMPLE_SCENE, nodes);
    expect(result.success).toBe(true);
    expect(result.fallback).toBe(false);
    expect(result.scene).toContain('[node name="Solo" type="Node2D" parent="."]');
    expect(result.scene).toContain('visible = false');
  });
});
