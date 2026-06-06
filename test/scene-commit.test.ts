// test/scene-commit.test.ts
import { describe, it, expect } from 'vitest';
import { generateCommitScript, COMMIT_OPERATIONS } from '../src/tools/scene-commit.js';

describe('scene-commit: generateCommitScript', () => {
  it('generates valid GDScript for tile_set operation', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [
        { op: 'tile_set', node_path: 'Ground', coords: { x: 5, y: 10 }, source_id: 0, atlas: { x: 0, y: 0 } },
      ],
      true, // save
    );
    expect(script).toContain('extends SceneTree');
    expect(script).toContain('get_node_or_null("Ground")');
    expect(script).toContain('set_cell(Vector2i(5, 10)');
    expect(script).toContain('ResourceSaver.save');
  });

  it('generates _fill_tiles helper for tile_fill', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [
        { op: 'tile_fill', node_path: 'Ground', region: { x: 0, y: 0, w: 20, h: 2 }, source_id: 0, atlas: { x: 0, y: 0 } },
      ],
      true,
    );
    expect(script).toContain('func _fill_tiles(');
    // _fill_tiles uses parameterized range, not hardcoded values
    expect(script).toContain('range(ry, ry + rh)');
    // But the call site passes concrete values
    expect(script).toContain('_fill_tiles(n1, 0, 0, 20, 2,');
  });

  it('does not generate _fill_tiles when no tile_fill ops', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [
        { op: 'tile_set', node_path: 'Ground', coords: { x: 1, y: 1 }, source_id: 0, atlas: { x: 0, y: 0 } },
      ],
      true,
    );
    expect(script).not.toContain('func _fill_tiles');
  });

  it('generates node_property operation', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [
        { op: 'node_property', path: 'Player', property: 'position', value: 'Vector2(100, 200)' },
      ],
      true,
    );
    expect(script).toContain('get_node_or_null("Player")');
    expect(script).toContain('.position');
  });

  it('generates node_add operation', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [
        { op: 'node_add', parent: '.', name: 'Coin', type: 'Area2D' },
      ],
      true,
    );
    expect(script).toContain('Area2D.new()');
    expect(script).toContain('.name = "Coin"');
  });

  it('generates node_add with root parent (empty string)', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [
        { op: 'node_add', parent: '.', name: 'Player', type: 'CharacterBody2D' },
      ],
      true,
    );
    // parent "." maps to empty string for get_node_or_null
    expect(script).toContain('get_node_or_null("")');
  });

  it('stops on error when stop_on_error=true', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [
        { op: 'tile_set', node_path: 'Ground', coords: { x: 5, y: 10 }, source_id: 0, atlas: { x: 0, y: 0 } },
      ],
      true,
      true, // stop_on_error
    );
    expect(script).toContain('_has_error');
    expect(script).toContain('if _has_error');
  });

  it('does not include stop check when stop_on_error=false', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [
        { op: 'tile_set', node_path: 'Ground', coords: { x: 5, y: 10 }, source_id: 0, atlas: { x: 0, y: 0 } },
      ],
      true,
      false, // stop_on_error
    );
    expect(script).toContain('continue despite error');
    // Should not have the final stop block
    expect(script).not.toMatch(/if _has_error:\s+print\("COMMIT_RESULT/);
  });

  it('includes COMMIT_RESULT output', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [
        { op: 'tile_set', node_path: 'Ground', coords: { x: 5, y: 10 }, source_id: 0, atlas: { x: 0, y: 0 } },
      ],
      true,
    );
    expect(script).toContain('COMMIT_RESULT');
  });

  it('generates tile_erase operation', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [
        { op: 'tile_erase', node_path: 'Ground', coords: { x: 5, y: 10 } },
      ],
      false,
    );
    expect(script).toContain('set_cell(Vector2i(5, 10), -1)');
  });

  it('generates tile_clear operation', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [
        { op: 'tile_clear', node_path: 'Ground' },
      ],
      false,
    );
    expect(script).toContain('.clear()');
  });

  it('skips save block when save=false', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [
        { op: 'tile_set', node_path: 'Ground', coords: { x: 1, y: 1 }, source_id: 0, atlas: { x: 0, y: 0 } },
      ],
      false,
    );
    expect(script).not.toContain('ResourceSaver.save');
    expect(script).toContain('"saved": false');
  });

  it('generates tileset_assign operation', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [
        { op: 'tileset_assign', node_path: 'TileMap', tileset_path: 'res://assets/tiles.tres' },
      ],
      true,
    );
    expect(script).toContain('get_node_or_null("TileMap")');
    expect(script).toContain('load("res://assets/tiles.tres")');
    expect(script).toContain('.tile_set = ');
  });

  it('generates load failure guard', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [],
      true,
    );
    expect(script).toContain('if scene == null');
    expect(script).toContain('Failed to load scene');
  });

  it('generates cells_affected for tile_fill', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [
        { op: 'tile_fill', node_path: 'Ground', region: { x: 0, y: 0, w: 10, h: 5 }, source_id: 0, atlas: { x: 0, y: 0 } },
      ],
      true,
    );
    expect(script).toContain('"cells_affected": 50');
  });

  it('exports COMMIT_OPERATIONS with all 7 ops', () => {
    expect(COMMIT_OPERATIONS).toEqual([
      'tile_set', 'tile_fill', 'tile_erase', 'tile_clear',
      'tileset_assign', 'node_property', 'node_add',
    ]);
  });

  it('handles multiple operations in sequence', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [
        { op: 'tile_fill', node_path: 'Ground', region: { x: 0, y: 0, w: 10, h: 2 }, source_id: 0, atlas: { x: 0, y: 0 } },
        { op: 'tile_set', node_path: 'Ground', coords: { x: 5, y: 5 }, source_id: 1, atlas: { x: 1, y: 0 } },
        { op: 'node_property', path: 'Player', property: 'speed', value: 200 },
      ],
      true,
    );
    // Each op gets a unique var name
    expect(script).toContain('var n1');
    expect(script).toContain('var n2');
    expect(script).toContain('var n3');
    expect(script).toContain('_fill_tiles');
    expect(script).toContain('speed');
  });
});

