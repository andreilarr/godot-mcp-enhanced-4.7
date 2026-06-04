/**
 * Logger — MCP Dashboard 的日志基础层
 *
 * 双写 JSONL 文件 + stderr，缓冲批量刷盘，tool 配对追踪，
 * 敏感数据清洗，按日切割 + 保留天数清理。
 */

import { writeSync, closeSync, openSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  v: 1;
  ts: string;
  level: LogLevel;
  module: string;
  msg: string;
  tool?: string;
  duration_ms?: number;
  error?: string;
  type?: 'tool_start' | 'tool_end' | 'rotation';
  call_id?: string;
  meta?: Record<string, unknown>;
}

export interface LoggerOptions {
  logDir?: string;
  bufferMs?: number;
  bufferMax?: number;
  maxRetentionDays?: number;
}

export interface Logger {
  debug(module: string, msg: string, meta?: Record<string, unknown>): void;
  info(module: string, msg: string, meta?: Record<string, unknown>): void;
  warn(module: string, msg: string, meta?: Record<string, unknown>): void;
  error(module: string, msg: string, meta?: Record<string, unknown>): void;
  toolStart(tool: string, args?: Record<string, unknown>): string;
  toolEnd(callId: string, tool: string, durationMs: number, error?: string): void;
  flush(): void;
  pendingCount(): number;
  close(): void;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const DEFAULT_BUFFER_MS = 100;
const DEFAULT_BUFFER_MAX = 50;
const DEFAULT_RETENTION_DAYS = 7;
const MAX_STRING_LEN = 200;
const TOOL_TIMEOUT_MS = 60_000;
const SENSITIVE_RE = /password|secret|token|key|auth/i;

// ---------------------------------------------------------------------------
// 内部工具函数
// ---------------------------------------------------------------------------

/** 8 字符 ID — crypto 随机源，与项目安全惯例一致 */
function nanoid8(): string {
  return randomUUID().replace(/-/g, '').substring(0, 8);
}

/** 确定日志目录 — XDG 标准路径 */
export function resolveLogDir(override?: string): string {
  if (override) return override;
  const platform = process.platform;
  if (platform === 'win32') {
    const base = process.env.APPDATA ?? join(process.env.USERPROFILE ?? tmpdir(), 'AppData', 'Roaming');
    return join(base, 'godot-mcp', 'logs');
  }
  if (platform === 'darwin') {
    const home = process.env.HOME ?? tmpdir();
    return join(home, 'Library', 'Application Support', 'godot-mcp', 'logs');
  }
  // Linux / other
  const xdg = process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? tmpdir(), '.local', 'share');
  return join(xdg, 'godot-mcp', 'logs');
}

/** 当天日期字符串 YYYY-MM-DD */
function todayStr(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** 截断长字符串 */
function truncate(s: string): string {
  if (s.length <= MAX_STRING_LEN) return s;
  return s.slice(0, MAX_STRING_LEN - 3) + '...';
}

/** Sanitize meta 对象：截断 + 敏感 key 替换 */
function sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SENSITIVE_RE.test(k)) {
      result[k] = '***';
      continue;
    }
    if (typeof v === 'string') {
      result[k] = truncate(v);
    } else {
      result[k] = v;
    }
  }
  return result;
}

/** Sanitize msg */
function sanitizeMsg(msg: string): string {
  return truncate(msg);
}

/** stderr 格式化：[module] LEVEL msg — LEVEL 仅 warn/error 显示 */
function formatStderr(entry: LogEntry): string {
  const levelTag = (entry.level === 'warn' || entry.level === 'error')
    ? ` ${entry.level.toUpperCase()}`
    : '';
  return `[${entry.module}]${levelTag} ${entry.msg}\n`;
}

// ---------------------------------------------------------------------------
// Logger 实现
// ---------------------------------------------------------------------------

interface PendingTool {
  tool: string;
  startTime: number;
}

