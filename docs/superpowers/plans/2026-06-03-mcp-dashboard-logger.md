# PR1: Logger + JSONL 日志层实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建结构化 Logger 模块，替代 console.error/warn 双写到 stderr + JSONL 文件，为 Dashboard TUI 提供数据源。

**Architecture:** Logger 是单例模块，同时写 stderr（保持兼容）和按日期切割的 JSONL 文件（XDG 标准路径）。缓冲批量刷盘，带 sanitizer、tool 配对追踪、优雅关闭。

**Tech Stack:** TypeScript, Node.js fs/writeSync, Vitest, ESM

**Design Spec:** `docs/superpowers/specs/2026-06-03-mcp-dashboard-design.md`

---

## 文件变更清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 创建 | `src/core/logger.ts` | Logger 核心：接口、sanitizer、tool 追踪、JSONL 写入、缓冲、轮转 |
| 创建 | `test/logger.test.ts` | Logger 全量单元测试 |
| 修改 | `src/index.ts` | 引入 Logger，gracefulShutdown 中调用 logger.close() |
| 修改 | `src/GodotServer.ts` | 引入 Logger，替换 10 处 console.error |
| 修改 | `src/core/ToolDispatcher.ts` | 引入 Logger，替换 debug log + 1 处 console.warn |
| 修改 | `src/gdscript-executor.ts` | 引入 Logger，替换 7 处 console.warn/debug |
| 修改 | `src/helpers.ts` | 引入 Logger，替换 3 处 console.warn/error |
| 修改 | `src/core/editor-auth.ts` | 引入 Logger，替换 5 处 console.error |
| 修改 | `src/core/EditorConnection.ts` | 引入 Logger，替换 8 处 console.error/warn |
| 修改 | `src/core/process-state.ts` | 引入 Logger，替换 1 处 console.error |
| 修改 | `src/core/tool-registry.ts` | 引入 Logger，替换 1 处 console.warn |
| 修改 | `src/tools/game-bridge.ts` | 引入 Logger，替换 4 处 console.error/warn |
| 修改 | `src/tools/runtime.ts` | 引入 Logger，替换 1 处 console.error |
| 修改 | `src/tools/code-templates.ts` | 引入 Logger，替换 2 处 console.warn |
| 修改 | `src/godot-docs.ts` | 引入 Logger，替换 1 处 console.error |

---

## Task 1: Logger 核心接口与单例

**Files:**
- 创建: `src/core/logger.ts`
- 创建: `test/logger.test.ts`

- [ ] **Step 1: 编写 Logger 基础接口的失败测试**

```typescript
// test/logger.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getLogger, resetLogger, type LogEntry } from '../src/core/logger.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';

const TEST_LOG_DIR = join(tmpdir(), 'godot-mcp-test-logger');

beforeEach(() => {
  resetLogger();
  mkdirSync(TEST_LOG_DIR, { recursive: true });
});
afterEach(() => {
  const logger = getLogger();
  logger.close();
  rmSync(TEST_LOG_DIR, { recursive: true, force: true });
});

describe('Logger core', () => {
  it('should write info log to JSONL file', () => {
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    logger.info('test-module', 'hello world');
    logger.flush();
    const content = readFileSync(logger.getCurrentLogFile(), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(1);
    const entry: LogEntry = JSON.parse(lines[0]);
    expect(entry.v).toBe(1);
    expect(entry.level).toBe('info');
    expect(entry.module).toBe('test-module');
    expect(entry.msg).toBe('hello world');
  });

  it('should write all log levels', () => {
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    logger.debug('m', 'dbg');
    logger.info('m', 'inf');
    logger.warn('m', 'wrn');
    logger.error('m', 'err');
    logger.flush();
    const lines = readFileSync(logger.getCurrentLogFile(), 'utf-8').trim().split('\n');
    expect(lines.length).toBe(4);
    const levels = lines.map(l => JSON.parse(l).level);
    expect(levels).toEqual(['debug', 'info', 'warn', 'error']);
  });

  it('should also write to stderr', () => {
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    const stderrSpy = vi.spyOn process.stderr, 'write').mockImplementation(() => true);
    logger.info('test', 'stderr check');
    expect(stderrSpy).toHaveBeenCalled();
    const written = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(written).toContain('[test] stderr check');
    stderrSpy.mockRestore();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

运行: `npx vitest run test/logger.test.ts`
预期: FAIL — 模块不存在

- [ ] **Step 3: 实现 Logger 基础模块**

创建 `src/core/logger.ts`，包含：

```typescript
// src/core/logger.ts
import { writeSync, mkdirSync, existsSync, readdirSync, unlinkSync, openSync, closeSync, Stats, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { app } from 'node:process';

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
  logDir?: string;       // 自定义日志目录（测试用）
  bufferMs?: number;     // 缓冲刷新间隔（默认 100ms）
  bufferMax?: number;    // 缓冲最大条目数（默认 50）
  maxRetentionDays?: number; // 保留天数（默认 7）
}

