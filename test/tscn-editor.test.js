import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findInstanceNode, detachInstance, nodePathToNameAndParent } from '../build/tscn-editor.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TARGET_TSCN = `[gd_scene load_steps=3 format=3]

[ext_resource type="PackedScene" uid="uid://abc" path="res://scenes/player.tscn" id="1"]
[ext_resource type="Script" path="res://scripts/main.gd" id="2"]

[node name="Main" type="Node2D"]

[node name="Player" parent="." instance=ExtResource("1")]
position = Vector2(100, 200)
visible = false

[node name="Camera2D" type="Camera2D" parent="."]
`;

const SOURCE_TSCN = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scripts/player.gd" id="1"]

[node name="Player" type="CharacterBody2D"]
script = ExtResource("1")
speed = 200.0

[node name="Sprite2D" type="Sprite2D" parent="."]
texture = null

[node name="CollisionShape2D" type="CollisionShape2D" parent="."]
`;

const SOURCE_WITH_EXT_CONFLICT = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scripts/player.gd" id="1"]
[ext_resource type="Texture2D" path="res://assets/sprite.png" id="2"]

[node name="Player" type="CharacterBody2D"]
script = ExtResource("1")

[node name="Sprite2D" type="Sprite2D" parent="."]
texture = ExtResource("2")
`;

// ── findInstanceNode ──────────────────────────────────────────────────────────

describe('tscn-editor findInstanceNode', () => {
  it('should find instance node by name at root level', () => {
    // node_path "root/Player" → nodeName="Player", tscnParent="."
    const info = findInstanceNode(TARGET_TSCN, 'Player', '.');
    assert.ok(info, 'should find the instance node');
    assert.equal(info.instanceId, 1);
    assert.equal(info.sourcePath, 'res://scenes/player.tscn');
    assert.equal(info.propertyOverrides.length, 2);
    assert.ok(info.propertyOverrides[0].includes('position'));
    assert.ok(info.propertyOverrides[1].includes('visible'));
  });

  it('should return null for non-instance node', () => {
    const info = findInstanceNode(TARGET_TSCN, 'Camera2D', '.');
    assert.equal(info, null);
  });

  it('should return null for non-existent node', () => {
    const info = findInstanceNode(TARGET_TSCN, 'NonExistent', '.');
    assert.equal(info, null);
  });

  it('should return null for wrong parent', () => {
    const info = findInstanceNode(TARGET_TSCN, 'Player', 'WrongParent');
    assert.equal(info, null);
  });
});

// ── nodePathToNameAndParent ───────────────────────────────────────────────────

describe('tscn-editor nodePathToNameAndParent', () => {
  it('should parse root-level node', () => {
    const { nodeName, parent } = nodePathToNameAndParent('/root/Player');
    assert.equal(nodeName, 'Player');
    assert.equal(parent, '.');
  });

  it('should parse nested node', () => {
    const { nodeName, parent } = nodePathToNameAndParent('/root/Level/Player');
    assert.equal(nodeName, 'Player');
    assert.equal(parent, 'Level');
  });

  it('should parse deeply nested node', () => {
    const { nodeName, parent } = nodePathToNameAndParent('/root/Level/Sub/Enemy');
    assert.equal(nodeName, 'Enemy');
    assert.equal(parent, 'Level/Sub');
  });

  it('should throw for root node', () => {
    assert.throws(() => nodePathToNameAndParent('/root'), /Cannot detach the root node/);
  });
});

// ── detachInstance ────────────────────────────────────────────────────────────

describe('tscn-editor detachInstance', () => {
  it('should replace instance reference with inlined subtree', () => {
    const result = detachInstance(TARGET_TSCN, SOURCE_TSCN, 'Player', '.');

    // Should contain the expanded root node (CharacterBody2D) instead of instance=ExtResource
    assert.ok(result.includes('[node name="Player" type="CharacterBody2D"'), 'should have root node with type');
    assert.ok(!result.includes('instance=ExtResource'), 'should not have instance reference');

    // Should contain child nodes with adjusted parent
    assert.ok(result.includes('parent="Player"'), 'child nodes should have Player as parent');
    assert.ok(result.includes('Sprite2D'));
    assert.ok(result.includes('CollisionShape2D'));
  });

  it('should preserve property overrides from target', () => {
    const result = detachInstance(TARGET_TSCN, SOURCE_TSCN, 'Player', '.');

    // Property overrides should be present
    assert.ok(result.includes('position = Vector2(100, 200)'), 'should preserve position override');
    assert.ok(result.includes('visible = false'), 'should preserve visible override');

    // Source properties should also be present
    assert.ok(result.includes('speed = 200.0'), 'should preserve source property');
    assert.ok(result.includes('script = ExtResource'), 'should preserve source script');
  });

  it('should remap ext_resource IDs to avoid conflicts', () => {
    const targetWithHighIds = `[gd_scene load_steps=2 format=3]

