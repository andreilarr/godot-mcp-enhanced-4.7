import { describe, it, expect } from 'vitest';
import { escapeTscnAttr, formatTscnValue } from '../src/tscn-editor-shared.js';

// I-1: escapeTscnAttr 必须与 escapeTscnValue 一致地拒绝换行符。
// 当前 add 白名单(^[A-Za-z0-9_]+$)与 detach 严格相等阻挡了换行进入,但根因(转义函数本身
// 不拒绝换行)是定时炸弹——任何对 findInstanceNode 的"善意"修改都会立即激活 [node] 段注入。
describe('escapeTscnAttr (I-1: reject newlines)', () => {
  it('rejects LF in attribute value', () => {
    expect(() => escapeTscnAttr('a\nb')).toThrow(/newlines/i);
  });

  it('rejects CR in attribute value', () => {
    expect(() => escapeTscnAttr('a\rb')).toThrow(/newlines/i);
  });

  it('rejects CRLF in attribute value', () => {
    expect(() => escapeTscnAttr('a\r\nb')).toThrow(/newlines/i);
  });

  it('still escapes backslash, quote, bracket on clean values', () => {
    // 输入: a"b]c\d  →  转义后: a\"b\]c\\d
    expect(escapeTscnAttr('a"b]c\\d')).toBe('a\\"b\\]c\\\\d');
  });

  it('returns empty string for falsy input', () => {
    expect(escapeTscnAttr('')).toBe('');
  });
});

// I-3: GODOT_LITERAL_RE 只锚 ^ 不锚 $,导致 `Vector2(1,2) junk` 被识别为字面量,
// 不加引号原样输出,污染属性行语义(单行内附加垃圾)。
// 修复:完整锚定 + 每个 Type( 改为 Type([^)]*)。
describe('formatTscnValue (I-3: full-anchor literal detection)', () => {
  it('keeps clean Godot literal unquoted', () => {
    expect(formatTscnValue('Vector2(10, 20)')).toBe('Vector2(10, 20)');
    expect(formatTscnValue('Vector2(10,20)')).toBe('Vector2(10,20)');
    expect(formatTscnValue('ExtResource(1)')).toBe('ExtResource(1)');
    expect(formatTscnValue('Color(1, 0, 0, 1)')).toBe('Color(1, 0, 0, 1)');
    // 字面量内部字符不转义(NodePath 的引号、Array 的 ] 都有语法意义,转义会破坏字面量)
    expect(formatTscnValue('NodePath("Player/Sprite")')).toBe('NodePath("Player/Sprite")');
    expect(formatTscnValue('Array([1, 2, 3])')).toBe('Array([1, 2, 3])');
  });

  it('quotes value with trailing junk after a literal (I-3 fix)', () => {
    // 旧行为: 匹配 Vector2( 开头 → 不加引号 → 输出污染行
    // 新行为: 完整锚定失败 → 加引号(safe fail)
    expect(formatTscnValue('Vector2(1,2) junk')).toBe('"Vector2(1,2) junk"');
    expect(formatTscnValue('ExtResource(1) extra')).toBe('"ExtResource(1) extra"');
  });

  it('quotes plain strings and keeps scalars unquoted', () => {
    expect(formatTscnValue('hello')).toBe('"hello"');
    expect(formatTscnValue('true')).toBe('true');
    expect(formatTscnValue('false')).toBe('false');
    expect(formatTscnValue('null')).toBe('null');
    expect(formatTscnValue('42')).toBe('42');
    expect(formatTscnValue('3.14')).toBe('3.14');
  });
});