describe('serializeGdValue type inference', () => {
  it('infers Vector3 from {x, y, z}', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [{ op: 'node_property', path: 'Player', property: 'position', value: { x: 10, y: 0, z: 5 } }],
      true,
    );
    expect(script).toContain('.position = Vector3(10, 0, 5)');
  });

  it('infers Vector2 from {x, y}', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [{ op: 'node_property', path: 'Player', property: 'position', value: { x: 100, y: 200 } }],
      true,
    );
    expect(script).toContain('.position = Vector2(100, 200)');
  });

  it('infers Rect2 from {x, y, w, h}', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [{ op: 'node_property', path: 'Camera', property: 'limit', value: { x: 0, y: 0, w: 800, h: 600 } }],
      true,
    );
    expect(script).toContain('.limit = Rect2(0, 0, 800, 600)');
  });

  it('infers Color from {r, g, b}', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [{ op: 'node_property', path: 'Light', property: 'color', value: { r: 1, g: 0.5, b: 0, a: 0.8 } }],
      true,
    );
    expect(script).toContain('.color = Color(1, 0.5, 0, 0.8)');
  });

  it('uses _type override for Vector2i', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [{ op: 'node_property', path: 'Grid', property: 'cell_size', value: { x: 32, y: 32, _type: 'Vector2i' } }],
      true,
    );
    expect(script).toContain('.cell_size = Vector2i(32, 32)');
  });

  it('uses _type override for Rect2i', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [{ op: 'node_property', path: 'Region', property: 'bounds', value: { x: 0, y: 0, w: 100, h: 50, _type: 'Rect2i' } }],
      true,
    );
    expect(script).toContain('.bounds = Rect2i(0, 0, 100, 50)');
  });

  it('serializes arrays', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [{ op: 'node_property', path: 'Node', property: 'values', value: [1, 2, 3] }],
      true,
    );
    expect(script).toContain('.values = [1, 2, 3]');
  });

  it('falls back to JSON for unknown objects', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [{ op: 'node_property', path: 'Node', property: 'data', value: { foo: 'bar', baz: 42 } }],
      true,
    );
    expect(script).toContain('.data = {"foo":"bar","baz":42}');
  });

  it('node_add properties also use type inference', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [{ op: 'node_add', type: 'Node3D', name: 'Marker', parent: '.', properties: { position: { x: 5, y: 0, z: 10 } } }],
      true,
    );
    expect(script).toContain('.position = Vector3(5, 0, 10)');
  });
});
