import { describe, it, expect, afterEach } from 'vitest';
import { sanitizePath } from '../../src/core/path-security.js';

describe('sanitizePath', () => {
  afterEach(() => {
    delete process.env.GODOT_MCP_ALLOWED_ROOTS;
  });

  it('normalizes backslashes to forward slashes', () => {
    expect(sanitizePath('res://scenes\\main.tscn')).toBe('res://scenes/main.tscn');
  });

  it('merges double slashes', () => {
    expect(sanitizePath('res://scenes//main.tscn')).toBe('res://scenes/main.tscn');
  });

  it('rejects path traversal with ..', () => {
    expect(() => sanitizePath('res://../etc/passwd')).toThrow(/traversal/i);
  });

  it('allows res:// prefix', () => {
    expect(sanitizePath('res://scenes/main.tscn')).toBe('res://scenes/main.tscn');
  });

  it('allows user:// prefix', () => {
    expect(sanitizePath('user://save/game.dat')).toBe('user://save/game.dat');
  });

  it('rejects non-whitelisted prefix', () => {
    expect(() => sanitizePath('/etc/passwd')).toThrow(/prefix/i);
  });

  it('rejects illegal characters', () => {
    expect(() => sanitizePath('res://scenes/<script>.tscn')).toThrow(/illegal/i);
  });

  it('rejects control characters', () => {
    expect(() => sanitizePath('res://\x00evil')).toThrow(/illegal/i);
  });

  it('allows custom roots via opts.allowedRoots', () => {
    expect(sanitizePath('D:/custom/file.txt', {
      allowedRoots: ['D:/custom'],
    })).toBe('D:/custom/file.txt');
  });

  it('cannot remove default whitelist with opts', () => {
    expect(sanitizePath('res://scenes/main.tscn', {
      allowedRoots: ['D:/custom'],
    })).toBe('res://scenes/main.tscn');
  });

  it('accepts allowedRoots from env var', () => {
    process.env.GODOT_MCP_ALLOWED_ROOTS = 'D:/env-custom';
    expect(sanitizePath('D:/env-custom/file.txt')).toBe('D:/env-custom/file.txt');
  });
});
