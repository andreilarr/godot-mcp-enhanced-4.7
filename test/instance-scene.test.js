import { expect } from 'vitest';
import * as scene from '../src/tools/scene.js';

describe('instance_scene tool definition', () => {
  it('should be registered via action (handleTool returns non-null for scene+instance_scene)', async () => {
    const result = await scene.handleTool('scene', {
      project_path: '/tmp/test',
      action: 'instance_scene',
      scene_path: 'res://main.tscn',
      // instance_path intentionally missing to trigger early error return
    }, { opsScript: '' });
    expect(result !== null).toBeTruthy();
  });

  it('should have tool definition with correct schema', () => {
    const defs = scene.getToolDefinitions();
    const def = defs[0];
    expect(def.name).toBe('scene');
    expect(def.inputSchema.properties.action.enum).toContain('instance_scene');
    expect(def.inputSchema.required).toContain('action');
    expect(def.inputSchema.properties.instance_path).toBeTruthy();
  });

  it('should reject missing instance_path', async () => {
    const result = await scene.handleTool('scene', {
      project_path: '/tmp/test',
      action: 'instance_scene',
      scene_path: 'res://main.tscn',
    }, { opsScript: '' });
    expect(result).toBeTruthy();
    expect(result.content[0].text.includes('error') || result.content[0].text.includes('Error')).toBeTruthy();
  });

  it('should reject self-referencing instance_path', async () => {
    const result = await scene.handleTool('scene', {
      project_path: '/tmp/test',
      action: 'instance_scene',
      scene_path: 'res://scenes/main.tscn',
      instance_path: 'res://scenes/main.tscn',
    }, { opsScript: '' });
    expect(result).toBeTruthy();
    expect(result.content[0].text.includes('CIRCULAR')).toBeTruthy();
  });
});

describe('instance_scene TOOL_META', () => {
  it('scene tool should be marked as write tool', () => {
    const meta = scene.TOOL_META;
    expect(meta['scene']).toBeTruthy();
    expect(meta['scene'].readonly).toBe(false);
  });
});

describe('set_instance_property tool definition', () => {
  it('should be registered via action', async () => {
    const result = await scene.handleTool('scene', {
      project_path: '/tmp/test',
      action: 'set_instance_property',
      scene_path: 'res://main.tscn',
      // node_path intentionally missing to trigger early error return
    }, { opsScript: '' });
    expect(result !== null).toBeTruthy();
  });

  it('should have action in schema', () => {
    const defs = scene.getToolDefinitions();
    const actionEnum = defs[0].inputSchema.properties.action.enum;
    expect(actionEnum).toContain('set_instance_property');
    expect(defs[0].inputSchema.required).toEqual(['action']);
  });

  it('should be marked as write tool', () => {
    expect(scene.TOOL_META['scene'].readonly).toBe(false);
  });

  it('should reject missing required params', async () => {
    const result = await scene.handleTool('scene', {
      project_path: '/tmp/test',
      action: 'set_instance_property',
      scene_path: 'res://main.tscn',
    }, { opsScript: '' });
    expect(result).toBeTruthy();
    expect(result.content[0].text.includes('MISSING_PARAM') || result.content[0].text.includes('error')).toBeTruthy();
  });

  it('should reject blocked property names', async () => {
    const result = await scene.handleTool('scene', {
      project_path: '/tmp/test',
      action: 'set_instance_property',
      scene_path: 'res://main.tscn',
      node_path: 'root/Player',
      property: 'script',
      value: 'test',
    }, { opsScript: '' });
    expect(result).toBeTruthy();
    expect(result.content[0].text.includes('BLOCKED_PROP')).toBeTruthy();
  });

  it('should reject invalid property names', async () => {
    const result = await scene.handleTool('scene', {
      project_path: '/tmp/test',
      action: 'set_instance_property',
      scene_path: 'res://main.tscn',
      node_path: 'root/Player',
      property: 'invalid-name!',
      value: 'test',
    }, { opsScript: '' });
    expect(result).toBeTruthy();
    expect(result.content[0].text.includes('INVALID_PARAM') || result.content[0].text.includes('Invalid property')).toBeTruthy();
  });
});

describe('detach_instance tool definition', () => {
  it('should be registered via action', async () => {
    const result = await scene.handleTool('scene', {
      project_path: '/tmp/test',
      action: 'detach_instance',
      scene_path: 'res://main.tscn',
    }, { opsScript: '' });
    expect(result !== null).toBeTruthy();
  });

  it('should have action in schema', () => {
    const defs = scene.getToolDefinitions();
    const actionEnum = defs[0].inputSchema.properties.action.enum;
    expect(actionEnum).toContain('detach_instance');
    expect(defs[0].inputSchema.required).toEqual(['action']);
  });

  it('should be marked as write tool', () => {
    const meta = scene.TOOL_META;
    expect(meta['scene']).toBeTruthy();
    expect(meta['scene'].readonly).toBe(false);
    expect(meta['scene'].long_running).toBe(true);
  });

  it('should reject missing node_path', async () => {
    const result = await scene.handleTool('scene', {
      project_path: '/tmp/test',
      action: 'detach_instance',
      scene_path: 'res://main.tscn',
    }, { opsScript: '' });
    expect(result).toBeTruthy();
    expect(result.content[0].text.includes('MISSING_PARAM') || result.content[0].text.includes('node_path')).toBeTruthy();
  });
});
