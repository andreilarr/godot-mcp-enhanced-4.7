import { describe, it, expect } from 'vitest';
import {
  getToolDefinitions,
  handleTool,
  TOOL_META,
} from '../src/tools/spatial-ops.js';

// ─── spatial-ops is a stub (migrated to physics-ops) ─────────────────────────

describe('spatial-ops stub', () => {
  it('getToolDefinitions returns empty array', () => {
    const defs = getToolDefinitions();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBe(0);
  });

  it('TOOL_META is empty', () => {
    expect(Object.keys(TOOL_META).length).toBe(0);
  });

  it('handleTool returns null for any tool name', async () => {
    const result = await handleTool('spatial_info', {
      project_path: '/fake/project',
      action: 'get_node_info',
    }, { findGodot: async () => '/fake/godot' });
    expect(result).toBeNull();
  });
});
