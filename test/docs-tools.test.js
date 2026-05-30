import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock godot-docs before importing the module under test
const makeClassInfo = (name, inherits = 'CanvasItem') => ({
  name,
  inherits,
  brief_description: `A ${name} object`,
  description: `Description for ${name}`,
  methods: [{
    name: 'set_position',
    return_type: 'void',
    arguments: [{ name: 'position', type: 'Vector2' }],
    description: 'Sets the position.',
  }],
  properties: [{
    name: 'position',
    type: 'Vector2',
    description: 'Position of the node.',
  }],
  signals: [{ name: 'position_changed', description: 'Emitted when position changes.' }],
  constants: [],
  enums: [],
});

vi.mock('../src/godot-docs.js', () => ({
  getClassInfo: vi.fn((className) => makeClassInfo(className)),
  searchClasses: vi.fn(() => [
    { name: 'Node2D', inherits: 'CanvasItem', description: 'A 2D game object' },
    { name: 'Node3D', inherits: 'Node', description: 'A 3D game object' },
  ]),
  findMethod: vi.fn(() => ({
    name: 'set_position',
    return_type: 'void',
    arguments: [{ name: 'position', type: 'Vector2', default_value: undefined }],
    description: 'Sets the position.',
  })),
  getInheritanceChain: vi.fn(() => ['Node2D', 'CanvasItem', 'Node', 'Object']),
  initDocs: vi.fn(),
  clearApiCache: vi.fn(),
}));

import { getToolDefinitions, handleTool, TOOL_META } from '../src/tools/docs.js';

describe('docs tools', () => {
  const ctx = {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getToolDefinitions returns non-empty array', () => {
    const defs = getToolDefinitions();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBeGreaterThanOrEqual(1);
    const names = defs.map(d => d.name);
    // search_classes is now an action inside docs tool
    expect(names).toContain('docs');
    // find_method is now an action inside docs tool
    // get_inheritance is now an action inside docs tool
  });

  it('TOOL_META has entries', () => {
    expect(Object.keys(TOOL_META).length).toBeGreaterThanOrEqual(1);
    expect(TOOL_META['docs']).toBeDefined();
    expect(TOOL_META['docs'].readonly).toBe(true);
  });

  it('handleTool returns null for unknown tool', async () => {
    const result = await handleTool('unknown_tool_xyz', {}, ctx);
    expect(result).toBeNull();
  });

  it('handleTool for search_classes returns results', async () => {
    const result = await handleTool('docs', { action: 'search_classes', query: 'node' }, ctx);
    expect(result).not.toBeNull();
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('Node2D');
    const parsed = JSON.parse(text);
    expect(parsed.count).toBe(2);
    expect(parsed.classes.length).toBe(2);
  });

  it('handleTool for get_class_info returns class details', async () => {
    const result = await handleTool('docs', { action: 'get_class_info', class_name: 'Node2D' }, ctx);
    expect(result).not.toBeNull();
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.name).toBe('Node2D');
    expect(parsed.inherits).toBe('CanvasItem');
    expect(parsed.version_note).toBeDefined();
    expect(typeof parsed.version_note).toBe('string');
    expect(parsed.methods.length).toBeGreaterThanOrEqual(1);
  });

  it('handleTool for find_method returns method info', async () => {
    const result = await handleTool('docs', {
      action: 'find_method',
      class_name: 'Node2D',
      method_name: 'set_position',
    }, ctx);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.name).toBe('set_position');
    expect(parsed.return_type).toBe('void');
    expect(parsed.version_note).toBeDefined();
    expect(typeof parsed.version_note).toBe('string');
  });

  it('handleTool for get_inheritance returns chain', async () => {
    const result = await handleTool('docs', { action: 'get_inheritance', class_name: 'Node2D' }, ctx);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.class).toBe('Node2D');
    expect(parsed.inheritance_chain.length).toBeGreaterThanOrEqual(2);
  });
});

describe('docs version_note', () => {
  const ctx = {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns default version note for standard classes', async () => {
    const result = await handleTool('docs', { action: 'get_class_info', class_name: 'Node2D' }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.version_note).toContain('Godot 4.0');
  });

  it('returns Godot 4.4 note for OpenXRHand', async () => {
    const result = await handleTool('docs', { action: 'get_class_info', class_name: 'OpenXRHand' }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.version_note).toContain('4.4');
  });

  it('returns Godot 4.4 note for XRController3D', async () => {
    const result = await handleTool('docs', { action: 'get_class_info', class_name: 'XRController3D' }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.version_note).toContain('4.4');
  });

  it('returns Godot 4.5 note for JavaClass', async () => {
    const result = await handleTool('docs', { action: 'get_class_info', class_name: 'JavaClass' }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.version_note).toContain('4.5');
  });

  it('returns Godot 4.6 note for TileMapLayer', async () => {
    const result = await handleTool('docs', { action: 'get_class_info', class_name: 'TileMapLayer' }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.version_note).toContain('4.6');
  });

  it('find_method also includes version_note', async () => {
    const result = await handleTool('docs', {
      action: 'find_method',
      class_name: 'TileMapLayer',
      method_name: 'set_position',
    }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.version_note).toContain('4.6');
  });
});
