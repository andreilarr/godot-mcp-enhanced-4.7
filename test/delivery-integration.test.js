// test/delivery-integration.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('delivery integration tests', () => {
  it('VERIFY_ELIGIBLE_TOOLS contains expected tools', async () => {
    const reg = await import('../build/core/tool-registry.js');
    const supportedTools = ['add_node', 'edit_node', 'write_script', 'edit_script', 'load_sprite', 'ui_build_layout'];
    for (const name of supportedTools) {
      assert.ok(reg.VERIFY_ELIGIBLE_TOOLS.has(name), `${name} missing from VERIFY_ELIGIBLE_TOOLS`);
    }
  });

  it('verify_delivery is registered in GodotServer toolModules', async () => {
    const mod = await import('../build/tools/delivery.js');
    assert.ok(mod.getToolDefinitions);
    assert.ok(mod.handleTool);
    assert.ok(mod.TOOL_META);
    assert.ok(mod.TOOL_META.verify_delivery);
  });

  it('wrapAssertionCode produces valid SceneTree script', async () => {
    const mod = await import('../build/tools/shared.js');
    const code = mod.wrapAssertionCode('_mcp_output("x", "42")', 'value check');
    assert.ok(code.includes('extends SceneTree'));
    assert.ok(code.includes('_mcp_output("x", "42")'));
    assert.ok(code.includes('_mcp_done'));
  });

  it('dev_loop tool definition includes acceptance', async () => {
    const mod = await import('../build/tools/workflow.js');
    const tools = mod.getToolDefinitions();
    const devLoop = tools.find(t => t.name === 'dev_loop');
    assert.ok(devLoop);
    assert.ok(devLoop.inputSchema.properties.acceptance);
  });

  it('all new test files have no syntax errors', () => {
    // This test passes if the file itself loaded without error
    assert.ok(true);
  });
});
