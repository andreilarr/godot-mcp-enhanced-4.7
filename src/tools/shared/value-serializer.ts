// Value serialization and path sanitization for GDScript code generation.

import { smartCoerce, coerceRect2 } from '../smart-coerce.js';

// Escapes a string for embedding in a GDScript string literal.
// % → %% prevents GDScript string formatting from interpreting % as a placeholder.
// Note: do NOT apply gdEscape to already-escaped output (e.g. gdEscape(gdEscape(x)))
// as %% would become %%%% (harmless but unnecessary double-escaping).
// Note: \uXXXX sequences are NOT escaped because GDScript does not support \u escapes
// (only \xHH for hex and \UXXXXYYYY for unicode codepoints in StringName).
// Note: $ is NOT escaped because GDScript double-quoted strings don't treat $ as special.
// NodePath syntax like $Player works at the expression level, not inside string literals.
export function gdEscape(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/"/g, '\\"')
    .replace(/\0/g, '')
    .replace(/%/g, '%%')
    .replace(/'/g, "\\'");
}

/** Format a number as a Godot-compatible float literal (e.g. 2 → 2.0). */
export const ff = (n: number) => Number.isInteger(n) ? `${n}.0` : `${n}`;

/** Normalize leading spaces to tabs to prevent "Mixed tabs and spaces" errors.
 *  Detects the smallest nonzero leading-space count as the indent unit,
 *  then replaces each group of that many spaces with one tab. */
export function normalizeIndentToTabs(code: string): string {
  const lines = code.split('\n');
  let indentUnit = 0;
  for (const line of lines) {
    const m = line.match(/^( +)\S/);
    if (m) {
      const len = m[1]!.length;
      if (indentUnit === 0 || len < indentUnit) {
        indentUnit = len;
      }
    }
  }
  if (indentUnit === 0) return code;

  return lines.map(line => {
    let leadingSpaces = 0;
    while (leadingSpaces < line.length && line[leadingSpaces] === ' ') {
      leadingSpaces++;
    }
    if (leadingSpaces === 0) return line;
    const tabs = Math.floor(leadingSpaces / indentUnit);
    const remainder = leadingSpaces % indentUnit;
    return '\t'.repeat(tabs) + ' '.repeat(remainder) + line.slice(leadingSpaces);
  }).join('\n');
}

export function normalizeNodePath(input: string): string {
  if (typeof input !== 'string') throw new Error('NodePath is required and must be a string');
  const trimmed = input.trim();
  if (!trimmed) throw new Error('NodePath cannot be empty');
  if (trimmed.startsWith('res://')) throw new Error('NodePath must be a scene tree path (root/...), not a resource path (res://...)');
  return trimmed.startsWith('/') ? trimmed : '/' + trimmed;
}

// Validates a res:// path against traversal attacks, including URL-encoded bypass.
export function sanitizeResPath(raw: unknown, field: string): string {
  if (!raw || typeof raw !== 'string' || !raw.startsWith('res://')) {
    throw new Error(`${field} must be a string starting with res://`);
  }
  // Decode iteratively to defeat double-encoding (%252e%252e%252f etc.)
  let decoded = raw;
  let prev = '';
  let iterations = 0;
  while (decoded !== prev && iterations < 5) {
    prev = decoded;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      throw new Error(`${field} contains invalid encoding: ${raw}`);
    }
    iterations++;
  }
  if (decoded.includes('/../') || decoded.endsWith('/..') || decoded.includes('\\')) {
    throw new Error(`${field} contains path traversal: ${raw}`);
  }
  return decoded;
}

/**
 * Unified GDScript value serializer.
 *
 * Converts a JS value into a GDScript expression string.
 * Used by scene.ts, ui-tools.ts, animation-shared.ts, and animation-ops.ts.
 *
 * Returns a bare GDScript literal / constructor call:
 *   null, true/false, 42, "string", Vector2(1,2), Vector3(1,2,3), Color(1,0,0,1)
 *
 * Throws on unsupported types (objects with unexpected keys, arbitrary arrays, etc.).
 * Throws on NaN / Infinity values.
 *
 * @param v         The value to serialize.
 * @param trackType Optional animation track type hint (e.g. 'rotation_3d' → Quaternion).
 */
