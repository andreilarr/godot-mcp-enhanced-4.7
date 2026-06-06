// P2: scene_commit — batch GDScript generator for multi-operation scene editing.
// Generates a single GDScript that loads a scene, executes multiple operations,
// optionally saves, and reports structured results via COMMIT_RESULT prefix.

export const COMMIT_OPERATIONS = [
  'tile_set', 'tile_fill', 'tile_erase', 'tile_clear',
  'tileset_assign', 'node_property', 'node_add',
] as const;

export type CommitOp = typeof COMMIT_OPERATIONS[number];

interface TileSetOp {
  op: 'tile_set';
  node_path: string;
  coords: { x: number; y: number };
  source_id: number;
  atlas: { x: number; y: number };
  alternative_tile?: number;
}

interface TileFillOp {
  op: 'tile_fill';
  node_path: string;
  region: { x: number; y: number; w: number; h: number };
  source_id: number;
  atlas: { x: number; y: number };
  alternative_tile?: number;
}

interface TileEraseOp {
  op: 'tile_erase';
  node_path: string;
  coords: { x: number; y: number };
}

interface TileClearOp {
  op: 'tile_clear';
  node_path: string;
}

interface TilesetAssignOp {
  op: 'tileset_assign';
  node_path: string;
  tileset_path: string;
}

interface NodePropertyOp {
  op: 'node_property';
  path: string;
  property: string;
  value: unknown;
}

interface NodeAddOp {
  op: 'node_add';
  parent: string;
  name: string;
  type: string;
  properties?: Record<string, unknown>;
}

export type CommitOperation =
  | TileSetOp | TileFillOp | TileEraseOp | TileClearOp
  | TilesetAssignOp | NodePropertyOp | NodeAddOp;

/**
 * Generate a complete GDScript that executes all operations in sequence,
 * optionally saves the scene, and reports structured results.
 */
export function generateCommitScript(
  scenePath: string,
  operations: CommitOperation[],
  save: boolean,
  stopOnError: boolean = true,
): string {
  const hasFill = operations.some(op => op.op === 'tile_fill');
  const opBlocks: string[] = [];

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i]!;
    opBlocks.push(generateOpBlock(i, op, stopOnError));
  }

  const saveBlock = save
    ? `\t# --- Save ---\n\tvar packed = PackedScene.new()\n\tpacked.pack(inst)\n\tvar err = ResourceSaver.save(packed, "${scenePath}")\n\tprint("COMMIT_RESULT: " + JSON.stringify({"success": true, "saved": err == OK, "results": _results}))`
    : `\tprint("COMMIT_RESULT: " + JSON.stringify({"success": true, "saved": false, "results": _results}))`;

  const fillHelper = hasFill
    ? `\nfunc _fill_tiles(node, rx, ry, rw, rh, sid, atlas, alt):\n\tfor cy in range(ry, ry + rh):\n\t\tfor cx in range(rx, rx + rw):\n\t\t\tnode.set_cell(Vector2i(cx, cy), sid, atlas, alt)\n`
    : '';

  const stopBlock = stopOnError
    ? `\n\tif _has_error:\n\t\tprint("COMMIT_RESULT: " + JSON.stringify({"success": false, "saved": false, "error_count": _results.filter(func(r): return not r.ok).size(), "results": _results}))\n\t\tquit()\n\t\treturn`
    : '';

  return `extends SceneTree

var _results = []
var _has_error = false
${fillHelper}
func _initialize():
\tvar scene = load("${scenePath}")
\tif scene == null:
\t\tprint("COMMIT_RESULT: " + JSON.stringify({"success": false, "saved": false, "error": "Failed to load scene", "results": []}))
\t\tquit()
\t\treturn
\tvar inst = scene.instantiate()
${opBlocks.join('\n')}${stopBlock}
${saveBlock}
\tquit()
`;
}