// ─── Sanitizer ─────────────────────────────────────────────

const SENSITIVE_KEYS = /password|secret|token|key|auth/i;
const MAX_STRING_LEN = 200;

function sanitizeValue(v: unknown): unknown {
  if (typeof v === 'string') {
    return v.length > MAX_STRING_LEN ? v.slice(0, MAX_STRING_LEN - 3) + '...' : v;
  }
  return v;
}

function sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SENSITIVE_KEYS.test(k)) {
      result[k] = '***';
    } else {
      result[k] = sanitizeValue(v);
    }
  }
  return result;
}

function sanitizeMsg(msg: string): string {
  return msg.length > MAX_STRING_LEN ? msg.slice(0, MAX_STRING_LEN - 3) + '...' : msg;
}

// ─── Tool tracking ─────────────────────────────────────────

interface PendingTool {
  tool: string;
  startTime: number;
}

const TOOL_TIMEOUT_MS = 60_000;

// ─── XDG log directory ────────────────────────────────────

function getDefaultLogDir(): string {
  const platform = process.platform;
  if (platform === 'win32') {
    const appData = process.env.APPDATA || join(process.env.USERPROFILE || tmpdir(), 'AppData', 'Roaming');
    return join(appData, 'godot-mcp', 'logs');
  }
  if (platform === 'darwin') {
    const home = process.env.HOME || tmpdir();
    return join(home, 'Library', 'Application Support', 'godot-mcp', 'logs');
  }
  // Linux / other — XDG
  const xdgData = process.env.XDG_DATA_HOME || join(process.env.HOME || tmpdir(), '.local', 'share');
  return join(xdgData, 'godot-mcp', 'logs');
}

// ─── Logger class ──────────────────────────────────────────

class Logger {
  private logDir: string;
  private currentFile = '';
  private currentDate = '';
  private buffer: LogEntry[] = [];
  private bufferMs: number;
  private bufferMax: number;
  private maxRetentionDays: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private pendingTools = new Map<string, PendingTool>();
  private destroyed = false;

  constructor(opts: LoggerOptions = {}) {
    this.logDir = opts.logDir ?? getDefaultLogDir();
    this.bufferMs = opts.bufferMs ?? 100;
    this.bufferMax = opts.bufferMax ?? 50;
    this.maxRetentionDays = opts.maxRetentionDays ?? 7;
    this.ensureLogDir();
    this.rotateIfNeeded();
    this.flushTimer = setInterval(() => this.tick(), this.bufferMs);
  }

  debug(module: string, msg: string, meta?: Record<string, unknown>): void {
    this.write('debug', module, msg, meta);
  }

  info(module: string, msg: string, meta?: Record<string, unknown>): void {
    this.write('info', module, msg, meta);
  }

  warn(module: string, msg: string, meta?: Record<string, unknown>): void {
    this.write('warn', module, msg, meta);
  }

  error(module: string, msg: string, meta?: Record<string, unknown>): void {
    this.write('error', module, msg, meta);
  }

