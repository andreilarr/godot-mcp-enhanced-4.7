// test/screenshot-2d.test.ts
import { describe, it, expect } from 'vitest';
import { getBlankHint } from '../src/screenshot.js';

describe('screenshot-2d: blank detection hints', () => {
  it('detects 2D scene from tscn content pattern', () => {
    const content = '[node name="Level" type="Node2D"]\n[node name="Player" type="Sprite2D"]';
    const is2D = /Node2D|CanvasItem|ColorRect|Sprite2D/.test(content);
    expect(is2D).toBe(true);
  });

  it('does not flag 3D-only scene', () => {
    const content = '[node name="Level" type="Node3D"]\n[node name="Mesh" type="MeshInstance3D"]';
    const is2D = /Node2D|CanvasItem|ColorRect|Sprite2D/.test(content);
    expect(is2D).toBe(false);
  });

  it('getBlankHint returns hint when BLANK_DETECTED present', () => {
    const output = '[SCREENSHOT] SAVED: out.png\n[SCREENSHOT] WARNING: BLANK_DETECTED - known limitation';
    const hint = getBlankHint(output);
    expect(hint).toContain('2D CanvasItem');
    expect(hint).toContain('Game Bridge');
    expect(hint).toContain('screenshot analyze');
  });

  it('getBlankHint returns empty string when no BLANK_DETECTED', () => {
    const output = '[SCREENSHOT] SAVED: out.png (1280x720)';
    const hint = getBlankHint(output);
    expect(hint).toBe('');
  });
});
