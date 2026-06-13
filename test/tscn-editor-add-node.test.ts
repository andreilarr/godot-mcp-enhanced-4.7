import { describe, it, expect } from 'vitest';
import { addNode, canSerializeProperty, formatPropertyValue } from '../src/tscn-editor.js';
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

  it('allows arrays of primitives', () => {
    expect(canSerializeProperty([1, 2, 3])).toBe(true);
    expect(canSerializeProperty([])).toBe(true);
    expect(canSerializeProperty(['a'])).toBe(true);
  });

  it('rejects arrays with nested objects', () => {
    expect(canSerializeProperty([{ x: 1 }])).toBe(false);
    expect(canSerializeProperty([[1, 2]])).toBe(false);
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

  it('serializes array properties of primitives', () => {
    const result = addNode(SIMPLE_SCENE, {
      parent: '.',
      name: 'ArrNode',
      type: 'Node2D',
      properties: {
        items: [1, 2, 3],
      },
    });

    expect(result.success).toBe(true);
    expect(result.fallback).toBe(false);
    expect(result.scene).toContain('items = [1, 2, 3]');
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

describe('formatPropertyValue', () => {
  it('formats Vector2 from {x, y}', () => {
    expect(formatPropertyValue({ x: 10, y: 20 })).toBe('Vector2(10, 20)');
  });

  it('formats Vector3 from {x, y, z}', () => {
    expect(formatPropertyValue({ x: 1, y: 2, z: 3 })).toBe('Vector3(1, 2, 3)');
  });

  it('formats Rect2 from {x, y, w, h}', () => {
    expect(formatPropertyValue({ x: 0, y: 0, w: 100, h: 50 })).toBe('Rect2(0, 0, 100, 50)');
  });

  it('formats Color from {r, g, b}', () => {
    expect(formatPropertyValue({ r: 1, g: 0, b: 0 })).toBe('Color(1, 0, 0, 1)');
  });

  it('formats Color with alpha from {r, g, b, a}', () => {
    expect(formatPropertyValue({ r: 0.5, g: 0.5, b: 0.5, a: 0.8 })).toBe('Color(0.5, 0.5, 0.5, 0.8)');
  });

  it('uses _type override for Vector2i', () => {
    expect(formatPropertyValue({ x: 10, y: 20, _type: 'Vector2i' })).toBe('Vector2i(10, 20)');
  });

  it('uses _type override for Rect2i', () => {
    expect(formatPropertyValue({ x: 0, y: 0, w: 100, h: 50, _type: 'Rect2i' })).toBe('Rect2i(0, 0, 100, 50)');
  });

  it('uses _type override for Vector3i', () => {
    expect(formatPropertyValue({ x: 1, y: 2, z: 3, _type: 'Vector3i' })).toBe('Vector3i(1, 2, 3)');
  });

  it('formats Array of numbers', () => {
    expect(formatPropertyValue([1, 2, 3])).toBe('[1, 2, 3]');
  });

  it('formats Array of strings', () => {
    expect(formatPropertyValue(['a', 'b'])).toBe('["a", "b"]');
  });

  it('formats Array of booleans', () => {
    expect(formatPropertyValue([true, false])).toBe('[true, false]');
  });

  it('formats Rect2 before Vector3 when both w and z present', () => {
    // Rect2 pattern takes priority when w/h are present
    expect(formatPropertyValue({ x: 0, y: 0, w: 100, h: 50, z: 3 })).toBe('Rect2(0, 0, 100, 50)');
  });

  it('uses _type Color override', () => {
    expect(formatPropertyValue({ r: 1, g: 0, b: 0, a: 0.5, _type: 'Color' })).toBe('Color(1, 0, 0, 0.5)');
  });
});

describe('canSerializeProperty (extended)', () => {
  it('allows arrays of primitives', () => {
    expect(canSerializeProperty([1, 2, 3])).toBe(true);
    expect(canSerializeProperty(['a', 'b'])).toBe(true);
    expect(canSerializeProperty([true, false])).toBe(true);
  });

  it('rejects arrays with nested objects', () => {
    expect(canSerializeProperty([{ x: 1 }])).toBe(false);
    expect(canSerializeProperty([[1, 2]])).toBe(false);
  });

  it('allows objects with _type field', () => {
    expect(canSerializeProperty({ x: 10, y: 20, _type: 'Vector2i' })).toBe(true);
    expect(canSerializeProperty({ x: 0, y: 0, w: 100, h: 50, _type: 'Rect2i' })).toBe(true);
  });
});

// ── F-2/F-3 review fixes (2026-06-13):非有限数守卫 + addNode 属性 key 校验 ──
describe('F-2: canSerializeProperty rejects non-finite numbers', () => {
  it('rejects NaN and Infinity as scalar number', () => {
    expect(canSerializeProperty(NaN)).toBe(false);
    expect(canSerializeProperty(Infinity)).toBe(false);
    expect(canSerializeProperty(-Infinity)).toBe(false);
  });

  it('rejects arrays containing non-finite numbers', () => {
    expect(canSerializeProperty([1, NaN, 3])).toBe(false);
    expect(canSerializeProperty([Infinity])).toBe(false);
  });

  it('rejects Vector/Color-like objects with non-finite fields', () => {
    expect(canSerializeProperty({ x: NaN, y: 0 })).toBe(false);
    expect(canSerializeProperty({ x: 1, y: 2, z: Infinity })).toBe(false);
    expect(canSerializeProperty({ r: 1, g: 0, b: NaN })).toBe(false);
  });

  it('still accepts finite numbers (regression guard)', () => {
    expect(canSerializeProperty(0)).toBe(true);
    expect(canSerializeProperty(-1.5)).toBe(true);
    expect(canSerializeProperty({ x: 0, y: 0 })).toBe(true);
  });
});

describe('F-2: formatPropertyValue never emits NaN/Infinity', () => {
  it('serializes non-finite scalar number as null', () => {
    expect(formatPropertyValue(NaN)).toBe('null');
    expect(formatPropertyValue(Infinity)).toBe('null');
    expect(formatPropertyValue(-Infinity)).toBe('null');
  });

  it('replaces non-finite Vector/Color fields with fallback (no NaN/Infinity literal)', () => {
    // 1e999 经 JSON.parse → Infinity;Vector/Color 字段必须不写出 NaN/Infinity 字面量
    const v2 = formatPropertyValue({ x: 1e999, y: 0 });
    expect(v2).not.toContain('Infinity');
    expect(v2).not.toContain('NaN');
    expect(v2).toBe('Vector2(0, 0)');

    const col = formatPropertyValue({ r: NaN, g: 0, b: 0 });
    expect(col).not.toContain('NaN');
    expect(col).toBe('Color(0, 0, 0, 1)');

    const v3 = formatPropertyValue({ x: 1, y: 2, z: Infinity });
    expect(v3).not.toContain('Infinity');
    expect(v3).toBe('Vector3(1, 2, 0)');
  });

  it('preserves finite number formatting (regression guard)', () => {
    expect(formatPropertyValue(3.14)).toBe('3.14');
    expect(formatPropertyValue({ x: 10, y: 20 })).toBe('Vector2(10, 20)');
    expect(formatPropertyValue({ r: 1, g: 0, b: 0 })).toBe('Color(1, 0, 0, 1)');
  });
});

describe('F-3: addNode property key validation & BLOCKED_PROPS', () => {
  it('rejects property names that are not valid identifiers', () => {
    const result = addNode(SIMPLE_SCENE, {
      parent: '.', name: 'Node', type: 'Node2D',
      properties: { 'bad key!': 1 },
    });
    expect(result.success).toBe(false);
    expect(result.fallback).toBe(false);
    expect(result.message).toContain('Invalid property name');
  });

  it('rejects property keys containing newlines (no [node] injection)', () => {
    const result = addNode(SIMPLE_SCENE, {
      parent: '.', name: 'Node', type: 'Node2D',
      properties: { 'evil\n[node name="Injected" type="Node"]': 1 },
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid property name');
  });

  it('drops BLOCKED_PROPS (script/owner/name) instead of writing them', () => {
    const result = addNode(SIMPLE_SCENE, {
      parent: '.', name: 'Safe', type: 'Node2D',
      properties: {
        script: 'ExtResource("evil")',
        owner: '/root/Evil',
        name: 'Hijacked',
        visible: true,
      },
    });
    expect(result.success).toBe(true);
    // 合法属性仍写入
    expect(result.scene).toContain('visible = true');
    // script/owner/name 不得作为属性写入(与 edit_node 黑名单一致;[node name="Safe"] 头部不匹配 /^name = /m)
    expect(result.scene).not.toContain('ExtResource("evil")');
    expect(result.scene).not.toMatch(/^owner = /m);
    expect(result.scene).not.toMatch(/^name = /m);
  });

  it('still writes valid snake_case property keys', () => {
    const result = addNode(SIMPLE_SCENE, {
      parent: '.', name: 'Good', type: 'Label',
      properties: { offset_left: 10, visible: true },
    });
    expect(result.success).toBe(true);
    expect(result.scene).toContain('offset_left = 10');
    expect(result.scene).toContain('visible = true');
  });
});
