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

  constructor(opts: ReconnectionOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Start the retry cycle. */
  start(
    connectFn: () => Promise<boolean>,
    onExhausted: () => void,
  ): void {
    if (this.running) return;
    this.running = true;
    this.cancelled = false;
    this.attempt = 0;
    getLogger().info('reconnect', 'Reconnection manager started');
    this.tryConnect(connectFn, onExhausted);
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
    return Math.min(this.opts.baseDelayMs * Math.pow(2, attemptNum), this.opts.maxDelayMs);
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private tryConnect(
    connectFn: () => Promise<boolean>,
    onExhausted: () => void,
  ): void {
    if (this.cancelled) {
      this.running = false;
      return;
    }

    if (this.attempt >= this.opts.maxRetries) {
      getLogger().warn('reconnect', `Max retries (${this.opts.maxRetries}) exhausted`);
      this.running = false;
      onExhausted();
      return;
    }

    try {
      // We handle the promise manually to avoid unhandled rejection
      connectFn()
        .then((result) => {
          if (this.cancelled) {
            this.running = false;
            return;
          }
          if (result) {
            getLogger().info('reconnect', `Reconnected on attempt ${this.attempt + 1}`);
            this.running = false;
          } else {
            this.scheduleRetry(connectFn, onExhausted);
          }
        })
        .catch(() => {
          if (this.cancelled) {
            this.running = false;
            return;
          }
          this.scheduleRetry(connectFn, onExhausted);
        });
    } catch {
      // Synchronous throw treated as failure
      if (!this.cancelled) {
        this.scheduleRetry(connectFn, onExhausted);
      }
    }
  }

  private scheduleRetry(
    connectFn: () => Promise<boolean>,
    onExhausted: () => void,
  ): void {
    const delay = this.getDelayMs(this.attempt);
    this.attempt++;
    getLogger().info('reconnect', `Attempt ${this.attempt} failed, retrying in ${delay}ms`);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tryConnect(connectFn, onExhausted);
    }, delay);
  }
}
