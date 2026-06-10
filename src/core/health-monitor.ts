// src/core/health-monitor.ts
//
// Connection health monitor with state machine, sliding-window statistics,
// and optional heartbeat probing.

import { getLogger } from './logger.js';
import { isFeatureEnabled } from './feature-flags.js';
import type { ConnectionState } from '../types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HealthMonitorOptions {
  heartbeatIntervalMs?: number;   // default 30000
  probeIntervalMs?: number;       // default 60000 (used while reconnecting)
  maxConsecutiveFailures?: number; // default 5
  degradedThreshold?: number;     // default 3 (failures in recent window)
  sampleWindowSize?: number;      // default 100
  errorHistorySize?: number;      // default 20
}

export interface ErrorRecord {
  time: number;
  scope?: string;
  type: string;
  message: string;
  retriable: boolean;
}

export interface HealthStats {
  state: ConnectionState;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  consecutiveFails: number;
  avgResponseMs: number;
  baselineResponseMs: number;
  recentFailures: number;       // failures in the last 10 samples
  lastError: ErrorRecord | null;
  errors: ErrorRecord[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULTS: Required<HealthMonitorOptions> = {
  heartbeatIntervalMs: 30_000,
  probeIntervalMs: 60_000,
  maxConsecutiveFailures: 5,
  degradedThreshold: 3,
  sampleWindowSize: 100,
  errorHistorySize: 20,
};

const RECENT_WINDOW = 10;
const BASELINE_SAMPLE_COUNT = 10;

// ─── Ring Buffer (H-02: O(1) push, avoids Array.shift() O(n)) ─────────────────

class RingBuffer<T> {
  private buf: (T | undefined)[];
  private head = 0;
  private count = 0;

  constructor(private capacity: number) {
    this.buf = new Array(capacity);
  }

  push(item: T): void {
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  *[Symbol.iterator](): Iterator<T> {
    const start = this.count < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      yield this.buf[(start + i) % this.capacity] as T;
    }
  }

  get length(): number { return this.count; }

  toArray(): T[] { return [...this]; }

  sliceLast(n: number): T[] {
    const arr = this.toArray();
    return arr.slice(-n);
  }
}

// ─── HealthMonitor ────────────────────────────────────────────────────────────

export class HealthMonitor {
  private readonly opts: Required<HealthMonitorOptions>;
  private state: ConnectionState = 'connected';

  // Counters
  private totalRequests = 0;
  private totalSuccesses = 0;
  private totalFailures = 0;
  private consecutiveFails = 0;

  // H-02: Sliding windows using RingBuffer (O(1) push, no Array.shift)
  private responseTimes!: RingBuffer<number>;
  private recentSuccessFlags!: RingBuffer<boolean>;
  private errors!: RingBuffer<ErrorRecord>;

  // Baseline (average of first BASELINE_SAMPLE_COUNT successful response times)
  private baselineResponseMs = 0;
  private baselineSamples: number[] = [];
  private baselineEstablished = false;

  private lastError: ErrorRecord | null = null;

  // Heartbeat
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private pingFn: (() => Promise<boolean>) | null = null;
  private disposed = false;

  constructor(opts: HealthMonitorOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    // H-02: Initialize RingBuffers with actual opts (may override DEFAULTS)
    this.responseTimes = new RingBuffer<number>(this.opts.sampleWindowSize);
    this.recentSuccessFlags = new RingBuffer<boolean>(this.opts.sampleWindowSize);
    this.errors = new RingBuffer<ErrorRecord>(this.opts.errorHistorySize);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Record a successful tool call. */
  recordSuccess(responseTimeMs: number): void {
    this.totalRequests++;
    this.totalSuccesses++;
    this.consecutiveFails = 0;

    this.responseTimes.push(responseTimeMs);

    this.pushRecentFlag(true);

    // Baseline collection
    if (!this.baselineEstablished) {
      this.baselineSamples.push(responseTimeMs);
      if (this.baselineSamples.length >= BASELINE_SAMPLE_COUNT) {
        this.baselineResponseMs = avg(this.baselineSamples);
        this.baselineEstablished = true;
        getLogger().info('health', `Baseline established: ${this.baselineResponseMs.toFixed(1)}ms`);
      }
    }

    this.evaluateState();
  }

  /** Record a failed tool call. */
  recordFailure(errorType: string, message: string, scope?: string): void {
    this.totalRequests++;
    this.totalFailures++;
    this.consecutiveFails++;

    this.pushRecentFlag(false);

    const record: ErrorRecord = {
      time: Date.now(),
      scope,
      type: errorType,
      message,
      retriable: isRetriable(errorType),
    };
    this.errors.push(record);
    this.lastError = record;

    this.evaluateState();
  }

  /** Get current connection state. */
  getState(): ConnectionState {
    return this.state;
  }

  /** Manually set connection state. */
  setState(newState: ConnectionState): void {
    if (this.state !== newState) {
      getLogger().info('health', `State changed: ${this.state} → ${newState}`);
      this.state = newState;
    }
  }

  /** Get a snapshot of all health statistics. */
  getStats(): HealthStats {
    const recentFlags = this.recentSuccessFlags.sliceLast(RECENT_WINDOW);
    const recentFailures = recentFlags.filter(f => !f).length;
    const rtArr = this.responseTimes.toArray();

    return {
      state: this.state,
      totalRequests: this.totalRequests,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
      consecutiveFails: this.consecutiveFails,
      avgResponseMs: rtArr.length > 0
        ? avg(rtArr)
        : 0,
      baselineResponseMs: this.baselineResponseMs,
      recentFailures,
      lastError: this.lastError,
      errors: this.errors.toArray(),
    };
  }

  /** Start periodic heartbeat using the provided ping function. */
  startHeartbeat(pingFn: () => Promise<boolean>): void {
    this.stopHeartbeat();
    this.pingFn = pingFn;
    this.disposed = false;
    this.scheduleNext();
  }

  /** Stop the heartbeat timer. */
  stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.disposed = true;
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private pushRecentFlag(success: boolean): void {
    this.recentSuccessFlags.push(success);
  }

  private evaluateState(): void {
    if (!isFeatureEnabled('HEALTH_MONITOR')) return;
    if (this.state === 'disconnected') return; // only manual

    // Check reconnecting threshold
    if (this.consecutiveFails >= this.opts.maxConsecutiveFailures) {
      if (this.state !== 'reconnecting') {
        this.setState('reconnecting');
      }
      return;
    }

    // Check degraded
    const recentFlags = this.recentSuccessFlags.sliceLast(RECENT_WINDOW);
    const recentFailures = recentFlags.filter(f => !f).length;

    if (this.state === 'connected') {
      if (recentFailures >= this.opts.degradedThreshold) {
        this.setState('degraded');
        return;
      }
      // Also degrade if response time is > 2x baseline
      if (this.baselineEstablished && this.responseTimes.length >= RECENT_WINDOW) {
        const recentAvg = avg(this.responseTimes.sliceLast(RECENT_WINDOW));
        if (recentAvg > this.baselineResponseMs * 2) {
          this.setState('degraded');
          return;
        }
      }
    }

    if (this.state === 'degraded') {
      // Recover if recent failures < 2 AND response time < 1.5x baseline
      if (recentFailures < 2) {
        if (!this.baselineEstablished || this.responseTimes.length < RECENT_WINDOW) {
          this.setState('connected');
          return;
        }
        const recentAvg = avg(this.responseTimes.sliceLast(RECENT_WINDOW));
        if (recentAvg < this.baselineResponseMs * 1.5) {
          this.setState('connected');
          return;
        }
      }
    }
  }

  private scheduleNext(): void {
    if (this.disposed || !this.pingFn) return;

    const interval = this.state === 'reconnecting'
      ? this.opts.probeIntervalMs
      : this.opts.heartbeatIntervalMs;

    this.heartbeatTimer = setTimeout(async () => {
      if (this.disposed || !this.pingFn) return;
      try {
        const ok = await this.pingFn();
        if (ok) {
          // Heartbeat success: restore state without polluting response-time stats
          this.totalRequests++;
          this.totalSuccesses++;
          this.consecutiveFails = 0;
          this.pushRecentFlag(true);
          if (this.state !== 'connected') this.setState('connected');
        } else {
          this.recordFailure('heartbeat', 'Ping returned false', 'heartbeat');
        }
      } catch (err) {
        this.recordFailure(
          'heartbeat',
          err instanceof Error ? err.message : String(err),
          'heartbeat',
        );
      }
      this.scheduleNext();
    }, interval);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

const RETRIABLE_TYPES = new Set(['timeout', 'connection_reset', 'heartbeat', 'ECONNREFUSED', 'ECONNRESET']);

function isRetriable(errorType: string): boolean {
  return RETRIABLE_TYPES.has(errorType);
}
