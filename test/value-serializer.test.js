import { describe, it, expect } from 'vitest';
import {
  gdEscape,
  ff,
  normalizeIndentToTabs,
  normalizeNodePath,
  sanitizeResPath,
  valueToGd,
} from '../src/tools/shared/value-serializer.js';

// ── gdEscape ─────────────────────────────────────────────────────────────────

describe('gdEscape', () => {
  it('escapes backslashes', () => {
    expect(gdEscape('a\\b')).toBe('a\\\\b');
  });

  it('escapes newlines', () => {
    expect(gdEscape('a\nb')).toBe('a\\nb');
  });

  it('escapes CRLF to LF then escapes', () => {
    expect(gdEscape('a\r\nb')).toBe('a\\nb');
  });

  it('escapes CR to LF then escapes', () => {
    expect(gdEscape('a\rb')).toBe('a\\nb');
  });

  it('escapes tabs', () => {
    expect(gdEscape('a\tb')).toBe('a\\tb');
  });

  it('escapes double quotes', () => {
    expect(gdEscape('a"b')).toBe('a\\"b');
  });

  it('escapes percent signs', () => {
    expect(gdEscape('100%')).toBe('100%%');
  });

  it('escapes single quotes', () => {
    expect(gdEscape("a'b")).toBe("a\\'b");
  });

  it('removes null bytes', () => {
    expect(gdEscape('a\0b')).toBe('ab');
  });

  it('handles empty string', () => {
    expect(gdEscape('')).toBe('');
  });

  it('handles plain ASCII', () => {
    expect(gdEscape('hello world')).toBe('hello world');
  });

  it('does NOT escape dollar sign', () => {
    expect(gdEscape('$Player')).toBe('$Player');
  });

  it('handles multiple special chars in sequence', () => {
    expect(gdEscape('a%\n"\\b')).toBe('a%%\\n\\"\\\\b');
  });
});

// ── ff (float format) ────────────────────────────────────────────────────────

describe('ff', () => {
  it('formats integers with .0 suffix', () => {
    expect(ff(0)).toBe('0.0');
    expect(ff(1)).toBe('1.0');
    expect(ff(-5)).toBe('-5.0');
  });

  it('preserves floats as-is', () => {
    expect(ff(1.5)).toBe('1.5');
    expect(ff(0.333)).toBe('0.333');
  });
});

// ── normalizeIndentToTabs ────────────────────────────────────────────────────

describe('normalizeIndentToTabs', () => {
  it('returns unchanged when no leading spaces', () => {
    expect(normalizeIndentToTabs('foo\nbar')).toBe('foo\nbar');
  });

  it('converts 2-space indent to tabs', () => {
    const input = 'line1\n  line2\n  line3';
    const result = normalizeIndentToTabs(input);
    expect(result).toBe('line1\n\tline2\n\tline3');
  });

  it('converts 4-space indent to single tab', () => {
    const input = 'line1\n    line2\n        line3';
    const result = normalizeIndentToTabs(input);
    expect(result).toBe('line1\n\tline2\n\t\tline3');
  });

  it('handles mixed depths', () => {
    const input = 'root\n  child\n    grandchild';
    const result = normalizeIndentToTabs(input);
    expect(result).toBe('root\n\tchild\n\t\tgrandchild');
  });
});

// ── normalizeNodePath ────────────────────────────────────────────────────────

describe('normalizeNodePath', () => {
  it('adds leading slash if missing', () => {
    expect(normalizeNodePath('root/Player')).toBe('/root/Player');
  });

  it('keeps leading slash if present', () => {
    expect(normalizeNodePath('/root/Player')).toBe('/root/Player');
  });

  it('trims whitespace', () => {
    expect(normalizeNodePath('  /root/Player  ')).toBe('/root/Player');
  });

  it('throws on non-string', () => {
    expect(() => normalizeNodePath(42)).toThrow('must be a string');
  });

  it('throws on empty string', () => {
    expect(() => normalizeNodePath('')).toThrow('cannot be empty');
  });

  it('throws on res:// path', () => {
    expect(() => normalizeNodePath('res://foo.tscn')).toThrow('resource path');
  });
});

// ── sanitizeResPath ─────────────────────────────────────────────────────────

