// test/workflow-acceptance.test.js
import { expect } from 'vitest';

describe('dev_loop acceptance parameter', () => {
  it('workflow definition includes acceptance parameter', async () => {
    const mod = await import('../src/tools/workflow.js');
    const tools = mod.getToolDefinitions();
    const wf = tools.find(t => t.name === 'workflow');
    expect(wf).toBeTruthy();
    const props = wf.inputSchema.properties;
    expect('acceptance' in props).toBeTruthy();
  });

  it('acceptance has assertions array with required fields', async () => {
    const mod = await import('../src/tools/workflow.js');
    const tools = mod.getToolDefinitions();
    const wf = tools.find(t => t.name === 'workflow');
    const acceptanceProps = wf.inputSchema.properties.acceptance.properties;
    expect('assertions' in acceptanceProps).toBeTruthy();
    const items = acceptanceProps.assertions.items;
    expect(items.properties.description).toBeTruthy();
    expect(items.properties.gdscript).toBeTruthy();
    expect(items.properties.expect).toBeTruthy();
    expect(items.required.includes('description')).toBeTruthy();
    // gdscript is optional — screenshot_diff assertions don't need it
    expect(items.required.includes('gdscript')).toBeFalsy();
  });

  it('acceptance does not expose max_retries (removed until implemented)', async () => {
    const mod = await import('../src/tools/workflow.js');
    const tools = mod.getToolDefinitions();
    const wf = tools.find(t => t.name === 'workflow');
    const acceptanceProps = wf.inputSchema.properties.acceptance.properties;
    expect('max_retries' in acceptanceProps).toBeFalsy();
  });
});