interface LoggerImpl extends Logger {
  _bufferMs: number;
  _bufferMax: number;
  _maxRetentionDays: number;
}

function createLogger(opts: LoggerOptions = {}): Logger {
  const logDir = resolveLogDir(opts.logDir);
  const bufferMs = opts.bufferMs ?? DEFAULT_BUFFER_MS;
  const bufferMax = opts.bufferMax ?? DEFAULT_BUFFER_MAX;
  const maxRetentionDays = opts.maxRetentionDays ?? DEFAULT_RETENTION_DAYS;

  let buffer: LogEntry[] = [];
  let fd: number | null = null;
  let currentDate = todayStr();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const pendingTools = new Map<string, PendingTool>();

  // ---- 文件管理 ----

  function ensureDir(): void {
    mkdirSync(logDir, { recursive: true });
  }

  function currentFilePath(): string {
    return join(logDir, `${currentDate}.jsonl`);
  }

  function openFd(): void {
    ensureDir();
    if (fd !== null) {
      // 已有 fd，检查是否需要轮转（日期变更）
      const today = todayStr();
      if (today !== currentDate) {
        // 写入轮转信号到旧文件
        const rotationEntry: LogEntry = {
          v: 1,
          ts: new Date().toISOString(),
          level: 'info',
          module: 'logger',
          msg: 'Rotating log file',
          type: 'rotation',
          meta: { new_file: `${today}.jsonl` },
        };
        const line = JSON.stringify(rotationEntry) + '\n';
        try { writeSync(fd, line); } catch { /* ignore */ }
        closeSync(fd);
        currentDate = today;
        // 打开新文件
        fd = openSync(currentFilePath(), 'a');
        return;
      }
      return; // 同一天，继续用
    }
    currentDate = todayStr();
    fd = openSync(currentFilePath(), 'a');
  }

  /** 清理过期日志文件 — 基于文件名中的日期判断 */
  function cleanupOldFiles(): void {
    try {
      ensureDir();
      const files = readdirSync(logDir);
      const now = new Date();
      const cutoffDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - maxRetentionDays);
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        // 从文件名解析日期：YYYY-MM-DD.jsonl
        const dateStr = f.replace('.jsonl', '');
        const fileDate = new Date(dateStr + 'T00:00:00');
        if (isNaN(fileDate.getTime())) continue; // 文件名不是标准日期格式，跳过
        if (fileDate < cutoffDate) {
          try { unlinkSync(join(logDir, f)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }

  // ---- 核心写入 ----

  function writeEntry(entry: LogEntry): void {
    buffer.push(entry);
    // stderr 双写
    try {
      process.stderr.write(formatStderr(entry));
    } catch { /* ignore */ }
    // 缓冲满则刷盘
    if (buffer.length >= bufferMax) {
      doFlush();
    } else if (!flushTimer && !closed) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        doFlush();
      }, bufferMs);
      flushTimer.unref?.();
    }
  }

  /** 内部刷盘：写文件 + 检查超时工具 */
  function doFlush(): void {
    if (buffer.length === 0 && pendingTools.size === 0) return;
    try { openFd(); } catch { /* ignore open errors */ }

    // 检查 tool 超时
    checkToolTimeouts();

    if (buffer.length > 0 && fd !== null) {
      const data = buffer.map(e => JSON.stringify(e) + '\n').join('');
      try {
        writeSync(fd, data);
      } catch { /* ignore write errors */ }
      buffer = [];
    }

    // 首次刷盘时清理旧文件
    cleanupOldFiles();
  }

  /** 检查超时未配对的 toolStart */
  function checkToolTimeouts(): void {
    const now = Date.now();
    const timedOut: string[] = [];
    for (const [callId, pending] of pendingTools) {
      if (now - pending.startTime >= TOOL_TIMEOUT_MS) {
        timedOut.push(callId);
      }
    }
    for (const callId of timedOut) {
      const pending = pendingTools.get(callId);
      if (!pending) continue;
      pendingTools.delete(callId);
      const entry: LogEntry = {
        v: 1,
        ts: new Date().toISOString(),
        level: 'warn',
        module: 'logger',
        msg: `Tool call timed out: ${pending.tool}`,
        tool: pending.tool,
        type: 'tool_end',
        call_id: callId,
        duration_ms: now - pending.startTime,
        error: 'timeout',
      };
      buffer.push(entry);
    }
  }

  // ---- 日志级别方法 ----

  function log(level: LogLevel, module: string, msg: string, meta?: Record<string, unknown>): void {
    if (closed) return;
    const entry: LogEntry = {
      v: 1,
      ts: new Date().toISOString(),
      level,
      module,
      msg: sanitizeMsg(msg),
    };
    if (meta && Object.keys(meta).length > 0) {
      entry.meta = sanitizeMeta(meta);
    }
    writeEntry(entry);
  }

  function debug(module: string, msg: string, meta?: Record<string, unknown>): void {
    log('debug', module, msg, meta);
  }
  function info(module: string, msg: string, meta?: Record<string, unknown>): void {
    log('info', module, msg, meta);
  }
  function warn(module: string, msg: string, meta?: Record<string, unknown>): void {
    log('warn', module, msg, meta);
  }
  function error(module: string, msg: string, meta?: Record<string, unknown>): void {
    log('error', module, msg, meta);
  }

  // ---- tool 配对 ----

  function toolStart(tool: string, args?: Record<string, unknown>): string {
    const id = nanoid8();
    const callId = `${tool}:${id}`;
    pendingTools.set(callId, { tool, startTime: Date.now() });

    const entry: LogEntry = {
      v: 1,
      ts: new Date().toISOString(),
      level: 'info',
      module: 'dispatcher',
      msg: `Tool call started: ${tool}`,
      tool,
      type: 'tool_start',
      call_id: callId,
    };
    if (args && Object.keys(args).length > 0) {
      entry.meta = { arg_keys: Object.keys(args) };
    }
    writeEntry(entry);
    return callId;
  }

  function toolEnd(callId: string, tool: string, durationMs: number, err?: string): void {
    const pending = pendingTools.get(callId);
    if (!pending) {
      // 未知 callId → warn
      warn('logger', `Unknown call_id in toolEnd: ${callId}`, { tool });
      return;
    }
    pendingTools.delete(callId);

    const entry: LogEntry = {
      v: 1,
      ts: new Date().toISOString(),
      level: err ? 'error' : 'info',
      module: 'dispatcher',
      msg: `Tool call completed: ${tool}`,
      tool,
      type: 'tool_end',
      call_id: callId,
      duration_ms: durationMs,
    };
    if (err) entry.error = err;
    writeEntry(entry);
  }

  // ---- 公共方法 ----

  function flush(): void {
    doFlush();
  }

  function pendingCount(): number {
    return buffer.length;
  }

  function close(): void {
    if (closed) return;
    closed = true;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    // 刷超时工具
    checkToolTimeouts();
    // 刷缓冲
    if (buffer.length > 0 || fd !== null) {
      try { openFd(); } catch { /* ignore */ }
      if (buffer.length > 0 && fd !== null) {
        const data = buffer.map(e => JSON.stringify(e) + '\n').join('');
        try { writeSync(fd, data); } catch { /* ignore */ }
        buffer = [];
      }
    }
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
      fd = null;
    }
  }

  // 首次刷盘时延迟清理（构造时不执行 I/O）
  return { debug, info, warn, error, toolStart, toolEnd, flush, pendingCount, close } as LoggerImpl;
}

// ---------------------------------------------------------------------------
// 单例管理
// ---------------------------------------------------------------------------

let instance: Logger | null = null;

export function getLogger(opts?: LoggerOptions): Logger {
  if (!instance) {
    instance = createLogger(opts);
  }
  return instance;
}

export function resetLogger(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