export function valueToGd(v: unknown, trackType?: string): string {
  // ── Smart coercion layer (only for objects and strings) ──
  if (typeof v === 'object' && v !== null) {
    const rectResult = coerceRect2(v);
    if (typeof rectResult === 'string') return rectResult;
  }
  if (typeof v === 'string') {
    const coerced = smartCoerce(v);
    if (coerced !== v) {
      if (typeof coerced === 'string') return coerced;
      if (typeof coerced === 'object') return valueToGd(coerced, trackType);
    }
  }

  // ── null / undefined ──
  if (v === null || v === undefined) return 'null';

  // ── boolean ──
  if (typeof v === 'boolean') return v ? 'true' : 'false';

  // ── number (with NaN / Infinity guard) ──
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`Non-finite number not supported: ${v}`);
    return String(v);
  }

  // ── string ──
  if (typeof v === 'string') return `"${gdEscape(v)}"`;

  // ── array → Vector2 / Vector3 / Color ──
  if (Array.isArray(v)) {
    if (v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number') {
      if (!Number.isFinite(v[0]) || !Number.isFinite(v[1])) throw new Error('Non-finite number in array');
      return `Vector2(${v[0]}, ${v[1]})`;
    }
    if (v.length === 3 && typeof v[0] === 'number' && typeof v[1] === 'number' && typeof v[2] === 'number') {
      if (!Number.isFinite(v[0]) || !Number.isFinite(v[1]) || !Number.isFinite(v[2])) throw new Error('Non-finite number in array');
      if (trackType === 'rotation_3d') {
        return `Quaternion.from_euler(Vector3(${v[0]}, ${v[1]}, ${v[2]}))`;
      }
      return `Vector3(${v[0]}, ${v[1]}, ${v[2]})`;
    }
    if (v.length === 4 && v.every(el => typeof el === 'number')) {
      if (!v.every(el => Number.isFinite(el as number))) throw new Error('Non-finite number in array');
      return `Color(${v[0]}, ${v[1]}, ${v[2]}, ${v[3]})`;
    }
    // Longer arrays → JSON array literal (e.g. keyframe points, polygon vertices)
    return `[${v.map(el => valueToGd(el)).join(', ')}]`;
  }

  // ── object → {x,y} / {x,y,z} / {r,g,b,a} ──
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.some(k => !['x', 'y', 'z', 'r', 'g', 'b', 'a'].includes(k))) {
      throw new Error(`Unsupported object keys: ${keys.filter(k => !['x', 'y', 'z', 'r', 'g', 'b', 'a'].includes(k)).join(', ')}. Allowed: {x,y}, {x,y,z}, {r,g,b,a}.`);
    }
    // Vector2 / Vector3
    if (typeof obj.x === 'number' && typeof obj.y === 'number') {
      if (!Number.isFinite(obj.x as number) || !Number.isFinite(obj.y as number)) throw new Error('Non-finite number in object');
      if (typeof obj.z === 'number') {
        if (!Number.isFinite(obj.z as number)) throw new Error('Non-finite number in object');
        return `Vector3(${obj.x}, ${obj.y}, ${obj.z})`;
      }
      return `Vector2(${obj.x}, ${obj.y})`;
    }
    // Color
    if (typeof obj.r === 'number' && typeof obj.g === 'number' && typeof obj.b === 'number') {
      const a = typeof obj.a === 'number' ? obj.a : 1.0;
      if (!Number.isFinite(obj.r as number) || !Number.isFinite(obj.g as number) || !Number.isFinite(obj.b as number) || !Number.isFinite(a as number)) throw new Error('Non-finite number in object');
      return `Color(${obj.r}, ${obj.g}, ${obj.b}, ${a})`;
    }
    throw new Error(`Cannot convert object to GDScript literal: expected {x,y}, {x,y,z}, or {r,g,b,a}`);
  }

  throw new Error(`Cannot convert value to GDScript literal: ${typeof v}`);
}
