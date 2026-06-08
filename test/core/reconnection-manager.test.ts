import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReconnectionManager } from '../../src/core/reconnection-manager.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function tick(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ReconnectionManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('succeeds on first attempt', async () => {
    const mgr = new ReconnectionManager();
    const connectFn = vi.fn().mockResolvedValue(true);
    const onExhausted = vi.fn();

    mgr.start(connectFn, onExhausted);
    // Let the async connectFn resolve
    await tick(0);

    expect(connectFn).toHaveBeenCalledTimes(1);
    expect(onExhausted).not.toHaveBeenCalled();
    expect(mgr.isRunning()).toBe(false);
  });

  it('retries with exponential backoff on failure', async () => {
    const mgr = new ReconnectionManager({ baseDelayMs: 100, maxDelayMs: 5000 });
    const connectFn = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const onExhausted = vi.fn();

    mgr.start(connectFn, onExhausted);
    await tick(0);
    expect(connectFn).toHaveBeenCalledTimes(1);

    // First retry after 100ms (2^0 * 100)
    await tick(100);
    expect(connectFn).toHaveBeenCalledTimes(2);

    // Second retry after 200ms (2^1 * 100)
    await tick(200);
    expect(connectFn).toHaveBeenCalledTimes(3);

    // Success on 3rd attempt
    expect(mgr.isRunning()).toBe(false);
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it('stops after maxRetries and calls onExhausted', async () => {
    const mgr = new ReconnectionManager({ maxRetries: 3, baseDelayMs: 50 });
    const connectFn = vi.fn().mockResolvedValue(false);
    const onExhausted = vi.fn();

    mgr.start(connectFn, onExhausted);

    // Attempt 0
    await tick(0);
    expect(connectFn).toHaveBeenCalledTimes(1);

    // Attempt 1 (after 50ms delay)
    await tick(50);
    expect(connectFn).toHaveBeenCalledTimes(2);

    // Attempt 2 (after 100ms delay)
    await tick(100);
    expect(connectFn).toHaveBeenCalledTimes(3);

    // Attempt 3 fails → exhausted (attempt count now equals maxRetries)
    await tick(200);
    // connectFn was called for attempt 3, then scheduleRetry increments to 3,
    // next tryConnect sees attempt >= maxRetries and calls onExhausted
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(mgr.isRunning()).toBe(false);
  });

  it('cancels pending retries', async () => {
    const mgr = new ReconnectionManager({ baseDelayMs: 100 });
    const connectFn = vi.fn().mockResolvedValue(false);
    const onExhausted = vi.fn();

    mgr.start(connectFn, onExhausted);
    await tick(0);
    expect(connectFn).toHaveBeenCalledTimes(1);

    mgr.cancel();
    expect(mgr.isRunning()).toBe(false);

    // Advance past the scheduled retry — should not call again
    await tick(200);
    expect(connectFn).toHaveBeenCalledTimes(1);
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it('handles connectFn throwing synchronously', async () => {
    const mgr = new ReconnectionManager({ maxRetries: 2, baseDelayMs: 50 });
    const connectFn = vi.fn().mockImplementation(() => {
      throw new Error('sync error');
    });
    const onExhausted = vi.fn();

    mgr.start(connectFn, onExhausted);
    await tick(0);
    expect(connectFn).toHaveBeenCalledTimes(1);

    // Should schedule retry despite sync throw
    await tick(50);
    expect(connectFn).toHaveBeenCalledTimes(2);
  });

  it('handles connectFn rejecting', async () => {
    const mgr = new ReconnectionManager({ baseDelayMs: 100, maxRetries: 2 });
    const connectFn = vi.fn().mockRejectedValue(new Error('async error'));
    const onExhausted = vi.fn();

    mgr.start(connectFn, onExhausted);
    await tick(0);
    expect(connectFn).toHaveBeenCalledTimes(1);

    // Retry after delay
    await tick(100);
    expect(connectFn).toHaveBeenCalledTimes(2);

    // Exhausted
    await tick(200);
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it('caps delay at maxDelayMs with jitter', async () => {
    const mgr = new ReconnectionManager({ baseDelayMs: 1000, maxDelayMs: 4000 });
    // With jitter (50-100%), base 1000 -> delay in [500, 1000]
    for (let i = 0; i < 50; i++) {
      const d0 = mgr.getDelayMs(0);  // base 1000
      expect(d0).toBeGreaterThanOrEqual(500);
      expect(d0).toBeLessThanOrEqual(1000);
    }
    // base 2000 -> delay in [1000, 2000]
    for (let i = 0; i < 50; i++) {
      const d1 = mgr.getDelayMs(1);
      expect(d1).toBeGreaterThanOrEqual(1000);
      expect(d1).toBeLessThanOrEqual(2000);
    }
    // Capped: base 4000 -> delay in [2000, 4000]
    for (let i = 0; i < 50; i++) {
      const d2 = mgr.getDelayMs(2);
      expect(d2).toBeGreaterThanOrEqual(2000);
      expect(d2).toBeLessThanOrEqual(4000);
    }
    // Past cap: base 8000, capped to 4000 -> delay in [2000, 4000]
    for (let i = 0; i < 50; i++) {
      const d3 = mgr.getDelayMs(3);
      expect(d3).toBeGreaterThanOrEqual(2000);
      expect(d3).toBeLessThanOrEqual(4000);
    }
  });

  it('does not start twice', async () => {
    const mgr = new ReconnectionManager();
    const connectFn = vi.fn().mockResolvedValue(false);
    const onExhausted = vi.fn();

    mgr.start(connectFn, onExhausted);
    mgr.start(connectFn, onExhausted); // second call ignored
    await tick(0);
    expect(connectFn).toHaveBeenCalledTimes(1);
    mgr.cancel();
  });

  it('tracks attempt number', async () => {
    const mgr = new ReconnectionManager({ baseDelayMs: 50 });
    const connectFn = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    expect(mgr.getAttempt()).toBe(0);
    mgr.start(connectFn, () => {});
    await tick(0);
    // After first failure, scheduleRetry increments attempt to 1
    expect(mgr.getAttempt()).toBe(1);

    await tick(50);
    expect(mgr.getAttempt()).toBe(2); // second failure incremented

    await tick(100);
    // Third attempt succeeded — attempt stays at 2 (only failures increment via scheduleRetry)
    expect(mgr.getAttempt()).toBe(2);
    expect(mgr.isRunning()).toBe(false);
  });

  it('applies jitter to delay calculation', () => {
    const mgr = new ReconnectionManager({ baseDelayMs: 1000, maxDelayMs: 30000 });
    const delays = new Set<number>();
    for (let i = 0; i < 20; i++) {
      delays.add(mgr.getDelayMs(2)); // 1000 * 4 = 4000ms base
    }
    expect(delays.size).toBeGreaterThan(1);
  });

  it('start resolves true on successful reconnection', async () => {
    const mgr = new ReconnectionManager({ baseDelayMs: 50 });
    const connectFn = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const onExhausted = vi.fn();

    const promise = mgr.start(connectFn, onExhausted);
    await tick(0);
    await tick(50);

    const result = await promise;
    expect(result).toBe(true);
    expect(mgr.isRunning()).toBe(false);
  });

  it('start resolves false when retries exhausted', async () => {
    const mgr = new ReconnectionManager({ maxRetries: 2, baseDelayMs: 50 });
    const connectFn = vi.fn().mockResolvedValue(false);
    const onExhausted = vi.fn();

    const promise = mgr.start(connectFn, onExhausted);
    await tick(0);
    await tick(50);
    await tick(100);

    const result = await promise;
    expect(result).toBe(false);
    expect(onExhausted).toHaveBeenCalled();
  });

  it('start resolves false when cancelled', async () => {
    const mgr = new ReconnectionManager({ baseDelayMs: 100 });
    const connectFn = vi.fn().mockResolvedValue(false);
    const onExhausted = vi.fn();

    const promise = mgr.start(connectFn, onExhausted);
    await tick(0);
    mgr.cancel();

    const result = await promise;
    expect(result).toBe(false);
  });
});
