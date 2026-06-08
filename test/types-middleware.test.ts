import { describe, it, expect } from 'vitest';
import type { DispatchContext, Middleware, MiddlewareResult, ConnectionState } from '../src/types.js';

describe('Middleware types', () => {
  it('DispatchContext has required fields', () => {
    const ctx: DispatchContext = {
      toolName: 'scene',
      args: { action: 'read_scene' },
      startTime: Date.now(),
      phase: 'before',
    };
    expect(ctx.toolName).toBe('scene');
    expect(ctx.phase).toBe('before');
  });

  it('MiddlewareResult passed type is valid', () => {
    const result: MiddlewareResult = { passed: true };
    expect(result.passed).toBe(true);
  });

  it('MiddlewareResult rejected type is valid', () => {
    const result: MiddlewareResult = {
      rejected: true,
      error: { content: [{ type: 'text', text: 'blocked' }] },
    };
    expect(result.rejected).toBe(true);
  });

  it('Middleware interface accepts before and optional after', () => {
    const mw: Middleware = {
      name: 'test',
      before: async () => ({ passed: true }),
      after: async (_ctx, result) => result,
    };
    expect(mw.name).toBe('test');
    expect(mw.after).toBeDefined();
  });

  it('Middleware without after is valid', () => {
    const mw: Middleware = {
      name: 'test-no-after',
      before: async () => ({ passed: true }),
    };
    expect(mw.after).toBeUndefined();
  });

  it('ConnectionState has 4 states', () => {
    const states: ConnectionState[] = ['disconnected', 'connected', 'degraded', 'reconnecting'];
    expect(states).toHaveLength(4);
  });
});
