// test/scene-commit-tool.test.ts
import { describe, it, expect } from 'vitest';
import { getToolDefinitions, TOOL_META, parseCommitResult } from '../src/tools/scene-commit-tool.js';

describe('scene-commit-tool: definitions', () => {
  it('exports a scene_commit tool definition', () => {
    const defs = getToolDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe('scene_commit');
  });

  it('has all required schema properties', () => {
    const defs = getToolDefinitions();
    const schema = defs[0]!.inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('project_path');
    expect(props).toHaveProperty('scene_path');
    expect(props).toHaveProperty('operations');
    expect(props).toHaveProperty('save');
    expect(props).toHaveProperty('stop_on_error');
  });

  it('TOOL_META marks scene_commit as writable and long_running', () => {
    expect(TOOL_META.scene_commit).toEqual({ readonly: false, long_running: true });
  });

  it('handleTool returns null for unknown tool names', async () => {
    const { handleTool } = await import('../src/tools/scene-commit-tool.js');
    const result = await handleTool('unknown_tool', {}, {} as any);
    expect(result).toBeNull();
  });
});

describe('scene-commit-tool: parseCommitResult', () => {
  it('parses COMMIT_RESULT from GDScript output', () => {
    const output = 'some noise\nCOMMIT_RESULT: {"success":true,"saved":true,"results":[]}\nmore noise';
    const result = parseCommitResult(output);
    expect(result).toEqual({ success: true, saved: true, results: [] });
  });

  it('returns null when no COMMIT_RESULT marker', () => {
    const result = parseCommitResult('no marker here');
    expect(result).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    const result = parseCommitResult('COMMIT_RESULT: {invalid json}');
    expect(result).toBeNull();
  });

  it('uses last COMMIT_RESULT if multiple exist', () => {
    const output = 'COMMIT_RESULT: {"success":false}\nCOMMIT_RESULT: {"success":true}';
    const result = parseCommitResult(output);
    expect(result).toEqual({ success: true });
  });
});
