import { describe, it, expect } from 'vitest';
import { opsError, opsErrorResult } from '../../src/tools/shared.js';

describe('opsError with suggestions', () => {
  it('should include suggestion field when provided', () => {
    const result = opsError('NODE_NOT_FOUND', 'Node not found: root/Player', {
      suggestion: 'Use query_scene_tree to list available nodes, or check spelling.',
    });
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('NODE_NOT_FOUND');
    expect(result.error).toBe('Node not found: root/Player');
    expect(result.suggestion).toBe('Use query_scene_tree to list available nodes, or check spelling.');
    expect(result.warnings).toEqual([]);
  });

  it('should work without suggestion (backward compat)', () => {
    const result = opsError('INVALID_PARAMS', 'Missing required parameter');
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('INVALID_PARAMS');
    expect(result.error).toBe('Missing required parameter');
    expect(result.suggestion).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it('should omit suggestion when opts has empty suggestion', () => {
    const result = opsError('TEST_ERROR', 'test', { suggestion: '' });
    expect(result.suggestion).toBeUndefined();
  });

  it('should omit suggestion when opts is empty object', () => {
    const result = opsError('TEST_ERROR', 'test', {});
    expect(result.suggestion).toBeUndefined();
  });

  it('opsErrorResult should produce valid JSON with suggestion', () => {
    const result = opsErrorResult('TEST_ERROR', 'test message', {
      suggestion: 'Try this fix.',
    });
    const firstContent = result.content[0];
    expect(firstContent).toBeDefined();
    expect('text' in firstContent!).toBe(true);

    const parsed = JSON.parse((firstContent as { text: string }).text);
    expect(parsed.success).toBe(false);
    expect(parsed.error_code).toBe('TEST_ERROR');
    expect(parsed.error).toBe('test message');
    expect(parsed.suggestion).toBe('Try this fix.');
    expect(parsed.warnings).toEqual([]);
  });

  it('opsErrorResult should produce valid JSON without suggestion', () => {
    const result = opsErrorResult('OTHER_ERROR', 'other message');
    const firstContent = result.content[0];
    const parsed = JSON.parse((firstContent as { text: string }).text);
    expect(parsed.success).toBe(false);
    expect(parsed.error_code).toBe('OTHER_ERROR');
    expect(parsed.suggestion).toBeUndefined();
  });
});
