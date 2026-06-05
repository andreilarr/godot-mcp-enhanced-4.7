import { EventEmitter } from 'node:events';
import { watch, existsSync, statSync, openSync, closeSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { LogEntry } from '../core/logger.js';

export interface LogReaderOptions {
  pollIntervalMs?: number;
}

export interface LogReaderEvents {
  entries: (entries: LogEntry[]) => void;
  error: (err: Error) => void;
}

const DEFAULT_POLL_MS = 2000;
const MAX_INITIAL_LINES = 500;
const INITIAL_READ_CAP = 100 * 1024; // 初始最多读最后 100KB

class LogReader extends EventEmitter {
  private logDir: string;
  private pollIntervalMs: number;
  private byteOffset = 0;
  private currentFile = '';
  private skippedCount = 0;
  private pendingTail = '';
  private watcher: ReturnType<typeof watch> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private fd: number | null = null;
  private fdPath = '';
  // A-11: 防抖时间戳，避免 fs.watch + setInterval 双重触发时重复 statSync/readSync
  private lastCheckMs = 0;
  private static readonly CHECK_DEBOUNCE_MS = 500;

  constructor(logDir: string, opts: LogReaderOptions = {}) {
    super();
    this.logDir = logDir;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  }

  async start(): Promise<void> {
    this.currentFile = this.getTodayFile();

    if (existsSync(this.currentFile)) {
      const stat = statSync(this.currentFile);
      // A-03: 大文件只读最后 100KB，避免全量加载
      const startOffset = Math.max(0, stat.size - INITIAL_READ_CAP);
      const result = this.readFromOffset(this.currentFile, startOffset);
      const trimmed = result.entries.slice(-MAX_INITIAL_LINES);
      if (trimmed.length > 0) {
        this.emit('entries', trimmed);
      }
      // 初始加载后从文件末尾开始增量读取
      this.byteOffset = stat.size;
      this.pendingTail = '';
    }

    this.startWatch();
    this.startPolling();
  }

  stop(): void {
    this.stopped = true;
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
      this.fdPath = '';
    }
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
    // A-11: 防抖 — fs.watch 事件和轮询可能同时触发，至少间隔 500ms
    const now = Date.now();
    if (now - this.lastCheckMs < LogReader.CHECK_DEBOUNCE_MS) return;
    this.lastCheckMs = now;

    const todayFile = this.getTodayFile();
    if (todayFile !== this.currentFile) {
      this.currentFile = todayFile;
      this.byteOffset = 0;
      this.pendingTail = ''; // 日期切换时清除旧文件尾部残留
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
   * Get or create a cached file descriptor for the given path.
   * Reopens when the path changes (e.g. date rotation).
   */
  private ensureFd(filePath: string): number {
    if (this.fd !== null && this.fdPath === filePath) return this.fd;
    if (this.fd !== null) closeSync(this.fd);
    this.fd = openSync(filePath, 'r');
    this.fdPath = filePath;
    return this.fd;
  }

  /**
   * 用 readSync + Buffer 从 byteOffset 读取增量内容。
   * I-03: 用 pendingTail 缓冲不完整尾部，防止 UTF-8 多字节截断。
   */
  private readFromOffset(filePath: string, offset: number): { entries: LogEntry[]; bytesRead: number } {
    try {
      const stat = statSync(filePath);
      if (stat.size <= offset) {
        return { entries: [], bytesRead: 0 };
      }

      const readSize = stat.size - offset;
      const buf = Buffer.alloc(readSize);
      const fd = this.ensureFd(filePath);
      let totalBytes = 0;

      try {
        totalBytes = readSync(fd, buf, 0, readSize, offset);
      } catch {
        // fd may be stale (file truncated/rotated) — reopen and retry once
        if (this.fd !== null) { closeSync(this.fd); this.fd = null; this.fdPath = ''; }
        const fd2 = this.ensureFd(filePath);
        // Re-stat after reopen: file may have been truncated/rotated
        const newStat = statSync(filePath);
        if (newStat.size <= offset) {
          return { entries: [], bytesRead: 0 };
        }
        const retrySize = Math.min(readSize, newStat.size - offset);
        const retryBuf = Buffer.alloc(retrySize);
        totalBytes = readSync(fd2, retryBuf, 0, retrySize, offset);
      }

      if (totalBytes === 0) {
        return { entries: [], bytesRead: 0 };
      }

      // I-03: 拼接上次的尾部不完整行
      const raw = buf.toString('utf-8', 0, totalBytes);
      const content = this.pendingTail + raw;
      this.pendingTail = '';

      // 找到最后一个 \n，其后的内容可能是不完整行
      const lastNl = content.lastIndexOf('\n');
      let completeContent: string;
      if (lastNl >= 0 && lastNl < content.length - 1) {
        this.pendingTail = content.slice(lastNl + 1);
        completeContent = content.slice(0, lastNl);
      } else if (lastNl === content.length - 1) {
        completeContent = content;
      } else {
        // 没有 \n — 全部是不完整行，留到下次
        this.pendingTail = content;
        return { entries: [], bytesRead: totalBytes };
      }

      const lines = completeContent.split('\n').filter(l => l.trim().length > 0);

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
