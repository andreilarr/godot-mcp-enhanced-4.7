// src/core/reconnection-manager.ts
//
// Exponential-backoff reconnection manager with configurable retry limits.

import { getLogger } from './logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReconnectionOptions {
  maxRetries?: number;    // default 10
  baseDelayMs?: number;   // default 800
  maxDelayMs?: number;    // default 30000
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULTS: Required<ReconnectionOptions> = {
  maxRetries: 10,
  baseDelayMs: 800,
  maxDelayMs: 30_000,
};

// ─── ReconnectionManager ──────────────────────────────────────────────────────

export class ReconnectionManager {
  private readonly opts: Required<ReconnectionOptions>;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cancelled = false;
  private running = false;
  private pendingResolve: ((result: boolean) => void) | null = null;

  constructor(opts: ReconnectionOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Start the retry cycle. Resolves true on success, false on exhausted/cancelled. */
  start(
    connectFn: () => Promise<boolean>,
    onExhausted: () => void,
  ): Promise<boolean> {
    if (this.running) return Promise.resolve(false);
    this.running = true;
    this.cancelled = false;
    this.attempt = 0;
    getLogger().info('reconnect', 'Reconnection manager started');
    return new Promise<boolean>((resolve) => {
      this.pendingResolve = resolve;
      this.tryConnect(connectFn, onExhausted, resolve);
    });
  }

  /** Cancel further retries. */
  cancel(): void {
    this.cancelled = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) {
      this.running = false;
      getLogger().info('reconnect', 'Reconnection manager cancelled');
    }
    if (this.pendingResolve !== null) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve(false);
    }
  }

  /** Get the current attempt number (0-based). */
  getAttempt(): number {
    return this.attempt;
  }

  /** Whether the manager is currently running. */
  isRunning(): boolean {
    return this.running;
  }

  /** Calculate delay for a given attempt number with exponential backoff + cap. */
  getDelayMs(attemptNum: number): number {
    const base = Math.min(this.opts.baseDelayMs * Math.pow(2, attemptNum), this.opts.maxDelayMs);
    return Math.floor(base * (0.5 + Math.random() * 0.5)); // 50-100% jitter
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private tryConnect(
    connectFn: () => Promise<boolean>,
    onExhausted: () => void,
    done: (result: boolean) => void,
  ): void {
    if (this.cancelled) {
      this.running = false;
      done(false);
      return;
    }

    if (this.attempt >= this.opts.maxRetries) {
      getLogger().warn('reconnect', `Max retries (${this.opts.maxRetries}) exhausted`);
      this.running = false;
      this.pendingResolve = null;
      onExhausted();
      done(false);
      return;
    }

    try {
      // We handle the promise manually to avoid unhandled rejection
      connectFn()
        .then((result) => {
          if (this.cancelled) {
            this.running = false;
            done(false);
            return;
          }
          if (result) {
            getLogger().info('reconnect', `Reconnected on attempt ${this.attempt + 1}`);
            this.running = false;
            this.pendingResolve = null;
            done(true);
          } else {
            this.scheduleRetry(connectFn, onExhausted, done);
          }
        })
        .catch(() => {
          if (this.cancelled) {
            this.running = false;
            done(false);
            return;
          }
          this.scheduleRetry(connectFn, onExhausted, done);
        });
    } catch {
      // Synchronous throw treated as failure
      if (!this.cancelled) {
        this.scheduleRetry(connectFn, onExhausted, done);
      }
    }
  }

  private scheduleRetry(
    connectFn: () => Promise<boolean>,
    onExhausted: () => void,
    done: (result: boolean) => void,
  ): void {
    const delay = this.getDelayMs(this.attempt);
    this.attempt++;
    getLogger().info('reconnect', `Attempt ${this.attempt} failed, retrying in ${delay}ms`);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tryConnect(connectFn, onExhausted, done);
    }, delay);
  }
}
