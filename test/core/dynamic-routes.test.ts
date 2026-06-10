import { describe, it, expect } from 'vitest';
import { toolNameToRoute, classifyError } from '../../src/core/dynamic-routes.js';

describe('toolNameToRoute', () => {
  it('converts standard tool name to route', () => {
    expect(toolNameToRoute('godot_custom_light_bake')).toBe('custom/light-bake');
  });

  it('converts two-part tool name', () => {
    expect(toolNameToRoute('godot_terrain_sculpt')).toBe('terrain/sculpt');
  });

  it('converts multi-segment tool name', () => {
    expect(toolNameToRoute('godot_animation_play_forward')).toBe('animation/play-forward');
  });

  it('returns null for non-godot prefix', () => {
    expect(toolNameToRoute('custom_light_bake')).toBeNull();
  });

  it('returns null for single-segment after prefix', () => {
    expect(toolNameToRoute('godot_animation')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(toolNameToRoute('')).toBeNull();
  });

  it('returns null for just the prefix', () => {
    expect(toolNameToRoute('godot_')).toBeNull();
  });
});

describe('classifyError', () => {
  it('classifies 4xx as permanent', () => {
    expect(classifyError(400)).toBe('permanent');
    expect(classifyError(404)).toBe('permanent');
    expect(classifyError(422)).toBe('permanent');
  });

  it('classifies 5xx as transient', () => {
    expect(classifyError(500)).toBe('transient');
    expect(classifyError(502)).toBe('transient');
    expect(classifyError(503)).toBe('transient');
  });

  it('classifies other status codes as permanent', () => {
    expect(classifyError(200)).toBe('permanent');
    expect(classifyError(301)).toBe('permanent');
  });
});
