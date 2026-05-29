import { expect, it, describe } from 'vitest';
import {
  ACTIONS,
  getToolDefinitions,
  TOOL_META,
  handleTool,
  genStateSetPosition,
  genStateSetBlend,
} from '../src/tools/animtree.js';

const fakeCtx = { findGodot: async () => '/fake/godot' };

// ─── ACTIONS ──────────────────────────────────────────────────────────────

describe('animtree ACTIONS', () => {
  it('contains 6 actions', () => {
    expect(ACTIONS.length).toBe(6);
  });
  const expected = [
    'animtree_create',
    'animtree_add_state',
    'animtree_add_transition',
    'animtree_set_blend',
    'animtree_play',
    'animtree_state_edit',
  ];
  for (const name of expected) {
    it(`includes ${name}`, () => {
      expect(ACTIONS.includes(name)).toBeTruthy();
    });
  }
});

// ─── getToolDefinitions ──────────────────────────────────────────────────────

describe('animtree getToolDefinitions', () => {
  it('returns non-empty array', () => {
    const defs = getToolDefinitions();
    expect(Array.isArray(defs)).toBeTruthy();
    expect(defs.length).toBeGreaterThan(0);
  });
  it('returns 1 definition named animtree', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(1);
    expect(defs[0].name).toBe('animtree');
  });
  it('action enum contains all ACTIONS', () => {
    const defs = getToolDefinitions();
    const actionEnum = defs[0].inputSchema.properties.action.enum;
    for (const a of ACTIONS) {
      expect(actionEnum.includes(a)).toBeTruthy();
    }
  });
  it('definition has name and inputSchema', () => {
    const def = getToolDefinitions()[0];
    expect(def.name).toBeTruthy();
    expect(def.inputSchema).toBeTruthy();
    expect(def.inputSchema.type).toBe('object');
  });
});

// ─── TOOL_META ───────────────────────────────────────────────────────────────

describe('animtree TOOL_META', () => {
  it('has exactly 1 entry for animtree', () => {
    expect('animtree' in TOOL_META).toBeTruthy();
    expect(Object.keys(TOOL_META).length).toBe(1);
  });
  it('animtree is non-readonly and non-long-running', () => {
    expect(TOOL_META['animtree'].readonly).toBe(false);
    expect(TOOL_META['animtree'].long_running).toBe(false);
  });
});

// ─── handleTool ──────────────────────────────────────────────────────────────

describe('animtree handleTool', () => {
  it('returns null for unknown tool', async () => {
    const result = await handleTool('unknown_tool', {}, fakeCtx);
    expect(result).toBe(null);
  });

  it('returns null for unrelated tool name', async () => {
    const result = await handleTool('run_project', {}, fakeCtx);
    expect(result).toBe(null);
  });

  it('animtree_create rejects missing name', async () => {
    const result = await handleTool('animtree', {
      action: 'animtree_create',
      project_path: '/fake/project',
      animation_player_path: 'root/AP',
    }, fakeCtx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error_code).toBeTruthy();
  });

  it('animtree_create rejects missing animation_player_path', async () => {
    const result = await handleTool('animtree', {
      action: 'animtree_create',
      project_path: '/fake/project',
      name: 'MyTree',
    }, fakeCtx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });

  it('animtree_add_state rejects missing state_name', async () => {
    const result = await handleTool('animtree', {
      action: 'animtree_add_state',
      project_path: '/fake/project',
      node_path: 'root/Tree',
      animation: 'idle',
    }, fakeCtx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });

  it('animtree_play rejects missing state_name', async () => {
    const result = await handleTool('animtree', {
      action: 'animtree_play',
      project_path: '/fake/project',
      node_path: 'root/Tree',
    }, fakeCtx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });

  it('animtree_set_blend rejects missing parameter_name', async () => {
    const result = await handleTool('animtree', {
      action: 'animtree_set_blend',
      project_path: '/fake/project',
      node_path: 'root/Tree',
      value: 0.5,
    }, fakeCtx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });

  it('animtree_state_edit rejects missing action', async () => {
    const result = await handleTool('animtree', {
      action: 'animtree_state_edit',
      project_path: '/fake/project',
      node_path: 'root/Tree',
    }, fakeCtx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });

  it('animtree_add_transition rejects missing from_state', async () => {
    const result = await handleTool('animtree', {
      action: 'animtree_add_transition',
      project_path: '/fake/project',
      node_path: 'root/Tree',
      to_state: 'run',
    }, fakeCtx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });
});

// ─── genStateSetPosition ─────────────────────────────────────────────────────

describe('genStateSetPosition', () => {
  it('generates script with state name and position', () => {
    const script = genStateSetPosition('root/Tree', 'idle', 10, 20);
    expect(script.includes('idle')).toBeTruthy();
    expect(script.includes('Vector2(10, 20)')).toBeTruthy();
    expect(script.includes('set_node_position')).toBeTruthy();
  });
});

// ─── genStateSetBlend ────────────────────────────────────────────────────────

describe('genStateSetBlend', () => {
  it('generates script with parameter name and value', () => {
    const script = genStateSetBlend('root/Tree', 'blend_amount', '0.5');
    expect(script.includes('blend_amount')).toBeTruthy();
    expect(script.includes('0.5')).toBeTruthy();
  });
});
