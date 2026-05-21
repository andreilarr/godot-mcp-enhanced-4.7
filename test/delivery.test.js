// test/delivery.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('delivery tool definitions', () => {
  it('verify_delivery is in tool definitions', async () => {
    const mod = await import('../build/tools/delivery.js');
    const tools = mod.getToolDefinitions();
    const names = tools.map(t => t.name);
    assert.ok(names.includes('verify_delivery'));
    assert.strictEqual(tools.length, 1);
  });

  it('verify_delivery has required fields', async () => {
    const mod = await import('../build/tools/delivery.js');
    const tool = mod.getToolDefinitions().find(t => t.name === 'verify_delivery');
    assert.ok(tool.inputSchema);
    assert.ok(tool.description);
    const required = tool.inputSchema.required;
    assert.ok(required.includes('project_path'));
    assert.ok(required.includes('scope'));
  });

  it('scope accepts scene, script, full', async () => {
    const mod = await import('../build/tools/delivery.js');
    const tool = mod.getToolDefinitions().find(t => t.name === 'verify_delivery');
    const scopeEnum = tool.inputSchema.properties.scope.enum;
    assert.deepStrictEqual(scopeEnum, ['scene', 'script', 'full']);
  });

  it('checks parameter has expected dimensions', async () => {
    const mod = await import('../build/tools/delivery.js');
    const tool = mod.getToolDefinitions().find(t => t.name === 'verify_delivery');
    const checksProps = tool.inputSchema.properties.checks.properties;
    assert.ok('scene_tree' in checksProps);
    assert.ok('script_health' in checksProps);
    assert.ok('performance' in checksProps);
    assert.ok('assertions' in checksProps);
  });

  it('TOOL_META marks verify_delivery as readonly and long_running', async () => {
    const mod = await import('../build/tools/delivery.js');
    assert.strictEqual(mod.TOOL_META.verify_delivery.readonly, true);
    assert.strictEqual(mod.TOOL_META.verify_delivery.long_running, true);
  });

  it('checkSceneIntegrity is exported', async () => {
    const mod = await import('../build/tools/delivery.js');
    assert.strictEqual(typeof mod.checkSceneIntegrity, 'function');
  });

  it('findAssociatedScenes is exported', async () => {
    const mod = await import('../build/tools/delivery.js');
    assert.strictEqual(typeof mod.findAssociatedScenes, 'function');
  });
});
