import { expect } from 'vitest';
import { getToolDefinitions } from '../build/tools/workflow.js';

describe('workflow tool definitions', () => {
  const tools = getToolDefinitions();
  const names = tools.map(t => t.name);

  it('has 3 tools', () => {
    expect(tools.length).toBe(3);
  });

  it('includes dev_loop', () => {
    expect(names.includes('dev_loop')).toBeTruthy();
  });

  it('includes scene_snapshot', () => {
    expect(names.includes('scene_snapshot')).toBeTruthy();
  });

  it('includes batch_validate', () => {
    expect(names.includes('batch_validate')).toBeTruthy();
  });

  it('all tools have required fields', () => {
    for (const tool of tools) {
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.description).toBeTruthy();
    }
  });

  it('dev_loop has bridge parameter', () => {
    const devLoop = tools.find(t => t.name === 'dev_loop');
    const props = devLoop.inputSchema.properties;
    expect(props.bridge).toBeTruthy();
    expect(props.bridge.properties.screenshot).toBeTruthy();
    expect(props.bridge.properties.queries).toBeTruthy();
  });
});
