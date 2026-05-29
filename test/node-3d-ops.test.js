import { expect } from 'vitest';
import {
  TOOL_NAMES,
  getToolDefinitions,
  TOOL_META,
  genCreate3DScript,
} from '../src/tools/node-3d-ops.js';
import {
  genCollisionOverlayScript,
} from '../src/tools/physics-ops.js';

// ─── TOOL_NAMES ─────────────────────────────────────────────────────────────

describe('node-3d-ops TOOL_NAMES', () => {
  it('contains exactly 1 tool name', () => {
    expect(TOOL_NAMES.length).toBe(1);
  });
  it('includes node_create_3d', () => {
    expect(TOOL_NAMES.includes('node_create_3d')).toBeTruthy();
  });
});

// ─── getToolDefinitions ─────────────────────────────────────────────────────

describe('node-3d-ops getToolDefinitions', () => {
  it('returns 1 tool definition', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(1);
  });
  it('definition name matches TOOL_NAMES', () => {
    const defs = getToolDefinitions();
    expect(defs[0].name).toBe('node_create_3d');
  });
});

// ─── TOOL_META ──────────────────────────────────────────────────────────────

describe('node-3d-ops TOOL_META', () => {
  it('has exactly 1 entry', () => {
    expect(Object.keys(TOOL_META).length).toBe(1);
  });
  it('has entry for node_create_3d', () => {
    expect(TOOL_META.node_create_3d).toBeDefined();
  });
  it('node_create_3d is non-readonly and non-long-running', () => {
    expect(TOOL_META.node_create_3d.readonly).toBe(false);
    expect(TOOL_META.node_create_3d.long_running).toBe(false);
  });
});

// ─── genCollisionOverlayScript (now in physics-ops) ─────────────────────────

describe('genCollisionOverlayScript', () => {
  it('generates overlay script', () => {
    const script = genCollisionOverlayScript('/root/Level');
    expect(script.includes('CollisionShape3D')).toBeTruthy();
    expect(script.includes('_MCP_CollisionOverlay')).toBeTruthy();
    expect(script.includes('StandardMaterial3D')).toBeTruthy();
  });
  it('includes color override when provided', () => {
    const script = genCollisionOverlayScript('/root/Level', '1,0,0,0.5');
    expect(script.includes('Color(1,0,0,0.5)')).toBeTruthy();
  });
  it('uses auto-detection when no color override', () => {
    const script = genCollisionOverlayScript('/root/Level');
    expect(script.includes('StaticBody3D')).toBeTruthy();
    expect(script.includes('CharacterBody3D')).toBeTruthy();
  });
});

// ─── genCreate3DScript ──────────────────────────────────────────────────────

describe('genCreate3DScript', () => {
  it('creates node with position', () => {
    const script = genCreate3DScript('MeshInstance3D', 'MyMesh', '/root/Scene', {x:1,y:2,z:3});
    expect(script.includes('MeshInstance3D.new()')).toBeTruthy();
    expect(script.includes('MyMesh')).toBeTruthy();
    expect(script.includes('position = Vector3(1, 2, 3)')).toBeTruthy();
  });
  it('creates node with scale', () => {
    const script = genCreate3DScript('Camera3D', 'MainCam', '/root/Scene', undefined, undefined, {x:2,y:2,z:2});
    expect(script.includes('Camera3D.new()')).toBeTruthy();
    expect(script.includes('scale = Vector3(2, 2, 2)')).toBeTruthy();
    expect(script.includes('position =')).toBeFalsy();
  });
  it('sets custom properties', () => {
    const script = genCreate3DScript('OmniLight3D', 'Light1', '/root/Scene', undefined, undefined, undefined, { light_energy: 2.5, light_color: '"red"' });
    expect(script.includes('light_energy')).toBeTruthy();
    expect(script.includes('2.5')).toBeTruthy();
  });
  it('rejects invalid property names', () => {
    expect(() => genCreate3DScript('Node3D', 'X', '/root', undefined, undefined, undefined, { 'a;b': 1 })).toThrow(/Invalid property name/);
    expect(() => genCreate3DScript('Node3D', 'X', '/root', undefined, undefined, undefined, { '1bad': 1 })).toThrow(/Invalid property name/);
  });
  it('accepts valid property names', () => {
    const script = genCreate3DScript('Node3D', 'X', '/root', undefined, undefined, undefined, { _private: 1, camelCase: 2 });
    expect(script.includes('_private')).toBeTruthy();
    expect(script.includes('camelCase')).toBeTruthy();
  });
});
