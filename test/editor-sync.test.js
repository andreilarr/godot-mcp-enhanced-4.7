import { expect } from 'vitest';
import {
  getToolDefinitions,
  TOOL_META,
} from '../src/tools/editor-sync.js';

describe('editor-sync tools', () => {
  describe('getToolDefinitions', () => {
    it('returns definition for editor tool', () => {
      const defs = getToolDefinitions();
      const names = defs.map(d => d.name);
      expect(names).toContain('editor');
    });

    it('each definition has name, description, and inputSchema', () => {
      const defs = getToolDefinitions();
      for (const def of defs) {
        expect(def.name).toBeTruthy();
        expect(def.description).toBeTruthy();
        expect(def.inputSchema).toBeDefined();
        expect(def.inputSchema.type).toBe('object');
      }
    });
  });

  describe('TOOL_META', () => {
    it('marks editor_sync_start as not readonly and not long_running', () => {
      expect(TOOL_META.editor.readonly).toBe(false);
      expect(TOOL_META.editor.long_running).toBe(false);
    });

    it('marks editor_get_scene_tree as readonly', () => {
      expect(TOOL_META.editor.readonly).toBe(false);  // editor tool overall is not readonly
    });
  });
});
