// src/tscn-editor-add.ts — Add node(s) to .tscn scene files
//
// I-10: Non-null assertions (!) on regex match groups are guarded by preceding
// `if (match)` checks — see tscn-parser.ts header for the full rationale.

import {
  normalizeLines,
  findSectionEnd,
  escapeTscnAttr,
  getBracketAttr,
  findNodeSectionLine,
  nodeSectionEnd,
  formatTscnValue,
} from './tscn-editor-shared.js';

// ── Resource add helpers ─────────────────────────────────────────────────────

/**
 * Increment load_steps in [gd_scene] header by 1.
 * If no load_steps attribute exists, adds load_steps=2.
 */
function incrementLoadSteps(lines: string[]): void {
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed.startsWith('[gd_scene')) continue;
    if (trimmed.includes('load_steps=')) {
      lines[i] = lines[i]!.replace(/load_steps=\d+/, (m) => {
        const n = parseInt(m.split('=')[1]!);
        return `load_steps=${n + 1}`;
      });
    } else {
      // Insert load_steps=2 before the closing bracket
      lines[i] = lines[i]!.replace(']', ' load_steps=2]');
    }
    return;
  }
}

// ── addNode ──────────────────────────────────────────────────────────────────

export interface AddNodeParams {
  parent: string;     // "." for root children, or node path like "Player"
  name: string;
  type: string;
  properties?: Record<string, unknown>;
}

export interface AddNodeResult {
  success: boolean;
  message: string;
  fallback: boolean;  // true = needs Godot process (unsupported property types)
  scene?: string;
}

/**
 * Check whether a property value can be safely serialized to .tscn text.
 * Returns true for primitives and flat objects with only primitive values.
 * Returns false for arrays and objects with nested objects.
 */
export function canSerializeProperty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) {
    return value.every(v =>
      v === null || v === undefined ||
      typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
    );
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const v of Object.values(obj)) {
      if (typeof v === 'object' && v !== null) return false;
    }
    return true;
  }
  return false;
}

/**
 * Format a property value for .tscn serialization.
 * - string → auto-quoted via formatTscnValue
 * - number → unquoted string
 * - boolean → true/false (unquoted)
 * - null/undefined → null
 * - Array of primitives → [v1, v2, ...]
 * - Object with _type → uses _type as constructor name
 * - Plain object with r,g,b → Color(r, g, b, a)
 * - Plain object with x,y,w,h (no z) → Rect2(x, y, w, h)
 * - Plain object with x,y,z → Vector3(x, y, z)
 * - Plain object with x,y → Vector2(x, y)
 * - Other objects → JSON stringified and auto-quoted
 */
