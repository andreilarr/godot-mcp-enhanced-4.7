import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as scene from '../build/tools/scene.js';

describe('instance_scene tool definition', () => {
  it('should be registered (handleTool returns non-null for instance_scene)', async () => {
    // TOOL_NAMES is not exported; verify via handleTool returning a result (not null)
    const result = await scene.handleTool('instance_scene', {
      project_path: '/tmp/test',
      scene_path: 'res://main.tscn',
      // instance_path intentionally missing to trigger early error return
    }, { opsScript: '' });
    assert.ok(result !== null, 'handleTool should return non-null for instance_scene');
  });

  it('should have tool definition with correct schema', () => {
    const defs = scene.getToolDefinitions();
    const def = defs.find(d => d.name === 'instance_scene');
    assert.ok(def, 'instance_scene tool definition not found');
    assert.ok(def.inputSchema.required?.includes('project_path'));
    assert.ok(def.inputSchema.required?.includes('scene_path'));
    assert.ok(def.inputSchema.required?.includes('instance_path'));
  });

  it('should reject missing instance_path', async () => {
    const result = await scene.handleTool('instance_scene', {
      project_path: '/tmp/test',
      scene_path: 'res://main.tscn',
    }, { opsScript: '' });
    assert.ok(result);
    assert.ok(result.content[0].text.includes('error') || result.content[0].text.includes('Error'));
  });

  it('should reject self-referencing instance_path', async () => {
    const result = await scene.handleTool('instance_scene', {
      project_path: '/tmp/test',
      scene_path: 'res://scenes/main.tscn',
      instance_path: 'res://scenes/main.tscn',
    }, { opsScript: '' });
    assert.ok(result);
    assert.ok(result.content[0].text.includes('CIRCULAR'));
  });
});

describe('instance_scene TOOL_META', () => {
  it('should be marked as write tool', () => {
    const meta = scene.TOOL_META;
    assert.ok(meta['instance_scene']);
    assert.equal(meta['instance_scene'].readonly, false);
  });
});
