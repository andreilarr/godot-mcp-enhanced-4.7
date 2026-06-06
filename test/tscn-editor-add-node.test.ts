import { describe, it, expect } from 'vitest';
import { addNode, canSerializeProperty } from '../src/tscn-editor.js';
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

describe('canSerializeProperty', () => {
  it('allows string, number, boolean', () => {
    expect(canSerializeProperty('hello')).toBe(true);
    expect(canSerializeProperty(42)).toBe(true);
    expect(canSerializeProperty(3.14)).toBe(true);
    expect(canSerializeProperty(true)).toBe(true);
    expect(canSerializeProperty(false)).toBe(true);
  });

  it('allows null and undefined', () => {
    expect(canSerializeProperty(null)).toBe(true);
    expect(canSerializeProperty(undefined)).toBe(true);
  });

  it('allows plain object with primitive values', () => {
    expect(canSerializeProperty({ x: 1, y: 2 })).toBe(true);
    expect(canSerializeProperty({ x: 0, y: 0, z: 5 })).toBe(true);
    expect(canSerializeProperty({ r: 1, g: 0, b: 0, a: 0.5 })).toBe(true);
    expect(canSerializeProperty({ text: 'hello' })).toBe(true);
  });

  it('rejects arrays', () => {
    expect(canSerializeProperty([1, 2, 3])).toBe(false);
    expect(canSerializeProperty([])).toBe(false);
    expect(canSerializeProperty(['a'])).toBe(false);
  });

  it('rejects nested objects', () => {
    expect(canSerializeProperty({ pos: { x: 1, y: 2 } })).toBe(false);
    expect(canSerializeProperty({ arr: [1, 2] })).toBe(false);
    expect(canSerializeProperty({ nested: { deep: true } })).toBe(false);
  });
});

