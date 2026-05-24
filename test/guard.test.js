import { expect } from 'vitest';
import {
  requiresConfirmation, createPendingToken, consumeToken, pendingCount, GUARDED_TOOLS,
} from '../build/guard.js';

describe('GUARDED_TOOLS', () => {
  it('includes remove_node', () => {
    expect(GUARDED_TOOLS.has('remove_node')).toBeTruthy();
  });
  it('includes execute_gdscript (arbitrary code execution)', () => {
    expect(GUARDED_TOOLS.has('execute_gdscript')).toBeTruthy();
  });
  it('does NOT include write_script (unblocked for usability)', () => {
    expect(GUARDED_TOOLS.has('write_script')).toBeFalsy();
  });
  it('does NOT include edit_script (auto-validate handles safety)', () => {
    expect(GUARDED_TOOLS.has('edit_script')).toBeFalsy();
  });
});

describe('requiresConfirmation', () => {
  it('returns true for remove_node', () => {
    expect(requiresConfirmation('remove_node')).toBe(true);
  });
  it('returns true for execute_gdscript (arbitrary code execution)', () => {
    expect(requiresConfirmation('execute_gdscript')).toBe(true);
  });
  it('returns false for write_script (unblocked)', () => {
    expect(requiresConfirmation('write_script')).toBe(false);
  });
  it('returns false for non-guarded tools', () => {
    expect(requiresConfirmation('read_scene')).toBe(false);
    expect(requiresConfirmation('get_project_info')).toBe(false);
  });
});

describe('createPendingToken + consumeToken', () => {
  it('creates and consumes a valid token', () => {
    const token = createPendingToken('remove_node', { node_path: '/root/Player' });
    expect(typeof token === 'string' && token.length > 10).toBeTruthy();
    expect(pendingCount()).toBe(1);

    const result = consumeToken(token);
    expect(result).toBeTruthy();
    expect(result.toolName).toBe('remove_node');
    expect(result.args).toEqual({ node_path: '/root/Player' });
    expect(pendingCount()).toBe(0);
  });

  it('token is single-use', () => {
    const token = createPendingToken('write_script', { path: 'test.gd' });
    const first = consumeToken(token);
    expect(first).toBeTruthy();
    const second = consumeToken(token);
    expect(second).toBe(null);
  });

  it('unknown token returns null', () => {
    const result = consumeToken('nonexistent_token_12345');
    expect(result).toBe(null);
  });
});
