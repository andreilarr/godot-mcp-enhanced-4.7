import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock executor
vi.mock('../src/gdscript-executor.js', () => ({
  executeGdscript: vi.fn(async () => ({
    success: true, compile_success: true, compile_error: '',
    errors: [], run_success: true, run_error: '',
    outputs: [{ key: 'result', value: JSON.stringify({ passed: true, message: 'Node exists: root/Player' }) }],
    raw_output: '', duration_ms: 100,
  })),
}));

import { getToolDefinitions, handleTool, TOOL_META } from '../src/tools/test-framework.js';

describe('test-framework tools', () => {
  const mockCtx = {
    findGodot: vi.fn(async () => '/usr/bin/godot'),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCtx.findGodot.mockResolvedValue('/usr/bin/godot');
  });

  it('getToolDefinitions returns 1 merged definition named "test"', () => {
    const defs = getToolDefinitions();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBe(1);
    expect(defs[0].name).toBe('test');
  });

  it('action enum contains all 5 actions', () => {
    const defs = getToolDefinitions();
    const actionEnum = defs[0].inputSchema.properties.action.enum;
    expect(actionEnum).toContain('assert');
    expect(actionEnum).toContain('stress');
    expect(actionEnum).toContain('export_list_presets');
    expect(actionEnum).toContain('export_get_preset');
    expect(actionEnum).toContain('export_build');
  });

  it('TOOL_META has exactly 1 entry for "test"', () => {
    expect(Object.keys(TOOL_META).length).toBe(1);
    expect(TOOL_META.test).toBeDefined();
    expect(TOOL_META.test.readonly).toBe(true);
    expect(TOOL_META.test.long_running).toBe(false);
  });

  it('handleTool returns null for unknown tool', async () => {
    const result = await handleTool('unknown_tool_xyz', {}, mockCtx);
    expect(result).toBeNull();
  });

  it('handleTool for test assert with node_exists', async () => {
    const { executeGdscript } = await import('../src/gdscript-executor.js');
    executeGdscript.mockResolvedValueOnce({
      success: true,
      compile_success: true,
      compile_error: '',
      errors: [],
      run_success: true,
      run_error: '',
      outputs: [{ key: 'result', value: JSON.stringify({ passed: true, message: 'Node exists: root/Player' }) }],
      raw_output: '',
      duration_ms: 100,
    });

    const result = await handleTool('test', {
      project_path: 'C:/tmp/test-project',
      action: 'assert',
      assertion_type: 'node_exists',
      path: 'root/Player',
    }, mockCtx);
    expect(result).not.toBeNull();
    const text = result.content[0].text;
    expect(text).toBeTruthy();
    expect(text.length).toBeGreaterThan(0);
  });

  it('handleTool for test assert with invalid assertion_type', async () => {
    const result = await handleTool('test', {
      project_path: '/tmp/test-project',
      action: 'assert',
      assertion_type: 'invalid_type',
    }, mockCtx);
    expect(result).not.toBeNull();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_PARAMS');
  });

  it('handleTool for test assert with missing project_path', async () => {
    const result = await handleTool('test', {
      action: 'assert',
      assertion_type: 'node_exists',
    }, mockCtx);
    expect(result).not.toBeNull();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_PARAMS');
  });

  it('handleTool for test stress', async () => {
    const { executeGdscript } = await import('../src/gdscript-executor.js');
    executeGdscript.mockResolvedValueOnce({
      success: true, compile_success: true, compile_error: '',
      errors: [], run_success: true, run_error: '',
      outputs: [{ key: 'result', value: JSON.stringify({
        success: true, iterations: 100, node_type: 'Node',
        memory_before: 1000000, memory_after: 1000000, peak_memory: 1000100,
        leaked: false,
        message: 'Stress test PASSED: 100 iterations, memory stable',
      }) }],
      raw_output: '', duration_ms: 100,
    });

    const result = await handleTool('test', {
      project_path: '/tmp/test-project',
      action: 'stress',
      node_type: 'Node',
      iterations: 100,
    }, mockCtx);
    expect(result).not.toBeNull();
    expect(result.isError).toBeFalsy();
  });

  it('handleTool for test stress with invalid node_type', async () => {
    const result = await handleTool('test', {
      project_path: '/tmp/test-project',
      action: 'stress',
      node_type: 'MaliciousNode',
    }, mockCtx);
    expect(result).not.toBeNull();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_NODE_TYPE');
  });

  it('export_list_presets returns EDITOR_ONLY error', async () => {
    const result = await handleTool('test', {
      project_path: '/tmp/test-project',
      action: 'export_list_presets',
    }, mockCtx);
    expect(result).not.toBeNull();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('EDITOR_ONLY');
  });

  it('export_build returns EDITOR_ONLY error', async () => {
    const result = await handleTool('test', {
      project_path: '/tmp/test-project',
      action: 'export_build',
      preset: 'windows',
    }, mockCtx);
    expect(result).not.toBeNull();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('EDITOR_ONLY');
  });
});