describe('addNode', () => {
  it('adds a root child node (parent=".")', () => {
    const result = addNode(SIMPLE_SCENE, {
      parent: '.',
      name: 'Enemy',
      type: 'CharacterBody2D',
    });

    expect(result.success).toBe(true);
    expect(result.fallback).toBe(false);
    expect(result.scene).toBeDefined();

    // Should contain the new node header
    expect(result.scene).toContain('[node name="Enemy" type="CharacterBody2D" parent="."]');
    // Should preserve original content
    expect(result.scene).toContain('[node name="Root" type="Node2D"]');
    // Should increment load_steps
    expect(result.scene).toContain('load_steps=3');
  });

  it('adds a nested child AFTER last descendant (verify position in output)', () => {
    // Add a child to Player. Sprite is already a child of Player.
    // The new node must go AFTER Sprite, not between Player and Sprite.
    const result = addNode(NESTED_SCENE, {
      parent: 'Player',
      name: 'CollisionShape',
      type: 'CollisionShape2D',
    });

    expect(result.success).toBe(true);
    expect(result.fallback).toBe(false);
    expect(result.scene).toBeDefined();

    const scene = result.scene!;
    const playerIdx = scene.indexOf('[node name="Player"');
    const spriteIdx = scene.indexOf('[node name="Sprite"');
    const newIdx = scene.indexOf('[node name="CollisionShape"');

    // All should be found
    expect(playerIdx).toBeGreaterThan(-1);
    expect(spriteIdx).toBeGreaterThan(-1);
    expect(newIdx).toBeGreaterThan(-1);

    // Ordering: Player < Sprite < CollisionShape
    expect(playerIdx).toBeLessThan(spriteIdx);
    expect(spriteIdx).toBeLessThan(newIdx);

    // Verify the parent attribute
    expect(scene).toContain('[node name="CollisionShape" type="CollisionShape2D" parent="Player"]');
  });

  it('adds node with simple properties (text, position)', () => {
    const result = addNode(SIMPLE_SCENE, {
      parent: '.',
      name: 'Label',
      type: 'Label',
      properties: {
        text: 'Hello World',
        offset_left: 100,
        visible: false,
      },
    });

    expect(result.success).toBe(true);
    expect(result.fallback).toBe(false);
    expect(result.scene).toContain('text = "Hello World"');
    expect(result.scene).toContain('offset_left = 100');
    expect(result.scene).toContain('visible = false');
  });

  it('formats Vector2/Vector3/Color properties correctly', () => {
    const result = addNode(SIMPLE_SCENE, {
      parent: '.',
      name: 'Marker',
      type: 'Node2D',
      properties: {
        position: { x: 10, y: 20 },
        scale: { x: 2, y: 2, z: 1 },
        modulate: { r: 1, g: 0, b: 0 },
      },
    });

    expect(result.success).toBe(true);
    expect(result.scene).toContain('position = Vector2(10, 20)');
    expect(result.scene).toContain('scale = Vector3(2, 2, 1)');
    expect(result.scene).toContain('modulate = Color(1, 0, 0, 1)');
  });

  it('returns fallback=true for unsupported property types (arrays)', () => {
    const result = addNode(SIMPLE_SCENE, {
      parent: '.',
      name: 'BadNode',
      type: 'Node2D',
      properties: {
        items: [1, 2, 3],
      },
    });

    expect(result.success).toBe(true);
    expect(result.fallback).toBe(true);
    // No scene modification when falling back
    expect(result.scene).toBeUndefined();
  });

  it('returns fallback=true for nested object properties', () => {
    const result = addNode(SIMPLE_SCENE, {
      parent: '.',
      name: 'BadNode',
      type: 'Node2D',
      properties: {
        config: { nested: { deep: true } },
      },
    });

    expect(result.success).toBe(true);
    expect(result.fallback).toBe(true);
    expect(result.scene).toBeUndefined();
  });

  it('returns success=false for invalid node name', () => {
    const result = addNode(SIMPLE_SCENE, {
      parent: '.',
      name: 'bad-name!',
      type: 'Node2D',
    });

    expect(result.success).toBe(false);
    expect(result.fallback).toBe(false);
    expect(result.message).toContain('Invalid node name');
  });

  it('returns success=false for invalid node type', () => {
    const result = addNode(SIMPLE_SCENE, {
      parent: '.',
      name: 'Valid',
      type: 'bad type!',
    });

    expect(result.success).toBe(false);
    expect(result.fallback).toBe(false);
    expect(result.message).toContain('Invalid node type');
  });

  it('returns success=false for non-existent parent', () => {
    const result = addNode(SIMPLE_SCENE, {
      parent: 'NonExistent',
      name: 'Orphan',
      type: 'Node2D',
    });

    expect(result.success).toBe(false);
    expect(result.fallback).toBe(false);
    expect(result.message).toContain('Parent node not found');
  });

  it('handles deeply nested descendant insertion correctly', () => {
    // Scene with deep nesting: Level > Player > Sprite > Anim
    const deepScene = `[gd_scene format=3]

[node name="Level" type="Node2D"]

[node name="Player" type="CharacterBody2D" parent="."]

[node name="Sprite" type="Sprite2D" parent="Player"]

[node name="Anim" type="AnimationPlayer" parent="Player/Sprite"]
`;
    // Add a child to Player — should go AFTER Sprite AND Anim
    const result = addNode(deepScene, {
      parent: 'Player',
      name: 'HealthBar',
      type: 'Control',
    });

    expect(result.success).toBe(true);

    const scene = result.scene!;
    const playerIdx = scene.indexOf('[node name="Player"');
    const spriteIdx = scene.indexOf('[node name="Sprite"');
    const animIdx = scene.indexOf('[node name="Anim"');
    const healthIdx = scene.indexOf('[node name="HealthBar"');

    // Ordering: Player < Sprite < Anim < HealthBar
    expect(playerIdx).toBeLessThan(spriteIdx);
    expect(spriteIdx).toBeLessThan(animIdx);
    expect(animIdx).toBeLessThan(healthIdx);
  });

  it('increments load_steps when adding node', () => {
    const result = addNode(SIMPLE_SCENE, {
      parent: '.',
      name: 'NewChild',
      type: 'Node2D',
    });

    expect(result.scene).toContain('load_steps=3');
  });

  it('preserves original scene structure', () => {
    const result = addNode(SIMPLE_SCENE, {
      parent: '.',
      name: 'NewChild',
      type: 'Node2D',
    });

    // Original nodes and resources preserved
    expect(result.scene).toContain('[ext_resource type="Script" path="res://player.gd" id="1"]');
    expect(result.scene).toContain('[node name="Root" type="Node2D"]');
    expect(result.scene).toContain('script = ExtResource("1")');
  });

  it('handles null property value', () => {
    const result = addNode(SIMPLE_SCENE, {
      parent: '.',
      name: 'Node',
      type: 'Node',
      properties: {
        metadata: null,
      },
    });

    expect(result.success).toBe(true);
    expect(result.scene).toContain('metadata = null');
  });
});
