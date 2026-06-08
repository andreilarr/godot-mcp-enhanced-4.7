import { describe, it, expect, vi } from 'vitest';
import type { ToolResult, MiddlewareResult, DispatchContext, Middleware } from '../../src/types.js';
import { executeMiddleware, createConnectionCheckMiddleware } from '../../src/core/middleware.js';
import { textResult, errorResult } from '../../src/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(toolName = 'test_tool'): DispatchContext {
  return { toolName, args: {}, startTime: Date.now(), phase: 'before' };
}

function pass(): MiddlewareResult {
  return { passed: true };
}

function reject(msg: string): MiddlewareResult {
  return { rejected: true, error: errorResult(msg) };
}

// ─── Pipeline executor ────────────────────────────────────────────────────────

describe('executeMiddleware', () => {
  it('passes through with empty middleware list', async () => {
    const result = await executeMiddleware([], makeCtx(), async () => textResult('ok'));
    expect(result.content[0]).toEqual({ type: 'text', text: 'ok' });
    expect(result.isError).toBeFalsy();
  });

  it('executes tool when all before hooks pass', async () => {
    const mw: Middleware = {
      name: 'pass-all',
      before: async () => pass(),
    };
    const toolFn = vi.fn().mockResolvedValue(textResult('done'));

    const result = await executeMiddleware([mw], makeCtx(), toolFn);

    expect(toolFn).toHaveBeenCalledTimes(1);
    expect(result.content[0]).toEqual({ type: 'text', text: 'done' });
  });

  it('stops before-chain on first rejection and skips tool execution', async () => {
    const mw2Called = vi.fn();
    const mw1: Middleware = {
      name: 'rejector',
      before: async () => reject('blocked'),
    };
    const mw2: Middleware = {
      name: 'should-not-run',
      before: async () => { mw2Called(); return pass(); },
    };
    const toolFn = vi.fn().mockResolvedValue(textResult('done'));

    const result = await executeMiddleware([mw1, mw2], makeCtx(), toolFn);

    expect(mw2Called).not.toHaveBeenCalled();
    expect(toolFn).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it('runs all after hooks even when before was rejected', async () => {
    const afterResults: string[] = [];

    const mw1: Middleware = {
      name: 'rejector',
      before: async () => reject('nope'),
      after: async (_ctx, result) => {
        afterResults.push('mw1-after');
        return result;
      },
    };
    const mw2: Middleware = {
      name: 'observer',
      before: async () => pass(),
      after: async (_ctx, result) => {
        afterResults.push('mw2-after');
        return result;
      },
    };
    const toolFn = vi.fn().mockResolvedValue(textResult('done'));

    await executeMiddleware([mw1, mw2], makeCtx(), toolFn);

    // Both after hooks must run
    expect(afterResults).toEqual(['mw1-after', 'mw2-after']);
    expect(toolFn).not.toHaveBeenCalled();
  });

  it('allows after hooks to modify result', async () => {
    const mw: Middleware = {
      name: 'modifier',
      before: async () => pass(),
      after: async (_ctx, _result) => textResult('modified!'),
    };

    const result = await executeMiddleware([mw], makeCtx(), async () => textResult('original'));

    expect(result.content[0]).toEqual({ type: 'text', text: 'modified!' });
  });

  it('silently catches after hook errors', async () => {
    const mw: Middleware = {
      name: 'throwing-after',
      before: async () => pass(),
      after: async () => { throw new Error('after boom'); },
    };

    // Should not throw — the error is silently caught
    const result = await executeMiddleware([mw], makeCtx(), async () => textResult('ok'));

    // Result should be from tool execution (after hook threw, so its modification is lost)
    expect(result.content[0]).toEqual({ type: 'text', text: 'ok' });
  });

  it('catches before hook throws as rejection', async () => {
    const mw: Middleware = {
      name: 'throwing-before',
      before: async () => { throw new Error('before boom'); },
    };

    const result = await executeMiddleware([mw], makeCtx(), async () => textResult('ok'));

    expect(result.isError).toBe(true);
    expect((result.content[0] as { type: string; text: string }).text).toContain('before boom');
  });

  it('catches tool execution errors', async () => {
    const result = await executeMiddleware([], makeCtx(), async () => {
      throw new Error('tool crashed');
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { type: string; text: string }).text).toContain('tool crashed');
  });
});

// ─── createConnectionCheckMiddleware ──────────────────────────────────────────

describe('createConnectionCheckMiddleware', () => {
  it('rejects online-only tools when disconnected', async () => {
    const mw = createConnectionCheckMiddleware(
      () => false,  // disconnected
      (name) => name.startsWith('offline_'),  // only offline_ tools are ok
    );

    const result = await mw.before(makeCtx('editor_sync'));

    expect('rejected' in result && result.rejected).toBe(true);
  });

  it('allows offline-capable tools when disconnected', async () => {
    const mw = createConnectionCheckMiddleware(
      () => false,  // disconnected
      (name) => name.startsWith('offline_'),
    );

    const result = await mw.before(makeCtx('offline_read'));

    expect('passed' in result && result.passed).toBe(true);
  });

  it('allows all tools when connected', async () => {
    const mw = createConnectionCheckMiddleware(
      () => true,   // connected
      () => false,  // nothing is offline-capable
    );

    const result = await mw.before(makeCtx('editor_sync'));

    expect('passed' in result && result.passed).toBe(true);
  });

  it('integrates with pipeline — blocks disconnected online tool', async () => {
    const mw = createConnectionCheckMiddleware(
      () => false,
      () => false,
    );
    const toolFn = vi.fn().mockResolvedValue(textResult('done'));

    const result = await executeMiddleware([mw], makeCtx('some_tool'), toolFn);

    expect(toolFn).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });
});
