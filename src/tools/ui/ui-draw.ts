// UI draw recipe operations.

import { gdEscape, SCENE_TREE_HEADER } from '../shared.js';
import { ensureNumber } from '../shared/validation.js';
import { DRAW_OP_KINDS, colorToGd } from './types.js';
import type { DrawOp } from './types.js';

const MAX_DRAW_OPS = 200;

export { MAX_DRAW_OPS };

function drawOpToGd(op: DrawOp): string {
  const col = (c: unknown) => colorToGd(c ?? [1, 1, 1, 1]);
  const numArr = (v: unknown, minLen: number): number[] => {
    if (!Array.isArray(v) || v.length < minLen) throw new Error(`${op.kind}: expected array with >= ${minLen} elements`);
    if (!v.every(el => typeof el === 'number')) throw new Error(`${op.kind}: expected all elements to be numbers`);
    return v as number[];
  };
  const validatePointArray = (v: unknown, kind: string): number[][] => {
    if (!Array.isArray(v) || v.length < 1) throw new Error(`${kind}: expected non-empty array of points`);
    for (const p of v) {
      if (!Array.isArray(p) || p.length < 2 || !p.every(el => typeof el === 'number'))
        throw new Error(`${kind}: each point must be an array of >= 2 numbers`);
    }
    return v as number[][];
  };

  switch (op.kind) {
    case 'rect': {
      const pos = numArr(op.position, 2);
      const sz = numArr(op.size, 2);
      return `\tnode.draw_rect(Rect2(${pos[0]}, ${pos[1]}, ${sz[0]}, ${sz[1]}), ${col(op.color)})`;
    }
    case 'circle': {
      const ctr = numArr(op.center, 2);
      const r = ensureNumber(op.radius, 'circle.radius');
      return `\tnode.draw_circle(Vector2(${ctr[0]}, ${ctr[1]}), ${r}, ${col(op.color)})`;
    }
    case 'line': {
      const from = numArr(op.from, 2);
      const to = numArr(op.to, 2);
      const w = op.width == null ? undefined : ensureNumber(op.width, 'line.width');
      return `\tnode.draw_line(Vector2(${from[0]}, ${from[1]}), Vector2(${to[0]}, ${to[1]}), ${col(op.color)}${w != null ? `, ${w}` : ''})`;
    }
    case 'arc': {
      const ctr = numArr(op.center, 2);
      const r = ensureNumber(op.radius, 'arc.radius');
      const sa = ensureNumber(op.start_angle, 'arc.start_angle');
      const ea = ensureNumber(op.end_angle, 'arc.end_angle');
      const pointCount = op.point_count == null ? 32 : ensureNumber(op.point_count, 'arc.point_count');
      const w = op.width == null ? undefined : ensureNumber(op.width, 'arc.width');
      return `\tnode.draw_arc(Vector2(${ctr[0]}, ${ctr[1]}), ${r}, ${sa}, ${ea}, ${pointCount}, ${col(op.color)}${w != null ? `, ${w}` : ''})`;
    }
    case 'polygon': {
      const pts = validatePointArray(op.points, 'polygon');
      const packedPts = pts.map(p => `Vector2(${p[0]}, ${p[1]})`).join(', ');
      const filled = op.filled !== false;
      if (filled) {
        return `\tnode.draw_colored_polygon(PackedVector2Array([${packedPts}]), ${col(op.color)})`;
      }
      const w = op.width == null ? undefined : ensureNumber(op.width, 'polygon.width');
      return `\tnode.draw_polyline(PackedVector2Array([${packedPts}]), ${col(op.color)}${w != null ? `, ${w}` : ''})`;
    }
    case 'polyline': {
      const pts = validatePointArray(op.points, 'polyline');
      const packedPts = pts.map(p => `Vector2(${p[0]}, ${p[1]})`).join(', ');
      const w = op.width == null ? undefined : ensureNumber(op.width, 'polyline.width');
      return `\tnode.draw_polyline(PackedVector2Array([${packedPts}]), ${col(op.color)}${w != null ? `, ${w}` : ''})`;
    }
    case 'string': {
      const text = String(op.text ?? '');
      const pos = numArr(op.position, 2);
      const fs = op.font_size == null ? 16 : ensureNumber(op.font_size, 'string.font_size');
      return `\tnode.draw_string(ThemeDB.fallback_font, Vector2(${pos[0]}, ${pos[1]}), "${gdEscape(text)}", HORIZONTAL_ALIGNMENT_LEFT, -1, ${fs}, ${col(op.color)})`;
    }
    default:
      throw new Error(`Unknown draw op kind: "${op.kind}". Must be one of: ${DRAW_OP_KINDS.join(', ')}`);
  }
}

export function genUiDrawRecipeScript(
  scenePath: string,
  nodePath: string,
  ops: DrawOp[],
): string {
  if (ops.length > MAX_DRAW_OPS) {
    throw new Error(`Maximum ${MAX_DRAW_OPS} draw ops allowed, got ${ops.length}`);
  }

  // Each drawOpToGd line already has one \t; add another \t because lines
  // are inside a lambda body that itself is inside _initialize().
  const drawLines = ops.map(op => '\t' + drawOpToGd(op)).join('\n');

  return `${SCENE_TREE_HEADER}
func _initialize():
\tif not _mcp_load_scene("${gdEscape(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar node = _mcp_get_scene_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not node is Control:
\t\t_mcp_output("error", "Node is not a Control: " + node.get_class())
\t\t_mcp_done()
\t\treturn
\tvar _draw_fn = func():
${drawLines || '\t\tpass'}
\tnode.draw.connect(_draw_fn)
\tnode.queue_redraw()
\t_mcp_output("draw_recipe_attached", {"node": "${gdEscape(nodePath)}", "ops_count": ${ops.length}})
\t_mcp_done()
`;
}
