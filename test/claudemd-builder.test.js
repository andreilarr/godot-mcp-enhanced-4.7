// test/claudemd-builder.test.js
import { describe, it, expect } from 'vitest';
import {
  buildEngineVersion,
  buildRenderer,
  buildMainScene,
} from '../build/tools/claudemd-builder.js';

describe('claudemd-builder — simple builders', () => {
  describe('buildEngineVersion', () => {
    it('extracts version from PackedStringArray format', () => {
      const config = {
        application: { 'config/features': 'PackedStringArray("4.6", "Forward+")' },
      };
      expect(buildEngineVersion(config)).toBe('- Godot 4.6');
    });

    it('returns fallback when no features', () => {
      const config = { application: {} };
      expect(buildEngineVersion(config)).toBe('- Godot 4.x（版本未知）');
    });

    it('returns null when config is null', () => {
      expect(buildEngineVersion(null)).toBeNull();
    });

    it('returns null when no application section', () => {
      expect(buildEngineVersion({})).toBeNull();
    });
  });

  describe('buildRenderer', () => {
    it('extracts renderer/rendering_method', () => {
      const config = { rendering: { 'renderer/rendering_method': 'mobile' } };
      expect(buildRenderer(config)).toBe('- mobile');
    });

    it('extracts renderer (legacy key)', () => {
      const config = { rendering: { renderer: 'forward_plus' } };
      expect(buildRenderer(config)).toBe('- forward_plus');
    });

    it('returns null when no rendering section', () => {
      expect(buildRenderer({})).toBeNull();
    });

    it('returns null when config is null', () => {
      expect(buildRenderer(null)).toBeNull();
    });
  });

  describe('buildMainScene', () => {
    it('extracts run/main_scene', () => {
      const config = { application: { 'run/main_scene': 'res://scenes/main.tscn' } };
      expect(buildMainScene(config)).toBe('- res://scenes/main.tscn');
    });

    it('returns null when no main scene', () => {
      const config = { application: {} };
      expect(buildMainScene(config)).toBeNull();
    });

    it('returns null when config is null', () => {
      expect(buildMainScene(null)).toBeNull();
    });
  });
});
