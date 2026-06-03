import type { LogEntry } from '../core/logger.js';
import { RingBuffer } from './ring-buffer.js';

export interface ToolStats {
  tool: string;
  calls: number;
  errors: number;
  totalDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  lastCalled: string;
}

export interface TimeSeriesBucket {
  minute: string;
  calls: number;
  errors: number;
  totalDurationMs: number;
  count: number;
}

export interface DashboardState {
  startTime: string;
  mode: string;
  projectPath: string;
  totalCalls: number;
  totalErrors: number;
  toolStats: Map<string, ToolStats>;
  timeSeries: TimeSeriesBucket[];
  recentLogs: RingBuffer<LogEntry>;
}

const RECENT_LOGS_CAPACITY = 500;
const TIME_SERIES_MAX_BUCKETS = 30;

function minuteKey(ts: string): string {
  const d = new Date(ts);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export class Aggregator {
  private totalCalls = 0;
  private totalErrors = 0;
  private toolStats = new Map<string, ToolStats>();
  private timeSeriesBuf = new RingBuffer<TimeSeriesBucket>(TIME_SERIES_MAX_BUCKETS);
  private recentLogs = new RingBuffer<LogEntry>(RECENT_LOGS_CAPACITY);
  private mode = 'unknown';
  private projectPath = '';
  private startTime = new Date().toISOString();

  process(entry: LogEntry): void {
    this.recentLogs.push(entry);

    if (this.mode === 'unknown' && entry.module === 'godot-mcp') {
      const msg = entry.msg.toLowerCase();
      if (msg.includes('editor')) this.mode = 'editor';
      else if (msg.includes('headless')) this.mode = 'headless';
      else if (msg.includes('bridge')) this.mode = 'bridge';
    }

    if (!this.projectPath && entry.type === 'tool_start' && entry.meta) {
      const pp = entry.meta.project_path;
      if (typeof pp === 'string' && pp.length > 0) {
        this.projectPath = pp;
      }
    }

    if (entry.type !== 'tool_end') return;

    this.totalCalls++;
    const tool = entry.tool ?? 'unknown';
    const durationMs = entry.duration_ms ?? 0;
    const isError = !!entry.error;

    if (isError) this.totalErrors++;

    const existing = this.toolStats.get(tool);
    if (existing) {
      existing.calls++;
      existing.errors += isError ? 1 : 0;
      existing.totalDurationMs += durationMs;
      existing.minDurationMs = Math.min(existing.minDurationMs, durationMs);
      existing.maxDurationMs = Math.max(existing.maxDurationMs, durationMs);
      existing.lastCalled = entry.ts;
    } else {
      this.toolStats.set(tool, {
        tool,
        calls: 1,
        errors: isError ? 1 : 0,
        totalDurationMs: durationMs,
        minDurationMs: durationMs,
        maxDurationMs: durationMs,
        lastCalled: entry.ts,
      });
    }

    const key = minuteKey(entry.ts);
    const buckets = this.timeSeriesBuf.toArray();
    const existingBucket = buckets.find(b => b.minute === key);
    if (existingBucket) {
      existingBucket.calls++;
      existingBucket.errors += isError ? 1 : 0;
      existingBucket.totalDurationMs += durationMs;
      existingBucket.count++;
    } else {
      this.timeSeriesBuf.push({
        minute: key,
        calls: 1,
        errors: isError ? 1 : 0,
        totalDurationMs: durationMs,
        count: 1,
      });
    }
  }

  getState(): DashboardState {
    return {
      startTime: this.startTime,
      mode: this.mode,
      projectPath: this.projectPath,
      totalCalls: this.totalCalls,
      totalErrors: this.totalErrors,
      toolStats: this.toolStats,
      timeSeries: this.timeSeriesBuf.toArray(),
      recentLogs: this.recentLogs,
    };
  }

  getTopTools(n: number): ToolStats[] {
    return [...this.toolStats.values()]
      .sort((a, b) => b.calls - a.calls)
      .slice(0, n);
  }
}