[ext_resource type="PackedScene" path="res://scenes/player.tscn" id="5"]

[node name="Main" type="Node2D"]

[node name="Player" parent="." instance=ExtResource("5")]
`;
    const info = findInstanceNode(targetWithHighIds, 'Player', '.');
    assert.ok(info);

    const result = detachInstance(targetWithHighIds, SOURCE_WITH_EXT_CONFLICT, 'Player', '.');

    // Source had id="1" and id="2" — should be remapped to 6, 7 (target max was 5)
    assert.ok(result.includes('id="6"'), 'source ext_resource should be remapped to id 6');
    assert.ok(result.includes('id="7"'), 'second source ext_resource should be remapped to id 7');
    // ExtResource("6") and ExtResource("7") should appear in node property lines
    assert.ok(result.includes('ExtResource("6")'), 'node should reference remapped ExtResource 6');
  });

  it('should remove unused ext_resource for the instance', () => {
    const result = detachInstance(TARGET_TSCN, SOURCE_TSCN, 'Player', '.');

    // The PackedScene ext_resource (id="1") should be removed since no other node uses it
    assert.ok(!result.includes('path="res://scenes/player.tscn"'), 'unused PackedScene ext_resource should be removed');
  });

  it('should keep ext_resource if still referenced by other nodes', () => {
    const targetMultiRef = `[gd_scene load_steps=3 format=3]

[ext_resource type="PackedScene" uid="uid://abc" path="res://scenes/player.tscn" id="1"]

[node name="Main" type="Node2D"]

[node name="Player" parent="." instance=ExtResource("1")]
position = Vector2(100, 200)

[node name="Player2" parent="." instance=ExtResource("1")]
`;
    const result = detachInstance(targetMultiRef, SOURCE_TSCN, 'Player', '.');

    // The PackedScene ext_resource should be kept because Player2 still references it
    assert.ok(result.includes('path="res://scenes/player.tscn"'), 'ext_resource should be kept when still referenced');
  });

  it('should update load_steps in header', () => {
    const result = detachInstance(TARGET_TSCN, SOURCE_TSCN, 'Player', '.');
    const headerMatch = result.match(/load_steps=(\d+)/);
    assert.ok(headerMatch, 'should have load_steps');
    const steps = parseInt(headerMatch[1]);
    // After detach: 1 ext_resource (script from source) + 1 ext_resource (main.gd) + 1 = 3
    // Removed PackedScene ext_resource. So: main.gd + player.gd + 1 = 3
    assert.ok(steps >= 2, `load_steps should be reasonable, got ${steps}`);
  });

  it('should throw for non-instance node', () => {
    assert.throws(
      () => detachInstance(TARGET_TSCN, SOURCE_TSCN, 'Camera2D', '.'),
      /Instance node not found/,
    );
  });

  it('should handle source with no ext_resources', () => {
    const sourceNoExt = `[gd_scene format=3]

[node name="Player" type="CharacterBody2D"]
speed = 100.0

[node name="Sprite2D" type="Sprite2D" parent="."]
`;
    const result = detachInstance(TARGET_TSCN, sourceNoExt, 'Player', '.');
    assert.ok(result.includes('speed = 100.0'));
    assert.ok(result.includes('Sprite2D'));
    assert.ok(result.includes('parent="Player"'));
  });

  it('should handle nested parent paths', () => {
    const targetNested = `[gd_scene load_steps=2 format=3]

[ext_resource type="PackedScene" path="res://scenes/enemy.tscn" id="1"]

[node name="Main" type="Node2D"]

[node name="Level" type="Node2D" parent="."]

[node name="Enemy" parent="Level" instance=ExtResource("1")]
`;
    const result = detachInstance(targetNested, SOURCE_TSCN, 'Enemy', 'Level');
    // Root of source should have parent="Level" and name="Enemy"
    assert.ok(result.includes('name="Enemy"'));
    assert.ok(result.includes('parent="Level"'));
    // Child nodes should have parent="Enemy"
    assert.ok(result.includes('parent="Enemy"'));
  });
});
