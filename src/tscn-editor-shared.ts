// src/tscn-editor-shared.ts — Shared helpers for .tscn scene file editing
//
// I-10: Non-null assertions (!) on regex match groups are guarded by preceding
// `if (match)` checks — see tscn-parser.ts header for the full rationale.

export interface SceneEditResult {
  success: boolean;
  message: string;
  scene?: string;
}

// ── helpers ──────────────────────────────────────────────────────────────────

export function normalizeLines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

/** Find the end of a section (next `[...]` line or end of file). Returns index of the next section start. */
export function findSectionEnd(lines: string[], startLine: number): number {
  for (let i = startLine + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith('[')) return i;
  }
  return lines.length;
}

/** Escape special characters in .tscn quoted attribute values */
export function escapeTscnAttr(value: string): string {
  if (!value) return '';
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Detect values that are Godot expressions or primitives and should NOT be quoted in .tscn. */
const GODOT_LITERAL_RE = /^(true|false|null|-?\d+(\.\d+)?(e[+-]?\d+)?|0x[0-9a-fA-F]+|ExtResource\(|SubResource\(|NodePath\(|Vector2i?\(|Vector3i?\(|Vector4i?\(|AABB\(|Color\(|Plane\(|Projection\(|Rect2i?\(|Transform2D\(|Transform3D\(|Basis\(|Quaternion\(|Callable\(|Signal\(|StringName\(|Packed.*Array\(|Array\(|Dictionary\(|RID\(|Object\(|Resource\(|Variant\(|&")/;

export function formatTscnValue(value: string): string {
  const escaped = escapeTscnValue(value);
  if (GODOT_LITERAL_RE.test(value.trim())) return escaped;
  return `"${escaped}"`;
}

/** Escape property values for safe embedding inside quoted .tscn values (e.g. `property = "value"`).
 *  Does NOT handle unquoted .tscn values or structural syntax. */
export function escapeTscnValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('Value must not contain newlines');
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\]/g, '\\]');
}

/** Escape string for safe use in RegExp constructor */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parse a quoted attribute from a bracket header like `[node name="X" type="Y"]` */
export function getBracketAttr(header: string, attr: string): string | null {
  const safeAttr = escapeRegExp(attr);
  const re = new RegExp(`(?:^|\\s)${safeAttr}="([^"]*)"`);
  const m = header.match(re);
  return m ? m[1]! : null;
}

/** Get the name part of a nodePath like "Root/Player/Sprite2D" → "Sprite2D" */
export function leafName(nodePath: string): string {
  const parts = nodePath.split('/');
  return parts[parts.length - 1]!;
}

/** Build a parent path prefix from a nodePath. "Root/Player/Sprite2D" → "Root/Player" */
export function parentPath(nodePath: string): string {
  const parts = nodePath.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
}

/**
 * For a nodePath like "Root/Player/Sprite2D", we need to find the node whose
 * name is "Sprite2D" AND whose parent attribute matches the path prefix.
 * In .tscn, the parent is stored as NodePath("Root/Player").
 */
export function findNodeSectionLine(lines: string[], nodePath: string): number {
  const targetName = leafName(nodePath);
  const targetParent = parentPath(nodePath);

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed.startsWith('[node')) continue;

    const name = getBracketAttr(trimmed, 'name');
    if (name !== targetName) continue;

    // If targetParent is empty, this is a root node (no parent attr)
    if (!targetParent) {
      const p = getBracketAttr(trimmed, 'parent');
      if (p === null || p === '') return i;
      continue;
    }

    // Match parent — could be inline or on a property line
    const inlineParent = getBracketAttr(trimmed, 'parent');
    if (inlineParent === targetParent) return i;

    // Check property lines below the header
    const end = findSectionEnd(lines, i);
    for (let j = i + 1; j < end; j++) {
      const propLine = lines[j]!.trim();
      if (propLine.startsWith('parent = ') || propLine.startsWith('parent=')) {
        const val = propLine.replace(/^parent\s*=\s*/, '').replace(/"/g, '').trim();
        if (val === targetParent) return i;
      }
    }
  }
  return -1;
}

/** Return the last line of the node section (inclusive). */
export function nodeSectionEnd(lines: string[], nodeLine: number): number {
  return findSectionEnd(lines, nodeLine) - 1;
}
