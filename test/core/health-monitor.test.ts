import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolResult } from '../../src/types.js';
import { HealthMonitor } from '../../src/core/health-monitor.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Advance fake timers by ms and flush microtask queue. */
async function tick(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  // Let the async heartbeat callback resolve
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

// ─── Statistics recording ─────────────────────────────────────────────────────

describe('HealthMonitor — statistics recording', () => {
  let monitor: HealthMonitor;

  beforeEach(() => {
    monitor = new HealthMonitor();
  });

  it('records successes and failures in stats', () => {
    monitor.recordSuccess(50);
    monitor.recordSuccess(100);
    monitor.recordFailure('timeout', 'timed out');

    const stats = monitor.getStats();
    expect(stats.totalRequests).toBe(3);
    expect(stats.totalSuccesses).toBe(2);
    expect(stats.totalFailures).toBe(1);
    expect(stats.consecutiveFails).toBe(1);
    expect(stats.avgResponseMs).toBeCloseTo(75);
  });

  it('resets consecutiveFails on success', () => {
    monitor.recordFailure('timeout', 'err');
    monitor.recordFailure('timeout', 'err');
    expect(monitor.getStats().consecutiveFails).toBe(2);

    monitor.recordSuccess(50);
    expect(monitor.getStats().consecutiveFails).toBe(0);
  });

  it('tracks error history up to limit', () => {
    for (let i = 0; i < 25; i++) {
      monitor.recordFailure('timeout', `err-${i}`);
    }
    const stats = monitor.getStats();
    // Default errorHistorySize is 20
    expect(stats.errors).toHaveLength(20);
    expect(stats.errors[0].message).toBe('err-5'); // first 5 dropped
    expect(stats.errors[19].message).toBe('err-24');
    expect(stats.lastError!.message).toBe('err-24');
  });

  it('marks retriable error types', () => {
    monitor.recordFailure('timeout', 't');
    expect(monitor.getStats().errors[0].retriable).toBe(true);

    monitor.recordFailure('unknown_error', 'u');
    const errors = monitor.getStats().errors;
    expect(errors[errors.length - 1].retriable).toBe(false);
  });

  it('stores scope on errors', () => {
    monitor.recordFailure('timeout', 't', 'editor');
    expect(monitor.getStats().errors[0].scope).toBe('editor');
  });
});

// ─── Baseline ─────────────────────────────────────────────────────────────────

describe('HealthMonitor — baseline', () => {
  it('establishes baseline after 10 successful requests', () => {
    const monitor = new HealthMonitor();
    for (let i = 0; i < 10; i++) {
      monitor.recordSuccess(100 + i * 10); // 100..190ms
    }
    const stats = monitor.getStats();
    expect(stats.baselineResponseMs).toBeCloseTo(145); // avg(100..190)
  });

  it('does not establish baseline with fewer than 10 successes', () => {
    const monitor = new HealthMonitor();
    for (let i = 0; i < 9; i++) monitor.recordSuccess(100);
    expect(monitor.getStats().baselineResponseMs).toBe(0);
  });
});

// ─── State machine ────────────────────────────────────────────────────────────

describe('HealthMonitor — state transitions', () => {
  it('starts in connected state', () => {
    const monitor = new HealthMonitor();
    expect(monitor.getState()).toBe('connected');
  });

  it('transitions to degraded when recent failures exceed threshold', () => {
    const monitor = new HealthMonitor({ degradedThreshold: 3 });
    // Need 3 failures in recent 10
    for (let i = 0; i < 3; i++) {
      monitor.recordFailure('timeout', 'err');
    }
    expect(monitor.getState()).toBe('degraded');
  });

  it('transitions connected→reconnecting on max consecutive failures', () => {
    const monitor = new HealthMonitor({ maxConsecutiveFailures: 3 });
    for (let i = 0; i < 3; i++) {
      monitor.recordFailure('timeout', 'err');
    }
    expect(monitor.getState()).toBe('reconnecting');
  });

  it('recovers from degraded to connected', () => {
    const monitor = new HealthMonitor({ degradedThreshold: 3 });

    // Degrade: 3 failures
    for (let i = 0; i < 3; i++) monitor.recordFailure('timeout', 'err');
    expect(monitor.getState()).toBe('degraded');

    // Establish baseline so recovery can check response time
    for (let i = 0; i < 10; i++) monitor.recordSuccess(100);
    // Fill recent window with successes (< 2 failures)
    for (let i = 0; i < 5; i++) monitor.recordSuccess(100);

    expect(monitor.getState()).toBe('connected');
  });

  it('does not auto-transition from disconnected', () => {
    const monitor = new HealthMonitor();
    monitor.setState('disconnected');

    // Even successes should not change state
    for (let i = 0; i < 20; i++) monitor.recordSuccess(50);
    expect(monitor.getState()).toBe('disconnected');
  });

  it('allows manual setState', () => {
    const monitor = new HealthMonitor();
    monitor.setState('degraded');
    expect(monitor.getState()).toBe('degraded');
    monitor.setState('reconnecting');
    expect(monitor.getState()).toBe('reconnecting');
  });

  it('transitions to degraded on high response time (> 2x baseline)', () => {
    const monitor = new HealthMonitor({ degradedThreshold: 5 }); // high threshold so failure count doesn't trigger
    // Establish baseline at ~100ms
    for (let i = 0; i < 10; i++) monitor.recordSuccess(100);
    expect(monitor.getState()).toBe('connected');

    // Now send 10 slow requests (> 2x baseline = 200ms)
    for (let i = 0; i < 12; i++) monitor.recordSuccess(300);
    expect(monitor.getState()).toBe('degraded');
  });
});

// ─── Heartbeat ────────────────────────────────────────────────────────────────

describe('HealthMonitor — heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls pingFn at heartbeatIntervalMs', async () => {
    const monitor = new HealthMonitor({ heartbeatIntervalMs: 5000 });
    const pingFn = vi.fn().mockResolvedValue(true);

    monitor.startHeartbeat(pingFn);
    expect(pingFn).not.toHaveBeenCalled();

    await tick(5000);
    expect(pingFn).toHaveBeenCalledTimes(1);

    await tick(5000);
    expect(pingFn).toHaveBeenCalledTimes(2);

    monitor.stopHeartbeat();
  });

  it('records success on successful ping', async () => {
    const monitor = new HealthMonitor({ heartbeatIntervalMs: 100 });
    const pingFn = vi.fn().mockResolvedValue(true);

    monitor.startHeartbeat(pingFn);
    await tick(100);

    const stats = monitor.getStats();
    expect(stats.totalSuccesses).toBeGreaterThanOrEqual(1);
    monitor.stopHeartbeat();
  });

  it('records failure on failed ping', async () => {
    const monitor = new HealthMonitor({ heartbeatIntervalMs: 100 });
    const pingFn = vi.fn().mockResolvedValue(false);

    monitor.startHeartbeat(pingFn);
    await tick(100);

    const stats = monitor.getStats();
    expect(stats.totalFailures).toBeGreaterThanOrEqual(1);
    monitor.stopHeartbeat();
  });

  it('records failure on ping exception', async () => {
    const monitor = new HealthMonitor({ heartbeatIntervalMs: 100 });
    const pingFn = vi.fn().mockRejectedValue(new Error('network error'));

    monitor.startHeartbeat(pingFn);
    await tick(100);

    const stats = monitor.getStats();
    expect(stats.totalFailures).toBeGreaterThanOrEqual(1);
    expect(stats.lastError!.type).toBe('heartbeat');
    monitor.stopHeartbeat();
  });

  it('stops heartbeat on stopHeartbeat()', async () => {
    const monitor = new HealthMonitor({ heartbeatIntervalMs: 100 });
    const pingFn = vi.fn().mockResolvedValue(true);

    monitor.startHeartbeat(pingFn);
    await tick(100);
    expect(pingFn).toHaveBeenCalledTimes(1);

    monitor.stopHeartbeat();
    await tick(200);
    expect(pingFn).toHaveBeenCalledTimes(1); // no more calls
  });

  it('uses probeIntervalMs when reconnecting', async () => {
    const monitor = new HealthMonitor({
      heartbeatIntervalMs: 100,
      probeIntervalMs: 300,
      maxConsecutiveFailures: 2,
    });
    const pingFn = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    monitor.startHeartbeat(pingFn);

    // First ping fails
    await tick(100);
    expect(pingFn).toHaveBeenCalledTimes(1);

    // Second ping fails — state becomes reconnecting
    await tick(100);
    expect(pingFn).toHaveBeenCalledTimes(2);
    expect(monitor.getState()).toBe('reconnecting');

    // Next ping should be after probeIntervalMs (300), not heartbeat (100)
    await tick(100);
    expect(pingFn).toHaveBeenCalledTimes(2); // not yet

    await tick(200); // total 300ms since last ping
    expect(pingFn).toHaveBeenCalledTimes(3);

    monitor.stopHeartbeat();
  });
});

// ─── Sliding window ───────────────────────────────────────────────────────────

describe('HealthMonitor — sliding window', () => {
  it('limits response time samples to sampleWindowSize', () => {
    const monitor = new HealthMonitor({ sampleWindowSize: 5 });
    for (let i = 0; i < 10; i++) monitor.recordSuccess(i * 10);
    const stats = monitor.getStats();
    // avg of last 5: (50+60+70+80+90)/5 = 70
    expect(stats.avgResponseMs).toBeCloseTo(70);
  });
});
