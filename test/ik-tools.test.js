import { expect } from 'vitest';
import {
  getToolDefinitions,
  TOOL_META,
  genIkCreateScript,
  genIkGetScript,
  genIkSetScript,
  genListBonesScript,
} from '../src/tools/ik-tools.js';

// ─── getToolDefinitions ─────────────────────────────────────────────────────

describe('ik-tools getToolDefinitions', () => {
  it('returns 1 merged tool definition', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(1);
  });
  it('tool is named "ik"', () => {
    const defs = getToolDefinitions();
    expect(defs[0].name).toBe('ik');
  });
  it('action enum contains all 4 actions', () => {
    const defs = getToolDefinitions();
    const actionEnum = defs[0].inputSchema.properties.action.enum;
    expect(actionEnum).toContain('ik_modifier_create');
    expect(actionEnum).toContain('ik_modifier_get');
    expect(actionEnum).toContain('ik_modifier_set');
    expect(actionEnum).toContain('ik_list_bones');
  });
  it('definition has inputSchema with required fields', () => {
    const defs = getToolDefinitions();
    expect(defs[0].inputSchema).toBeTruthy();
    expect(defs[0].inputSchema.required).toContain('action');
  });
});

// ─── TOOL_META ──────────────────────────────────────────────────────────────

describe('ik-tools TOOL_META', () => {
  it('has exactly 1 entry', () => {
    expect(Object.keys(TOOL_META).length).toBe(1);
  });
  it('has entry for "ik"', () => {
    expect(TOOL_META.ik).toBeDefined();
  });
  it('ik is non-readonly and non-long-running', () => {
    expect(TOOL_META.ik.readonly).toBe(false);
    expect(TOOL_META.ik.long_running).toBe(false);
  });
});

// ─── genIkCreateScript ──────────────────────────────────────────────────────

describe('genIkCreateScript', () => {
  it('generates valid GDScript with type and name', () => {
    const script = genIkCreateScript('TwoBoneIK3D', 'RightArmIK', 'root/Player/Skeleton3D');
    expect(script.includes('TwoBoneIK3D.new()')).toBeTruthy();
    expect(script.includes('RightArmIK')).toBeTruthy();
    expect(script.includes('root/Player/Skeleton3D')).toBeTruthy();
  });
  it('includes position when provided', () => {
    const script = genIkCreateScript('TwoBoneIK3D', 'IK', 'root', { x: 1, y: 2, z: 3 });
    expect(script.includes('Vector3(1, 2, 3)')).toBeTruthy();
  });
  it('includes bone_name and target_nodepath', () => {
    const script = genIkCreateScript('TwoBoneIK3D', 'IK', 'root', undefined, 'RightArm', 'root/Target');
    expect(script.includes('RightArm')).toBeTruthy();
    expect(script.includes('root/Target')).toBeTruthy();
    expect(script.includes('NodePath')).toBeTruthy();
  });
});

// ─── genIkGetScript ─────────────────────────────────────────────────────────

describe('genIkGetScript', () => {
  it('contains node path and property reads', () => {
    const script = genIkGetScript('root/Player/IK');
    expect(script.includes('root/Player/IK')).toBeTruthy();
    expect(script.includes('ik_node.active')).toBeTruthy();
    expect(script.includes('ik_node.influence')).toBeTruthy();
    expect(script.includes('bone_name')).toBeTruthy();
    expect(script.includes('target_nodepath')).toBeTruthy();
  });
});

// ─── genIkSetScript ─────────────────────────────────────────────────────────

describe('genIkSetScript', () => {
  it('sets active and influence', () => {
    const script = genIkSetScript('root/IK', { active: true, influence: 0.5 });
    expect(script.includes('ik_node.active = true')).toBeTruthy();
    expect(script.includes('ik_node.influence = 0.5')).toBeTruthy();
  });
  it('sets bone_name and magnet_position', () => {
    const script = genIkSetScript('root/IK', {
      bone_name: 'RightArm',
      magnet_position: { x: 0.1, y: 0.2, z: 0.3 },
    });
    expect(script.includes('RightArm')).toBeTruthy();
    expect(script.includes('Vector3(0.1, 0.2, 0.3)')).toBeTruthy();
  });
});

// ─── genListBonesScript ─────────────────────────────────────────────────────

describe('genListBonesScript', () => {
  it('contains Skeleton3D check and bone iteration', () => {
    const script = genListBonesScript('root/Player/Skeleton3D');
    expect(script.includes('Skeleton3D')).toBeTruthy();
    expect(script.includes('get_bone_count')).toBeTruthy();
    expect(script.includes('get_bone_name')).toBeTruthy();
    expect(script.includes('get_bone_rest')).toBeTruthy();
  });
  it('includes limit when provided', () => {
    const script = genListBonesScript('root/Skeleton3D', 10);
    expect(script.includes('10')).toBeTruthy();
  });
});
