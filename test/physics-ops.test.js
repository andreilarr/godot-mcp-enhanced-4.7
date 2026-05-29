import { expect } from 'vitest';
import {
  getToolDefinitions,
  TOOL_META,
  genRaycastScript,
  genBodyInfoScript,
  genDiagnosePhysicsScript,
  genQuerySpatialScript,
  genCollisionOverlayScript,
} from '../src/tools/physics-ops.js';

// ─── getToolDefinitions ─────────────────────────────────────────────────────

describe('physics-ops getToolDefinitions', () => {
  it('returns 1 merged tool definition', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(1);
  });
  it('tool is named "physics"', () => {
    const defs = getToolDefinitions();
    expect(defs[0].name).toBe('physics');
  });
  it('action enum contains all 5 actions', () => {
    const defs = getToolDefinitions();
    const actionEnum = defs[0].inputSchema.properties.action.enum;
    expect(actionEnum).toContain('raycast');
    expect(actionEnum).toContain('body_info');
    expect(actionEnum).toContain('diagnose');
    expect(actionEnum).toContain('query_spatial');
    expect(actionEnum).toContain('collision_overlay');
  });
});

// ─── TOOL_META ──────────────────────────────────────────────────────────────

describe('physics-ops TOOL_META', () => {
  it('has exactly 1 entry for "physics"', () => {
    expect(Object.keys(TOOL_META).length).toBe(1);
    expect(TOOL_META.physics).toBeDefined();
  });
  it('physics is readonly and non-long-running', () => {
    expect(TOOL_META.physics.readonly).toBe(true);
    expect(TOOL_META.physics.long_running).toBe(false);
  });
});

// ─── genRaycastScript ───────────────────────────────────────────────────────

describe('genRaycastScript', () => {
  it('contains PhysicsRayQueryParameters3D.create', () => {
    const script = genRaycastScript({x:0,y:0,z:0}, {x:10,y:0,z:0});
    expect(script.includes('PhysicsRayQueryParameters3D.create')).toBeTruthy();
    expect(script.includes('Vector3(0, 0, 0)')).toBeTruthy();
    expect(script.includes('Vector3(10, 0, 0)')).toBeTruthy();
    expect(script.includes('root.get_world_3d()')).toBeTruthy();
  });
  it('includes collision_mask when provided', () => {
    const script = genRaycastScript({x:0,y:0,z:0}, {x:10,y:0,z:0}, 0b111);
    expect(script.includes('collision_mask = 7')).toBeTruthy();
  });
  it('includes exclude logic when paths provided', () => {
    const script = genRaycastScript({x:0,y:0,z:0}, {x:10,y:0,z:0}, undefined, ['/root/Wall', '/root/Floor']);
    expect(script.includes('exclude')).toBeTruthy();
    expect(script.includes('/root/Wall')).toBeTruthy();
    expect(script.includes('/root/Floor')).toBeTruthy();
  });
});

// ─── genBodyInfoScript ──────────────────────────────────────────────────────

describe('genBodyInfoScript', () => {
  it('contains CollisionShape3D scan', () => {
    const script = genBodyInfoScript('/root/Player');
    expect(script.includes('CollisionShape3D')).toBeTruthy();
    expect(script.includes('_mcp_get_node("/root/Player")')).toBeTruthy();
    expect(script.includes('has_collision')).toBeTruthy();
  });
  it('contains collision_layer and collision_mask', () => {
    const script = genBodyInfoScript('/root/Player');
    expect(script.includes('collision_layer')).toBeTruthy();
    expect(script.includes('collision_mask')).toBeTruthy();
  });
});

// ─── genDiagnosePhysicsScript ───────────────────────────────────────────────

describe('genDiagnosePhysicsScript', () => {
  it('contains move_and_collide', () => {
    const script = genDiagnosePhysicsScript('/root/Player');
    expect(script.includes('move_and_collide')).toBeTruthy();
    expect(script.includes('ConcavePolygonShape3D')).toBeTruthy();
  });
  it('contains velocity and position info', () => {
    const script = genDiagnosePhysicsScript('/root/Player');
    expect(script.includes('velocity')).toBeTruthy();
    expect(script.includes('position')).toBeTruthy();
  });
});

// ─── genQuerySpatialScript ──────────────────────────────────────────────────

describe('genQuerySpatialScript', () => {
  it('contains intersect_shape', () => {
    const script = genQuerySpatialScript({x:0,y:0,z:0}, 10);
    expect(script.includes('intersect_shape')).toBeTruthy();
    expect(script.includes('SphereShape3D')).toBeTruthy();
    expect(script.includes('radius = 10')).toBeTruthy();
  });
  it('includes collision_mask when provided', () => {
    const script = genQuerySpatialScript({x:0,y:0,z:0}, 10, 0xFF);
    expect(script.includes('collision_mask')).toBeTruthy();
  });
});

// ─── genCollisionOverlayScript ──────────────────────────────────────────────

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