function generateOpBlock(index: number, op: CommitOperation, stopOnError: boolean): string {
  const idx = index + 1;
  const errAction = stopOnError
    ? '\t\t_has_error = true'
    : '\t\t# continue despite error';

  switch (op.op) {
    case 'tile_set': {
      const alt = op.alternative_tile ?? 0;
      return `
\t# --- Op ${idx}: tile_set ${op.node_path} ---
\tvar n${idx} = inst.get_node_or_null("${op.node_path}")
\tif n${idx} == null:
\t\t_results.append({"op": "tile_set", "node_path": "${op.node_path}", "ok": false, "error": "Node not found"})
${errAction}
\telse:
\t\tn${idx}.set_cell(Vector2i(${op.coords.x}, ${op.coords.y}), ${op.source_id}, Vector2i(${op.atlas.x}, ${op.atlas.y}), ${alt})
\t\t_results.append({"op": "tile_set", "node_path": "${op.node_path}", "ok": true})`;
    }
    case 'tile_fill': {
      const alt = op.alternative_tile ?? 0;
      const cells = op.region.w * op.region.h;
      return `
\t# --- Op ${idx}: tile_fill ${op.node_path} ---
\tvar n${idx} = inst.get_node_or_null("${op.node_path}")
\tif n${idx} == null:
\t\t_results.append({"op": "tile_fill", "node_path": "${op.node_path}", "ok": false, "error": "Node not found"})
${errAction}
\telse:
\t\t_fill_tiles(n${idx}, ${op.region.x}, ${op.region.y}, ${op.region.w}, ${op.region.h}, ${op.source_id}, Vector2i(${op.atlas.x}, ${op.atlas.y}), ${alt})
\t\t_results.append({"op": "tile_fill", "node_path": "${op.node_path}", "ok": true, "cells_affected": ${cells}})`;
    }
    case 'tile_erase': {
      return `
\t# --- Op ${idx}: tile_erase ${op.node_path} ---
\tvar n${idx} = inst.get_node_or_null("${op.node_path}")
\tif n${idx} == null:
\t\t_results.append({"op": "tile_erase", "node_path": "${op.node_path}", "ok": false, "error": "Node not found"})
${errAction}
\telse:
\t\tn${idx}.set_cell(Vector2i(${op.coords.x}, ${op.coords.y}), -1)
\t\t_results.append({"op": "tile_erase", "node_path": "${op.node_path}", "ok": true})`;
    }
    case 'tile_clear': {
      return `
\t# --- Op ${idx}: tile_clear ${op.node_path} ---
\tvar n${idx} = inst.get_node_or_null("${op.node_path}")
\tif n${idx} == null:
\t\t_results.append({"op": "tile_clear", "node_path": "${op.node_path}", "ok": false, "error": "Node not found"})
${errAction}
\telse:
\t\tn${idx}.clear()
\t\t_results.append({"op": "tile_clear", "node_path": "${op.node_path}", "ok": true})`;
    }
    case 'tileset_assign': {
      return `
\t# --- Op ${idx}: tileset_assign ${op.node_path} ---
\tvar n${idx} = inst.get_node_or_null("${op.node_path}")
\tif n${idx} == null:
\t\t_results.append({"op": "tileset_assign", "node_path": "${op.node_path}", "ok": false, "error": "Node not found"})
${errAction}
\telse:
\t\tn${idx}.tile_set = load("${op.tileset_path}")
\t\t_results.append({"op": "tileset_assign", "node_path": "${op.node_path}", "ok": true})`;
    }
    case 'node_property': {
      return `
\t# --- Op ${idx}: node_property ${op.path} ---
\tvar n${idx} = inst.get_node_or_null("${op.path}")
\tif n${idx} == null:
\t\t_results.append({"op": "node_property", "path": "${op.path}", "ok": false, "error": "Node not found"})
${errAction}
\telse:
\t\tn${idx}.${op.property} = ${serializeGdValue(op.value)}
\t\t_results.append({"op": "node_property", "path": "${op.path}", "ok": true})`;
    }
    case 'node_add': {
      const propLines = op.properties
        ? Object.entries(op.properties)
          .map(([k, v]) => `\t\tchild${idx}.${k} = ${serializeGdValue(v)}`)
          .join('\n') + '\n'
        : '';
      const parentPath = op.parent === '.' ? '' : op.parent;
      return `
\t# --- Op ${idx}: node_add ${op.name} ---
\tvar child${idx} = ${op.type}.new()
\tchild${idx}.name = "${op.name}"
${propLines}\tvar parent${idx} = inst.get_node_or_null("${parentPath}")
\tif parent${idx} == null:
\t\t_results.append({"op": "node_add", "name": "${op.name}", "ok": false, "error": "Parent not found: ${op.parent}"})
${errAction}
\telse:
\t\tparent${idx}.add_child(child${idx})
\t\tchild${idx}.owner = inst
\t\t_results.append({"op": "node_add", "name": "${op.name}", "ok": true})`;
    }
  }
}

function serializeGdValue(value: unknown): string {
  if (typeof value === 'string') return `"${value.replace(/"/g, '\\"')}"`;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
