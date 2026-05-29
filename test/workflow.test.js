import { expect, vi, describe, it } from 'vitest';
import { getToolDefinitions } from '../src/tools/workflow.js';

describe('workflow tool definitions', () => {
  const tools = getToolDefinitions();
  const names = tools.map(t => t.name);

  it('has 1 tool', () => {
    expect(tools.length).toBe(1);
  });

  it('includes workflow', () => {
    expect(names.includes('workflow')).toBeTruthy();
  });

  it('tool has action parameter with correct enum values', () => {
    const wf = tools.find(t => t.name === 'workflow');
    const action = wf.inputSchema.properties.action;
    expect(action).toBeTruthy();
    expect(action.enum).toContain('dev_loop');
    expect(action.enum).toContain('scene_snapshot');
    expect(action.enum).toContain('batch_validate');
  });

  it('tool has required fields', () => {
    for (const tool of tools) {
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.description).toBeTruthy();
    }
  });

  it('workflow has bridge parameter', () => {
    const wf = tools.find(t => t.name === 'workflow');
    const props = wf.inputSchema.properties;
    expect(props.bridge).toBeTruthy();
    expect(props.bridge.properties.screenshot).toBeTruthy();
    expect(props.bridge.properties.queries).toBeTruthy();
  });

  it('bridge.queries has maxItems limit', () => {
    const wf = tools.find(t => t.name === 'workflow');
    const queries = wf.inputSchema.properties.bridge.properties.queries;
    expect(queries.maxItems).toBe(10);
  });
});

describe('workflow dev_loop bridge logic', () => {
  it('BRIDGE_READ_ONLY_METHODS excludes write methods', async () => {
    const { BRIDGE_READ_ONLY_METHODS } = await import('../src/tools/game-bridge.js');
    expect(BRIDGE_READ_ONLY_METHODS.has('set_node_property')).toBe(false);
    expect(BRIDGE_READ_ONLY_METHODS.has('send_key')).toBe(false);
    expect(BRIDGE_READ_ONLY_METHODS.has('call_method')).toBe(false);
    expect(BRIDGE_READ_ONLY_METHODS.has('take_screenshot')).toBe(false);
  });

  it('BRIDGE_READ_ONLY_METHODS includes all read-only methods', async () => {
    const { BRIDGE_READ_ONLY_METHODS } = await import('../src/tools/game-bridge.js');
    expect(BRIDGE_READ_ONLY_METHODS.has('ping')).toBe(true);
    expect(BRIDGE_READ_ONLY_METHODS.has('get_tree')).toBe(true);
    expect(BRIDGE_READ_ONLY_METHODS.has('find_nodes')).toBe(true);
    expect(BRIDGE_READ_ONLY_METHODS.has('get_node_properties')).toBe(true);
    expect(BRIDGE_READ_ONLY_METHODS.has('get_performance')).toBe(true);
    expect(BRIDGE_READ_ONLY_METHODS.has('get_viewport_info')).toBe(true);
    expect(BRIDGE_READ_ONLY_METHODS.size).toBe(6);
  });
});
