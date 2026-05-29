import { expect } from 'vitest';
import fc from 'fast-check';
import {
  requiresConfirmation, createPendingToken, consumeToken, pendingCount, resetState,
} from '../src/guard.js';

// ─── requiresConfirmation (merged-tool guard) ────────────────────────────

describe('requiresConfirmation', () => {
  it('returns true for scene.remove_node', () => {
    expect(requiresConfirmation('scene', { action: 'remove_node' })).toBe(true);
  });
  it('returns true for scene.save_scene', () => {
    expect(requiresConfirmation('scene', { action: 'save_scene' })).toBe(true);
  });
  it('returns true for scene.detach_instance', () => {
    expect(requiresConfirmation('scene', { action: 'detach_instance' })).toBe(true);
  });
  it('returns true for any script action (null guard)', () => {
    expect(requiresConfirmation('script')).toBe(true);
    expect(requiresConfirmation('script', { action: 'execute_gdscript' })).toBe(true);
    expect(requiresConfirmation('script', { action: 'write_script' })).toBe(true);
    expect(requiresConfirmation('script', { action: 'edit_script' })).toBe(true);
  });
  it('returns false for scene actions not in guard set', () => {
    expect(requiresConfirmation('scene', { action: 'add_node' })).toBe(false);
    expect(requiresConfirmation('scene', { action: 'read_scene' })).toBe(false);
    expect(requiresConfirmation('scene', { action: 'edit_node' })).toBe(false);
  });
  it('returns false for non-guarded tools', () => {
    expect(requiresConfirmation('animation')).toBe(false);
    expect(requiresConfirmation('validation')).toBe(false);
    expect(requiresConfirmation('workflow')).toBe(false);
  });
});

// ─── createPendingToken + consumeToken ──────────────────────────────────

describe('createPendingToken + consumeToken', () => {
  beforeEach(() => { resetState(); });

  it('creates and consumes a valid token', () => {
    const token = createPendingToken('scene', { action: 'remove_node', node_path: '/root/Player' });
    expect(typeof token === 'string' && token.length > 10).toBeTruthy();
    expect(pendingCount()).toBe(1);

    const result = consumeToken(token);
    expect(result).toBeTruthy();
    expect(result.toolName).toBe('scene');
    expect(result.args).toEqual({ action: 'remove_node', node_path: '/root/Player' });
    expect(pendingCount()).toBe(0);
  });

  it('token is single-use', () => {
    const token = createPendingToken('script', { action: 'write_script', path: 'test.gd' });
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

// ─── Property-based tests ───────────────────────────────────────────────

describe('Property: guard', () => {
  it('requiresConfirmation is deterministic for any string', () => {
    fc.assert(
      fc.property(fc.string(), (toolName) => {
        const result = requiresConfirmation(toolName);
        expect(requiresConfirmation(toolName)).toBe(result);
        expect(typeof result).toBe('boolean');
      }),
      { numRuns: process.env.CI ? 200 : 1000 }
    );
  });

  it('consumeToken with random string always returns null', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 100 }), (token) => {
        expect(consumeToken(token)).toBe(null);
      }),
      { numRuns: process.env.CI ? 200 : 1000 }
    );
  });

  it('createPendingToken + consumeToken roundtrip preserves toolName', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.anything()),
        (toolName, args) => {
          resetState();
          const token = createPendingToken(toolName, args);
          const consumed = consumeToken(token);
          expect(consumed).not.toBeNull();
          expect(consumed.toolName).toBe(toolName);
        }
      ),
      { numRuns: process.env.CI ? 200 : 1000 }
    );
  });
});
