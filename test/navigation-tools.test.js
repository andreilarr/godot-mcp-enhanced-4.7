import { expect, it, describe } from 'vitest';
import {
  getToolDefinitions,
  TOOL_META,
  handleTool,
  genNavQueryScript,
} from '../src/tools/navigation.js';

const fakeCtx = { findGodot: async () => '/fake/godot' };

// ─── getToolDefinitions ──────────────────────────────────────────────────────

describe('navigation getToolDefinitions', () => {
  it('returns non-empty array', () => {
    const defs = getToolDefinitions();
    expect(Array.isArray(defs)).toBeTruthy();
    expect(defs.length).toBeGreaterThan(0);
  });
  it('returns 1 merged definition named "nav"', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(1);
    expect(defs[0].name).toBe('nav');
  });
  it('action enum contains all 6 actions', () => {
    const defs = getToolDefinitions();
    const actionEnum = defs[0].inputSchema.properties.action.enum;
    expect(actionEnum).toContain('create_region');
    expect(actionEnum).toContain('bake_mesh');
    expect(actionEnum).toContain('create_agent');
    expect(actionEnum).toContain('set_params');
    expect(actionEnum).toContain('create_link');
    expect(actionEnum).toContain('query_path');
  });
  it('definition has name and inputSchema', () => {
    const def = getToolDefinitions()[0];
    expect(def.name).toBeTruthy();
    expect(def.inputSchema).toBeTruthy();
    expect(def.inputSchema.type).toBe('object');
  });
});

// ─── TOOL_META ───────────────────────────────────────────────────────────────

describe('navigation TOOL_META', () => {
  it('has exactly 1 entry for "nav"', () => {
    expect(Object.keys(TOOL_META).length).toBe(1);
    expect(TOOL_META.nav).toBeDefined();
  });
  it('nav is non-readonly and non-long-running', () => {
    expect(TOOL_META.nav.readonly).toBe(false);
    expect(TOOL_META.nav.long_running).toBe(false);
  });
});

// ─── handleTool ──────────────────────────────────────────────────────────────

describe('navigation handleTool', () => {
  it('returns null for unknown tool', async () => {
    const result = await handleTool('unknown_tool', {}, fakeCtx);
    expect(result).toBe(null);
  });

  it('returns null for unrelated tool name', async () => {
    const result = await handleTool('run_project', {}, fakeCtx);
    expect(result).toBe(null);
  });

  it('create_region action rejects missing name', async () => {
    const result = await handleTool('nav', {
      project_path: '/fake/project',
      action: 'create_region',
    }, fakeCtx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });

  it('set_params action rejects missing params', async () => {
    const result = await handleTool('nav', {
      project_path: '/fake/project',
      action: 'set_params',
      node_path: 'root/Agent',
    }, fakeCtx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });

  it('set_params action rejects empty params object', async () => {
    const result = await handleTool('nav', {
      project_path: '/fake/project',
      action: 'set_params',
      node_path: 'root/Agent',
      params: {},
    }, fakeCtx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });

  it('create_link action rejects missing name', async () => {
    const result = await handleTool('nav', {
      project_path: '/fake/project',
      action: 'create_link',
      start_position: { x: 0, y: 0, z: 0 },
      end_position: { x: 1, y: 0, z: 1 },
    }, fakeCtx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });

  it('create_agent action rejects missing name', async () => {
    const result = await handleTool('nav', {
      project_path: '/fake/project',
      action: 'create_agent',
    }, fakeCtx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });
});

// ─── genNavQueryScript (pure function, no mock needed) ───────────────────────

describe('genNavQueryScript', () => {
  it('generates script with NavigationServer3D calls', () => {
    const script = genNavQueryScript(
      { x: 1, y: 2, z: 3 },
      { x: 4, y: 5, z: 6 },
    );
    expect(script.includes('NavigationServer3D')).toBeTruthy();
    expect(script.includes('map_get_path')).toBeTruthy();
  });

  it('includes start_pos coordinates', () => {
    const script = genNavQueryScript(
      { x: 10, y: 20, z: 30 },
      { x: 40, y: 50, z: 60 },
    );
    expect(script.includes('Vector3(10, 20, 30)')).toBeTruthy();
    expect(script.includes('Vector3(40, 50, 60)')).toBeTruthy();
  });

  it('includes default map resolution when no region', () => {
    const script = genNavQueryScript(
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 1 },
    );
    expect(script.includes('NavigationServer3D.get_maps()')).toBeTruthy();
  });

  it('includes region lookup when navigationRegion is provided', () => {
    const script = genNavQueryScript(
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 1 },
      'root/Level/NavRegion',
    );
    expect(script.includes('root/Level/NavRegion')).toBeTruthy();
    expect(script.includes('region_get_map')).toBeTruthy();
  });

  it('outputs path data and length', () => {
    const script = genNavQueryScript(
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 1 },
    );
    expect(script.includes('_mcp_output("path"')).toBeTruthy();
    expect(script.includes('_mcp_output("path_length"')).toBeTruthy();
  });

  it('handles zero coordinates', () => {
    const script = genNavQueryScript(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
    );
    expect(script.includes('Vector3(0, 0, 0)')).toBeTruthy();
  });
});
