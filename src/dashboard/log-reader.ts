import { EventEmitter } from 'node:events';
import { watch, existsSync, statSync, openSync, closeSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { LogEntry } from '../core/logger.js';

export interface LogReaderOptions {
  pollIntervalMs?: number;
}

declare interface LogReader {
  on(event: 'entries', listener: (entries: LogEntry[]) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  emit(event: 'entries', entries: LogEntry[]): boolean;
  emit(event: 'error', err: Error): boolean;
}

const DEFAULT_POLL_MS = 2000;
const MAX_INITIAL_LINES = 500;

class LogReader extends EventEmitter {
  private logDir: string;
  private pollIntervalMs: number;
  private byteOffset = 0;
  private currentFile = '';
  private skippedCount = 0;
  private watcher: ReturnType<typeof watch> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(logDir: string, opts: LogReaderOptions = {}) {
    super();
    this.logDir = logDir;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  }

  async start(): Promise<void> {
    this.currentFile = this.getTodayFile();

    if (existsSync(this.currentFile)) {
      const result = this.readFromOffset(this.currentFile, 0);
      const trimmed = result.entries.slice(-MAX_INITIAL_LINES);
      if (trimmed.length > 0) {
        this.emit('entries', trimmed);
      }
      this.byteOffset = result.bytesRead;
    }

    this.startWatch();
    this.startPolling();
  }

  stop(): void {
    this.stopped = true;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.removeAllListeners();
  }

  getSkippedCount(): number {
    return this.skippedCount;
  }

  getCurrentFile(): string {
    return this.currentFile;
  }

  private getTodayFile(): string {
    const today = new Date().toISOString().slice(0, 10);
    return join(this.logDir, `${today}.jsonl`);
  }

  private startWatch(): void {
    try {
      this.watcher = watch(this.logDir, (event, _filename) => {
        if (this.stopped) return;
        if (event === 'rename' || event === 'change') {
          this.checkForNewData();
        }
      });
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      if (!this.stopped) this.checkForNewData();
    }, this.pollIntervalMs);
  }

  private checkForNewData(): void {
    const todayFile = this.getTodayFile();
    if (todayFile !== this.currentFile) {
      this.currentFile = todayFile;
      this.byteOffset = 0;
    }

    if (!existsSync(this.currentFile)) return;

    const result = this.readFromOffset(this.currentFile, this.byteOffset);
    if (result.bytesRead > 0) {
      this.byteOffset += result.bytesRead;
    }
    if (result.entries.length > 0) {
      this.emit('entries', result.entries);
    }

    for (const entry of result.entries) {
      if (entry.type === 'rotation' && entry.meta?.new_file) {
        const newFile = join(this.logDir, String(entry.meta.new_file));
        if (existsSync(newFile)) {
          this.currentFile = newFile;
          this.byteOffset = 0;
        }
        break;
      }
    }
  }

  /**
   * 用 readSync + Buffer 从 byteOffset 读取增量内容。
   * 精确的字节操作，不依赖字符串偏移。
   */
  private readFromOffset(filePath: string, offset: number): { entries: LogEntry[]; bytesRead: number } {
    try {
      const stat = statSync(filePath);
      if (stat.size <= offset) {
        return { entries: [], bytesRead: 0 };
      }

      const readSize = stat.size - offset;
      const buf = Buffer.alloc(readSize);
      const fd = openSync(filePath, 'r');
      let totalBytes = 0;

      try {
        totalBytes = readSync(fd, buf, 0, readSize, offset);
      } finally {
        closeSync(fd);
      }

      if (totalBytes === 0) {
        return { entries: [], bytesRead: 0 };
      }

      const content = buf.toString('utf-8', 0, totalBytes);
      const lines = content.split('\n').filter(l => l.trim().length > 0);

      const entries: LogEntry[] = [];
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as LogEntry);
        } catch {
          this.skippedCount++;
        }
      }

      return { entries, bytesRead: totalBytes };
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      return { entries: [], bytesRead: 0 };
    }
  }
}

export { LogReader };