describe('sanitizeResPath', () => {
  it('accepts valid res:// path', () => {
    expect(sanitizeResPath('res://scenes/level.tscn', 'path')).toBe('res://scenes/level.tscn');
  });

  it('rejects non-res:// path', () => {
    expect(() => sanitizeResPath('/etc/passwd', 'path')).toThrow('must be a string starting with res://');
  });

  it('rejects path traversal', () => {
    expect(() => sanitizeResPath('res:///../etc/passwd', 'path')).toThrow('path traversal');
  });

  it('rejects URL-encoded path traversal', () => {
    expect(() => sanitizeResPath('res://%2e%2e/etc/passwd', 'path')).toThrow('path traversal');
  });

  it('rejects double-encoded path traversal', () => {
    expect(() => sanitizeResPath('res://%252e%252e/etc', 'path')).toThrow('path traversal');
  });

  it('rejects backslash paths', () => {
    expect(() => sanitizeResPath('res://foo\\bar', 'path')).toThrow('path traversal');
  });

  it('rejects null input', () => {
    expect(() => sanitizeResPath(null, 'path')).toThrow('must be a string');
  });
});

// ── valueToGd ───────────────────────────────────────────────────────────────

describe('valueToGd', () => {
  it('serializes null', () => {
    expect(valueToGd(null)).toBe('null');
  });

  it('serializes undefined', () => {
    expect(valueToGd(undefined)).toBe('null');
  });

  it('serializes true', () => {
    expect(valueToGd(true)).toBe('true');
  });

  it('serializes false', () => {
    expect(valueToGd(false)).toBe('false');
  });

  it('serializes numbers', () => {
    expect(valueToGd(42)).toBe('42');
    expect(valueToGd(0)).toBe('0');
    expect(valueToGd(-3.14)).toBe('-3.14');
  });

  it('throws on NaN', () => {
    expect(() => valueToGd(NaN)).toThrow('Non-finite');
  });

  it('throws on Infinity', () => {
    expect(() => valueToGd(Infinity)).toThrow('Non-finite');
  });

  it('serializes strings with escaping', () => {
    expect(valueToGd('hello')).toBe('"hello"');
    expect(valueToGd('he"llo')).toBe('"he\\"llo"');
  });

  it('serializes 2-element array as Vector2', () => {
    expect(valueToGd([1, 2])).toBe('Vector2(1, 2)');
  });

  it('serializes 3-element array as Vector3', () => {
    expect(valueToGd([1, 2, 3])).toBe('Vector3(1, 2, 3)');
  });

  it('serializes 3-element array with rotation_3d track as Quaternion', () => {
    expect(valueToGd([0.5, 1.0, 0.3], 'rotation_3d')).toBe('Quaternion.from_euler(Vector3(0.5, 1, 0.3))');
  });

  it('serializes 4-element array as Color', () => {
    expect(valueToGd([1, 0, 0, 1])).toBe('Color(1, 0, 0, 1)');
  });

  it('serializes {x,y} object as Vector2', () => {
    expect(valueToGd({ x: 1, y: 2 })).toBe('Vector2(1, 2)');
  });

  it('serializes {x,y,z} object as Vector3', () => {
    expect(valueToGd({ x: 1, y: 2, z: 3 })).toBe('Vector3(1, 2, 3)');
  });

  it('serializes {r,g,b} object as Color', () => {
    expect(valueToGd({ r: 1, g: 0, b: 0 })).toBe('Color(1, 0, 0, 1)');
  });

  it('serializes {r,g,b,a} object as Color with alpha', () => {
    expect(valueToGd({ r: 1, g: 1, b: 1, a: 0.5 })).toBe('Color(1, 1, 1, 0.5)');
  });

  it('throws on unsupported object keys', () => {
    expect(() => valueToGd({ foo: 1 })).toThrow('Unsupported object keys');
  });

  it('throws on unsupported types', () => {
    expect(() => valueToGd(() => {})).toThrow('Cannot convert value');
  });

  it('serializes longer arrays as JSON-style arrays', () => {
    expect(valueToGd([1, 2, 3, 4, 5])).toBe('[1, 2, 3, 4, 5]');
  });
});