  toolStart(tool: string, args?: Record<string, unknown>): string {
    const callId = `${tool}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.pendingTools.set(callId, { tool, startTime: Date.now() });
    const meta: Record<string, unknown> = {};
    if (args) {
      meta.arg_keys = Object.keys(args); // 只记录 key 名
    }
    this.write('info', 'dispatcher', `Tool start: ${tool}`, { ...meta, type_hint: 'tool_start' });
    // 写带 type 的条目
    const lastEntry = this.buffer[this.buffer.length - 1];
    if (lastEntry) {
      lastEntry.type = 'tool_start';
      lastEntry.call_id = callId;
      lastEntry.tool = tool;
    }
    return callId;
  }

  toolEnd(callId: string, tool: string, durationMs: number, error?: string): void {
    const pending = this.pendingTools.get(callId);
    if (!pending) {
      this.warn('dispatcher', `toolEnd: unknown callId ${callId} for ${tool}`);
      return;
    }
    this.pendingTools.delete(callId);
    const entry = this.buildEntry('info', 'dispatcher', `Tool end: ${tool} → ${durationMs}ms${error ? ' ERR' : ' ✓'}`);
    entry.type = 'tool_end';
    entry.call_id = callId;
    entry.tool = tool;
    entry.duration_ms = durationMs;
    if (error) entry.error = error;
    this.pushEntry(entry);
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    this.rotateIfNeeded();
    if (!this.currentFile) return;
    const lines = this.buffer.map(e => JSON.stringify(e) + '\n').join('');
    try {
      writeSync(this.getFd(), lines);
    } catch {
      // 文件写入失败不影响 MCP 服务，stderr 仍然有输出
    }
    this.buffer = [];
  }

  pendingCount(): number {
    return this.buffer.length;
  }

  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // 刷超时的 pendingTools
    this.flushTimedOutTools();
    this.flush();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.fd !== null) {
      try { closeSync(this.fd); } catch { /* ignore */ }
      this.fd = null;
    }
  }

  getCurrentLogFile(): string {
    return this.currentFile;
  }

  // ─── private ───────────────────────────────────────────

  private fd: number | null = null;

  private getFd(): number {
    if (this.fd !== null) return this.fd;
    this.fd = openSync(this.currentFile, 'a');
    return this.fd;
  }

  private ensureLogDir(): void {
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
  }

  private todayStr(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private rotateIfNeeded(): void {
    const today = this.todayStr();
    if (this.currentDate === today) return;
    // 日期切换
    if (this.currentFile) {
      this.flush();
      // 写 rotation 信号
      const entry = this.buildEntry('info', 'logger', `Rotating log file to ${today}.jsonl`);
      entry.type = 'rotation';
      this.pushEntry(entry);
      this.flush();
      if (this.fd !== null) {
        try { closeSync(this.fd); } catch { /* ignore */ }
        this.fd = null;
      }
    }
    this.currentDate = today;
    this.currentFile = join(this.logDir, `${today}.jsonl`);
    this.cleanOldFiles();
  }

  private cleanOldFiles(): void {
    try {
      const files = readdirSync(this.logDir).filter(f => f.endsWith('.jsonl')).sort();
      while (files.length > this.maxRetentionDays) {
        const oldest = files.shift()!;
        try { unlinkSync(join(this.logDir, oldest)); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  private write(level: LogLevel, module: string, msg: string, meta?: Record<string, unknown>): void {
    const entry = this.buildEntry(level, module, msg, meta);
    this.pushEntry(entry);
    // 同时写 stderr（保持兼容）
    const prefix = level === 'info' ? '' : level.toUpperCase() + ' ';
    process.stderr.write(`[${module}] ${prefix}${sanitizeMsg(msg)}\n`);
  }

  private buildEntry(level: LogLevel, module: string, msg: string, meta?: Record<string, unknown>): LogEntry {
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
    return entry;
  }

  private pushEntry(entry: LogEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length >= this.bufferMax) {
      this.flush();
    }
  }

  private tick(): void {
    this.flushTimedOutTools();
    this.flush();
  }

  private flushTimedOutTools(): void {
    const now = Date.now();
    for (const [callId, pending] of this.pendingTools) {
      if (now - pending.startTime > TOOL_TIMEOUT_MS) {
        this.pendingTools.delete(callId);
        const entry = this.buildEntry('warn', 'dispatcher', `Tool timeout: ${pending.tool} (${TOOL_TIMEOUT_MS}ms)`);
        entry.type = 'tool_end';
        entry.call_id = callId;
        entry.tool = pending.tool;
        entry.duration_ms = now - pending.startTime;
        entry.error = 'timeout';
        this.pushEntry(entry);
      }
    }
  }
}

// ─── Singleton ─────────────────────────────────────────────

let instance: Logger | null = null;

export function getLogger(opts?: LoggerOptions): Logger {
  if (!instance) {
    instance = new Logger(opts);
  }
  return instance;
}

export function resetLogger(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

运行: `npx vitest run test/logger.test.ts`
预期: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/logger.ts test/logger.test.ts
git commit -m "feat(logger): core Logger module with dual-write, sanitizer, and tool tracking"
```

---

## Task 2: Sanitizer 测试

**Files:**
- 修改: `test/logger.test.ts`

- [ ] **Step 1: 编写 sanitizer 失败测试**

追加到 `test/logger.test.ts`：

```typescript
describe('Logger sanitizer', () => {
  it('should truncate long strings in msg', () => {
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    const longMsg = 'a'.repeat(300);
    logger.info('m', longMsg);
    logger.flush();
    const entry = JSON.parse(readFileSync(logger.getCurrentLogFile(), 'utf-8').trim());
    expect(entry.msg.length).toBeLessThanOrEqual(200);
    expect(entry.msg).toContain('...');
  });

  it('should redact sensitive keys in meta', () => {
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    logger.info('m', 'test', { password: 'secret123', apiKey: 'key-abc', safe: 'visible' });
    logger.flush();
    const entry = JSON.parse(readFileSync(logger.getCurrentLogFile(), 'utf-8').trim());
    expect(entry.meta.password).toBe('***');
    expect(entry.meta.apiKey).toBe('***');
    expect(entry.meta.safe).toBe('visible');
  });

  it('should truncate long string values in meta', () => {
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    logger.info('m', 'test', { code: 'x'.repeat(300) });
    logger.flush();
    const entry = JSON.parse(readFileSync(logger.getCurrentLogFile(), 'utf-8').trim());
    expect(entry.meta.code.length).toBeLessThanOrEqual(200);
  });
});
```

- [ ] **Step 2: 运行测试确认通过**

运行: `npx vitest run test/logger.test.ts`
预期: PASS（sanitizer 已在 Task 1 实现）

- [ ] **Step 3: 提交**

```bash
git add test/logger.test.ts
git commit -m "test(logger): add sanitizer tests for truncation and sensitive key redaction"
```

---

## Task 3: toolStart/toolEnd 配对测试

**Files:**
- 修改: `test/logger.test.ts`

- [ ] **Step 1: 编写 tool 配对失败测试**

```typescript
describe('Logger tool tracking', () => {
  it('should pair toolStart and toolEnd', () => {
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    const callId = logger.toolStart('read_scene', { project_path: '/tmp/x' });
    logger.toolEnd(callId, 'read_scene', 120);
    logger.flush();
    const lines = readFileSync(logger.getCurrentLogFile(), 'utf-8').trim().split('\n');
    const startEntry = JSON.parse(lines[0]);
    const endEntry = JSON.parse(lines[1]);
    expect(startEntry.type).toBe('tool_start');
    expect(startEntry.call_id).toBe(callId);
    expect(startEntry.meta.arg_keys).toEqual(['project_path']); // 不记录值
    expect(endEntry.type).toBe('tool_end');
    expect(endEntry.call_id).toBe(callId);
    expect(endEntry.duration_ms).toBe(120);
  });

  it('should warn on unknown callId in toolEnd', () => {
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    logger.toolEnd('bogus-id', 'read_scene', 50);
    logger.flush();
    const lines = readFileSync(logger.getCurrentLogFile(), 'utf-8').trim().split('\n');
    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe('warn');
    expect(entry.msg).toContain('unknown callId');
  });

  it('should auto-timeout toolStart after 60s', () => {
    vi.useFakeTimers();
    const logger = getLogger({ logDir: TEST_LOG_DIR, bufferMs: 1000 });
    logger.toolStart('slow_tool');
    // 推进 61 秒
    vi.advanceTimersByTime(61_000);
    logger.flush();
    const lines = readFileSync(logger.getCurrentLogFile(), 'utf-8').trim().split('\n');
    const lastEntry = JSON.parse(lines[lines.length - 1]);
    expect(lastEntry.type).toBe('tool_end');
    expect(lastEntry.error).toBe('timeout');
    expect(lastEntry.level).toBe('warn');
    vi.useRealTimers();
    logger.close();
  });
});
```

- [ ] **Step 2: 运行测试确认通过**

运行: `npx vitest run test/logger.test.ts`
预期: PASS

- [ ] **Step 3: 提交**

```bash
git add test/logger.test.ts
git commit -m "test(logger): add toolStart/toolEnd pairing and timeout tests"
```

---

## Task 4: JSONL 原子写入与轮转测试

**Files:**
- 修改: `test/logger.test.ts`

- [ ] **Step 1: 编写原子写入与轮转失败测试**

```typescript
import { writeFileSync, readdirSync } from 'node:fs';

describe('Logger JSONL writes and rotation', () => {
  it('should write complete JSON lines (no half-lines)', () => {
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    for (let i = 0; i < 20; i++) {
      logger.info('m', `msg ${i}`);
    }
    logger.flush();
    const content = readFileSync(logger.getCurrentLogFile(), 'utf-8');
    const lines = content.trim().split('\n');
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('should create daily log files', () => {
    const logger = getLogger({ logDir: TEST_LOG_DIR });
    logger.info('m', 'today');
    logger.flush();
    const today = new Date().toISOString().slice(0, 10);
    const expected = join(TEST_LOG_DIR, `${today}.jsonl`);
    expect(existsSync(expected)).toBe(true);
  });

  it('should clean old log files beyond retention', () => {
    // 创建 10 个旧文件
    for (let i = 1; i <= 10; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const fname = date.toISOString().slice(0, 10) + '.jsonl';
      writeFileSync(join(TEST_LOG_DIR, fname), '{}\n');
    }
    // 触发轮转（重新创建 Logger）
    resetLogger();
    const logger = getLogger({ logDir: TEST_LOG_DIR, maxRetentionDays: 7 });
    logger.info('m', 'trigger rotation');
    logger.flush();
    const files = readdirSync(TEST_LOG_DIR).filter(f => f.endsWith('.jsonl'));
    expect(files.length).toBeLessThanOrEqual(8); // 7 天 + 今天
    logger.close();
  });
});
```

- [ ] **Step 2: 运行测试确认通过**

运行: `npx vitest run test/logger.test.ts`
预期: PASS

- [ ] **Step 3: 提交**

```bash
git add test/logger.test.ts
git commit -m "test(logger): add atomic write and log rotation tests"
```

---

## Task 5: 优雅关闭 flush 测试

**Files:**
- 修改: `test/logger.test.ts`

- [ ] **Step 1: 编写 close() flush 测试**

```typescript
describe('Logger lifecycle', () => {
  it('should flush buffer on close()', () => {
    const logger = getLogger({ logDir: TEST_LOG_DIR, bufferMs: 60000 }); // 60s 缓冲
    logger.info('m', 'before close');
    // 不手动 flush，直接 close
    logger.close();
    const content = readFileSync(join(TEST_LOG_DIR, new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf-8');
    expect(content).toContain('before close');
  });

  it('pendingCount should return buffer size', () => {
    const logger = getLogger({ logDir: TEST_LOG_DIR, bufferMs: 60000 });
    expect(logger.pendingCount()).toBe(0);
    logger.info('m', 'one');
    expect(logger.pendingCount()).toBe(1);
    logger.info('m', 'two');
    expect(logger.pendingCount()).toBe(2);
    logger.close();
  });
});
```

- [ ] **Step 2: 运行测试确认通过**

运行: `npx vitest run test/logger.test.ts`
预期: PASS

- [ ] **Step 3: 提交**

```bash
git add test/logger.test.ts
git commit -m "test(logger): add lifecycle and flush-on-close tests"
```

---

## Task 6: 集成 Logger 到 index.ts 和 gracefulShutdown

**Files:**
- 修改: `src/index.ts`

- [ ] **Step 1: 在 index.ts 中引入 Logger**

在 `src/index.ts` 顶部添加 import：
```typescript
import { getLogger } from './core/logger.js';
```

修改 `gracefulShutdown` 函数，在 server.close() 前调用 logger.close()：

```typescript
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const logger = getLogger();
  logger.info('godot-mcp', `Received ${signal}, shutting down...`);
  try {
    logger.close(); // flush 缓冲区 + 关闭文件句柄
    await server.close();
  } catch (err) {
    logger.error('godot-mcp', 'Error during shutdown', { error: String(err) });
  }
  process.exit(0);
}
```

修改顶层 catch：
```typescript
} catch (msg) {
  const logger = getLogger();
  logger.error('godot-mcp', 'Failed to run server', { error: String(msg) });
  process.exit(1);
}
```

- [ ] **Step 2: 运行编译确认无错误**

运行: `npx tsc --noEmit`
预期: 0 errors

- [ ] **Step 3: 运行全量测试**

运行: `npx vitest run`
预期: 全部 passed

- [ ] **Step 4: 提交**

```bash
git add src/index.ts
git commit -m "feat(logger): integrate Logger into index.ts gracefulShutdown"
```

---

## Task 7: 迁移 GodotServer.ts 的 console 调用

**Files:**
- 修改: `src/GodotServer.ts`

- [ ] **Step 1: 替换 GodotServer.ts 中的 console 调用**

GodotServer.ts 有 10 处 console.error 和一个 debug log 函数。

添加 import：
```typescript
import { getLogger } from './core/logger.js';
```

替换 DEBUG log 函数（约 L77）：
```typescript
// 旧:
if (DEBUG) console.error('[godot-mcp]', ...args);
// 新:
if (DEBUG) getLogger().debug('godot-mcp', args.map(String).join(' '));
```

替换所有 `console.error(...)` 为对应的 Logger 调用：
- `console.error('[AUTH] ...')` → `getLogger().warn('auth', ...)`
- `console.error('[FATAL] ...')` → `getLogger().error('auth', ...)`
- `console.error('[FALLBACK] ...')` → `getLogger().warn('godot-mcp', ...)`
- `console.error('GODOT_PROJECT_PATH=...')` → `getLogger().warn('godot-mcp', ...)`

注意：保留模块前缀语义，映射到 Logger 的 module 参数。

- [ ] **Step 2: 运行编译和测试**

运行: `npx tsc --noEmit && npx vitest run`
预期: 0 errors, 全部 passed

- [ ] **Step 3: 提交**

```bash
git add src/GodotServer.ts
git commit -m "feat(logger): migrate GodotServer.ts console calls to Logger"
```

---

## Task 8: 迁移 ToolDispatcher.ts 的 console 调用

**Files:**
- 修改: `src/core/ToolDispatcher.ts`

- [ ] **Step 1: 替换 ToolDispatcher.ts 中的 console 调用**

添加 import：
```typescript
import { getLogger } from './logger.js';
```

替换 DEBUG log（约 L29）：
```typescript
// 旧:
if (DEBUG) console.error('[tool-dispatcher]', ...args);
// 新:
if (DEBUG) getLogger().debug('dispatcher', args.map(String).join(' '));
```

替换 console.warn（约 L116）：
```typescript
// 旧:
console.warn('[ToolDispatcher] Profile "%s" resolved to empty set ...', this.options.mode);
// 新:
getLogger().warn('dispatcher', `Profile "${this.options.mode}" resolved to empty set — falling back to full mode`);
```

同时，在 `dispatchTool` 中添加 toolStart/toolEnd 追踪：
```typescript
private async dispatchTool(toolName: string, args: Record<string, unknown>, startTime: number): Promise<ToolResult> {
  // ... 现有代码 ...
  const logger = getLogger();
  const callId = logger.toolStart(toolName, args);
  // ... 执行工具 ...
  const duration = Date.now() - startTime;
  logger.toolEnd(callId, toolName, duration, result.isError ? 'tool_error' : undefined);
  return result;
}
```

注意：确认 `result` 对象中是否有 `isError` 字段或等效判断方式，以确定是否传 error 参数。如果没有，传 `undefined` 即可。

- [ ] **Step 2: 运行编译和测试**

运行: `npx tsc --noEmit && npx vitest run`
预期: 0 errors, 全部 passed

- [ ] **Step 3: 提交**

```bash
git add src/core/ToolDispatcher.ts
git commit -m "feat(logger): migrate ToolDispatcher.ts and add toolStart/toolEnd tracking"
```

---

## Task 9: 迁移 gdscript-executor.ts 的 console 调用

**Files:**
- 修改: `src/gdscript-executor.ts`

- [ ] **Step 1: 替换 gdscript-executor.ts 中的 7 处 console 调用**

添加 import：
```typescript
import { getLogger } from './core/logger.js';
```

映射规则：
- `console.warn('[SECURITY] ...')` → `getLogger().warn('security', ...)`
- `console.warn('[executor] ...')` → `getLogger().warn('gdscript', ...)`
- `console.debug('[executor] ...')` → `getLogger().debug('gdscript', ...)`

- [ ] **Step 2: 运行编译和测试**

运行: `npx tsc --noEmit && npx vitest run`
预期: 0 errors, 全部 passed

- [ ] **Step 3: 提交**

```bash
git add src/gdscript-executor.ts
git commit -m "feat(logger): migrate gdscript-executor.ts console calls"
```

---

## Task 10: 迁移剩余 6 个文件

**Files:**
- 修改: `src/helpers.ts` (3 处)
- 修改: `src/core/editor-auth.ts` (5 处)
- 修改: `src/core/EditorConnection.ts` (8 处)
- 修改: `src/core/process-state.ts` (1 处)
- 修改: `src/core/tool-registry.ts` (1 处)
- 修改: `src/tools/game-bridge.ts` (4 处)
- 修改: `src/tools/runtime.ts` (1 处)
- 修改: `src/tools/code-templates.ts` (2 处)
- 修改: `src/godot-docs.ts` (1 处)

- [ ] **Step 1: 批量迁移所有文件的 console 调用**

对每个文件，添加 `import { getLogger } from '../core/logger.js';`（或对应相对路径），然后将：
- `console.error('[PREFIX] msg')` → `getLogger().error/warn/info('module', 'msg')`
- `console.warn('[PREFIX] msg')` → `getLogger().warn('module', 'msg')`
- `console.debug('[PREFIX] msg')` → `getLogger().debug('module', 'msg')`

模块映射表：
| 前缀 | Logger module |
|------|---------------|
| `[SECURITY]` | `security` |
| `[AUTH]` | `auth` |
| `[FALLBACK]` | `godot-mcp` |
| `[FATAL]` | `godot-mcp` |
| `[executor]` | `gdscript` |
| `[godot-mcp]` | `godot-mcp` |
| `[tool-dispatcher]` | `dispatcher` |
| `[editor-conn]` | `editor` |
| `[bridge]` | `bridge` |
| 无前缀（helpers.ts） | `helpers` |

- [ ] **Step 2: 运行编译和全量测试**

运行: `npx tsc --noEmit && npx vitest run`
预期: 0 errors, 全部 passed（≥1767）

- [ ] **Step 3: 确认无 console 调用残留**

运行: `grep -rn "console\.\(error\|warn\|debug\)" src/ | grep -v "node_modules" | grep -v ".d.ts"`
预期: 仅剩 Logger 内部的 stderr.write 调用

- [ ] **Step 4: 提交**

```bash
git add src/helpers.ts src/core/editor-auth.ts src/core/EditorConnection.ts src/core/process-state.ts src/core/tool-registry.ts src/tools/game-bridge.ts src/tools/runtime.ts src/tools/code-templates.ts src/godot-docs.ts
git commit -m "feat(logger): migrate all remaining console calls to Logger"
```

---

## Task 11: 最终验证

- [ ] **Step 1: TypeScript 编译检查**

运行: `npx tsc --noEmit`
预期: 0 errors

- [ ] **Step 2: ESLint 检查**

运行: `npx eslint src/`
预期: 0 errors

- [ ] **Step 3: 全量测试**

运行: `npx vitest run`
预期: 全部 passed

- [ ] **Step 4: Logger 测试覆盖率**

运行: `npx vitest run test/logger.test.ts --coverage`
预期: logger.ts 覆盖率 > 90%

- [ ] **Step 5: 手动验证 JSONL 输出**

运行: `node -e "import('./build/core/logger.js').then(m => { const l = m.getLogger(); l.info('test','hello'); l.warn('security','path issue',{path:'/etc'}); l.close(); })"`
然后检查 `~/.local/share/godot-mcp/logs/` (Linux) 或 `%APPDATA%/godot-mcp/logs/` (Windows) 下是否有正确的 JSONL 文件。

- [ ] **Step 6: 推送所有修复**

```bash
git log --oneline -11
git push origin master
```