export function formatPropertyValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return formatTscnValue(value);
  if (Array.isArray(value)) {
    const items = value.map(v => formatPropertyValue(v)).join(', ');
    return `[${items}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    // _type explicit override — always wins
    if (obj._type && typeof obj._type === 'string') {
      const t = obj._type;
      if (t === 'Rect2' || t === 'Rect2i') {
        return `${t}(${obj.x ?? 0}, ${obj.y ?? 0}, ${obj.w ?? 0}, ${obj.h ?? 0})`;
      }
      if (t === 'Vector2' || t === 'Vector2i' || t === 'Vector3' || t === 'Vector3i') {
        const args = t.startsWith('Vector3') ? [obj.x, obj.y, obj.z] : [obj.x, obj.y];
        return `${t}(${args.map(a => a ?? 0).join(', ')})`;
      }
      if (t === 'Color') {
        return `Color(${obj.r ?? 1}, ${obj.g ?? 1}, ${obj.b ?? 1}, ${obj.a ?? 1})`;
      }
      // I-01: Unknown _type intentionally falls through to auto-inference.
      // Users must use a known type or rely on auto-detection.
      // Unknown _type
    }
    // Color: has r, g, b
    if (keys.includes('r') && keys.includes('g') && keys.includes('b')
      && typeof obj.r === 'number' && typeof obj.g === 'number' && typeof obj.b === 'number') {
      const a = typeof obj.a === 'number' ? obj.a : 1;
      return `Color(${obj.r}, ${obj.g}, ${obj.b}, ${a})`;
    }
    // Rect2: has x, y, w, h
    if (keys.includes('x') && keys.includes('y') && keys.includes('w') && keys.includes('h')) {
      return `Rect2(${obj.x}, ${obj.y}, ${obj.w}, ${obj.h})`;
    }
    // Vector3: has x, y, z
    if (keys.includes('x') && keys.includes('y') && keys.includes('z')
      && typeof obj.x === 'number' && typeof obj.y === 'number' && typeof obj.z === 'number') {
      return `Vector3(${obj.x}, ${obj.y}, ${obj.z})`;
    }
    // Vector2: has x, y
    if (keys.includes('x') && keys.includes('y')
      && typeof obj.x === 'number' && typeof obj.y === 'number') {
      return `Vector2(${obj.x}, ${obj.y})`;
    }
    // C-02: Strip _type from fallback to avoid leaking meta-field into .tscn
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _type: _ignored, ...sanitized } = obj;
    return formatTscnValue(JSON.stringify(sanitized));
  }
  // Other types — should not reach here if canSerializeProperty was called
  return formatTscnValue(String(value));
}

/**
 * Find a node section line by name only (ignoring parent path).
 * Used by addNode to locate the parent node, since the parent param
 * is just a name like "Player", not a full path.
 * For "." parent, returns the root node (first node without parent attr or with parent=".").
 */
function findNodeByName(lines: string[], nodeName: string): number {
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed.startsWith('[node')) continue;
    const name = getBracketAttr(trimmed, 'name');
    if (name === nodeName) return i;
  }
  return -1;
}

/**
 * Find the insertion line index for a new child of `targetParent`.
 *
 * In .tscn files, nodes are in depth-first order. A new child of "Player"
 * must be placed AFTER all of Player's descendants (Player/Sprite,
 * Player/Sprite/Anim, etc.), not just after Player's own section.
 *
 * Algorithm:
 * 1. Find the target parent node section.
 * 2. Scan forward from the parent section.
 * 3. For each subsequent [node] section, check if its parent attribute
 *    matches the target parent OR starts with targetParent + "/".
 * 4. If yes → it's a descendant, continue scanning.
 * 5. If no → this is the insertion point (the line before this section).
 * 6. If we reach the end of file, insert there.
 */
function findLastDescendantLine(lines: string[], parentNodeLine: number, tscnParent: string): number {
  let lastDescendantEnd = nodeSectionEnd(lines, parentNodeLine);

  for (let i = parentNodeLine + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed.startsWith('[node')) continue;

    // Get parent attribute from this node
    const parentAttr = getBracketAttr(trimmed, 'parent');

    // Also check property lines for parent
    let effectiveParent = parentAttr;
    if (effectiveParent === null) {
      const end = findSectionEnd(lines, i);
      for (let j = i + 1; j < end; j++) {
        const pl = lines[j]!.trim();
        if (pl.startsWith('parent = ') || pl.startsWith('parent=')) {
          effectiveParent = pl.replace(/^parent\s*=\s*/, '').replace(/"/g, '').trim();
          break;
        }
      }
    }

    // Check if this node is a descendant of the target parent
    // For root children (tscnParent="."), descendants have parent="." or parent="ChildOfParent/..."
    // For non-root (tscnParent="Player"), descendants have parent="Player" or parent="Player/..."
    const isDescendant = effectiveParent === tscnParent ||
      (effectiveParent !== null && effectiveParent.startsWith(tscnParent + '/'));

    if (isDescendant) {
      lastDescendantEnd = nodeSectionEnd(lines, i);
    } else {
      // Not a descendant — insertion point found
      return lastDescendantEnd;
    }
  }

  return lastDescendantEnd;
}

/**
 * Add a node to a .tscn scene with property type whitelist and auto-fallback.
 *
 * If any property value cannot be serialized to .tscn text (arrays, nested objects),
 * returns `{ success: true, fallback: true }` without modifying the file,
 * signaling that a Godot process should handle the insertion instead.
 *
 * The node is inserted after the last descendant of the parent node,
 * preserving .tscn depth-first ordering.
 */
export function addNode(
  tscnContent: string,
  params: AddNodeParams,
): AddNodeResult {
  try {
  return _addNodeInner(tscnContent, params);
  } catch (err) {
    return { success: false, message: `tscn-editor error: ${err instanceof Error ? err.message : String(err)}`, fallback: false };
  }
}

function _addNodeInner(
  tscnContent: string,
  params: AddNodeParams,
): AddNodeResult {
  const { parent, name, type, properties } = params;

  // 1. Validate name and type
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    return { success: false, message: `Invalid node name: ${name}`, fallback: false };
  }
  if (!/^[A-Za-z0-9_]+$/.test(type)) {
    return { success: false, message: `Invalid node type: ${type}`, fallback: false };
  }

  // 2. Check all properties via canSerializeProperty
  if (properties) {
    for (const value of Object.values(properties)) {
      if (!canSerializeProperty(value)) {
        return {
          success: true,
          fallback: true,
          message: `Unsupported property type for node ${name}, requires Godot process`,
        };
      }
    }
  }

  const lines = normalizeLines(tscnContent);

  // 3. Determine tscn parent attribute
  const tscnParent = parent;

  // 4. Find parent node section
  let parentNodeLine = -1;

  if (parent === '.') {
    // Adding as root child — find the root node (no parent attr or parent=".")
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i]!.trim();
      if (!trimmed.startsWith('[node')) continue;
      const p = getBracketAttr(trimmed, 'parent');
      if (p === null || p === '' || p === '.') {
        parentNodeLine = i;
        break;
      }
    }
  } else {
    // C-03: Find parent node by name, preferring path-aware match when parent contains "/".
    // For simple names (e.g. "Player"), fall back to name-only search.
    // For paths (e.g. "Level/Player"), use findNodeSectionLine which matches name+parent.
    if (parent.includes('/')) {
      parentNodeLine = findNodeSectionLine(lines, parent);
    } else {
      parentNodeLine = findNodeByName(lines, parent);
    }
  }

  if (parentNodeLine === -1) {
    return { success: false, message: `Parent node not found: ${parent}`, fallback: false };
  }

  // 5. Find insertion point: after the last descendant of the parent
  const insertAfter = findLastDescendantLine(lines, parentNodeLine, tscnParent);

  // 6. Build [node] section
  const nodeLines: string[] = [];

  // Header line
  if (tscnParent === '.') {
    nodeLines.push(`[node name="${escapeTscnAttr(name)}" type="${escapeTscnAttr(type)}" parent="."]`);
  } else {
    nodeLines.push(`[node name="${escapeTscnAttr(name)}" type="${escapeTscnAttr(type)}" parent="${escapeTscnAttr(tscnParent)}"]`);
  }

  // Property lines
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      nodeLines.push(`${key} = ${formatPropertyValue(value)}`);
    }
  }

  // 7. Insert after last descendant (add blank line separator before new node)
  nodeLines.unshift(''); // blank line before the new node
  lines.splice(insertAfter + 1, 0, ...nodeLines);

  // 8. Update load_steps (+1)
  incrementLoadSteps(lines);

  return {
    success: true,
    fallback: false,
    message: `Added node ${name} (type=${type}) as child of ${parent}`,
    scene: lines.join('\n'),
  };
}

// ── addNodes (batch) ────────────────────────────────────────────────────────

/**
 * Add multiple nodes to a .tscn scene in one pass.
 *
 * 1. Empty array → immediate success, no changes.
 * 2. If ANY node has unsupported property types → returns fallback=true
 *    so the caller can fall through to the Godot-process path.
 * 3. Otherwise processes each node sequentially, threading the scene content
 *    through each addNode call.
 */
export function addNodes(
  tscnContent: string,
  nodes: Array<AddNodeParams>,
): AddNodeResult {
  try {
  return _addNodesInner(tscnContent, nodes);
  } catch (err) {
    return { success: false, message: `tscn-editor error: ${err instanceof Error ? err.message : String(err)}`, fallback: false };
  }
}

function _addNodesInner(
  tscnContent: string,
  nodes: Array<AddNodeParams>,
): AddNodeResult {
  if (nodes.length === 0) {
    return { success: true, fallback: false, scene: tscnContent, message: 'No nodes to add' };
  }

  // Pre-check: if any node has unsupported properties, fall back entirely
  for (const node of nodes) {
    if (node.properties) {
      for (const value of Object.values(node.properties)) {
        if (!canSerializeProperty(value)) {
          return {
            success: true,
            fallback: true,
            message: `Unsupported property type in node ${node.name}, requires Godot process`,
          };
        }
      }
    }
  }

  // Process sequentially, threading content
  let content = tscnContent;
  for (const node of nodes) {
    const result = addNode(content, node);
    if (!result.success) {
      return result;
    }
    if (result.scene) {
      content = result.scene;
    }
  }

  return {
    success: true,
    fallback: false,
    message: `Added ${nodes.length} node(s)`,
    scene: content,
  };
}
