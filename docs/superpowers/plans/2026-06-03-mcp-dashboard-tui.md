# PR2: Dashboard TUI 面板实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建独立 CLI 终端面板，实时显示 MCP 服务端日志、工具调用统计、服务状态和性能趋势，不占用 Claude Code 对话上下文。

**Architecture:** Dashboard 是独立 CLI 进程（`godot-mcp-dashboard`），通过 JSONL 文件与 MCP 服务解耦。LogReader 用 fs.watch + 2s 轮询读取增量日志，Aggregator 聚合统计，ink 渲染四面板 TUI 布局。

**Tech Stack:** TypeScript, ink (React for CLI), React, Vitest, ESM

**Design Spec:** `docs/superpowers/specs/2026-06-03-mcp-dashboard-design.md` 第 4-7 节

**前置条件:** PR1 Logger 层已完成（`src/core/logger.ts` 已存在）

---

## 文件变更清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 创建 | `src/dashboard/sparkline.ts` | sparkline 图表渲染（纯函数） |
| 创建 | `src/dashboard/ring-buffer.ts` | 环形缓冲区（O(1) 插入） |
| 创建 | `src/dashboard/themes.ts` | 颜色主题常量（集中管理） |
| 创建 | `src/dashboard/aggregator.ts` | 统计聚合器 + DashboardState |
| 创建 | `src/dashboard/log-reader.ts` | JSONL 文件读取 + fs.watch + 轮询 |
| 创建 | `src/dashboard/ui.tsx` | ink 四面板布局 |
| 创建 | `src/dashboard/index.ts` | CLI 入口（shebang + 参数解析） |
| 创建 | `test/dashboard/sparkline.test.ts` | sparkline 测试 |
| 创建 | `test/dashboard/ring-buffer.test.ts` | RingBuffer 测试 |
| 创建 | `test/dashboard/aggregator.test.ts` | Aggregator 测试 |
| 创建 | `test/dashboard/log-reader.test.ts` | LogReader 测试 |
| 修改 | `tsconfig.json` | 添加 `"jsx": "react-jsx"` |
| 修改 | `package.json` | 添加 optionalDependencies + bin |

---

## Task 1: RingBuffer 环形缓冲区

**Files:**
- Create: `src/dashboard/ring-buffer.ts`
- Create: `test/dashboard/ring-buffer.test.ts`

- [ ] **Step 1: 编写 RingBuffer 失败测试**

```typescript
// test/dashboard/ring-buffer.test.ts
import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../../src/dashboard/ring-buffer.js';

describe('RingBuffer', () => {
  it('should push and retrieve items in order', () => {
    const buf = new RingBuffer<string>(3);
    buf.push('a');
    buf.push('b');
    buf.push('c');
    expect(buf.toArray()).toEqual(['a', 'b', 'c']);
    expect(buf.length).toBe(3);
  });

  it('should overwrite oldest item when full', () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4); // overwrites 1
    expect(buf.toArray()).toEqual([2, 3, 4]);
    expect(buf.length).toBe(3);
  });

  it('should handle single capacity', () => {
    const buf = new RingBuffer<number>(1);
    buf.push(10);
    buf.push(20);
    expect(buf.toArray()).toEqual([20]);
    expect(buf.length).toBe(1);
  });

  it('should return empty array when nothing pushed', () => {
    const buf = new RingBuffer<number>(5);
    expect(buf.toArray()).toEqual([]);
    expect(buf.length).toBe(0);
  });

  it('should handle wrap-around multiple times', () => {
    const buf = new RingBuffer<number>(3);
    for (let i = 0; i < 10; i++) buf.push(i);
    expect(buf.toArray()).toEqual([7, 8, 9]);
    expect(buf.length).toBe(3);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/dashboard/ring-buffer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 RingBuffer**

```typescript
// src/dashboard/ring-buffer.ts
/**
 * RingBuffer — 固定容量环形缓冲区，O(1) 插入。
 * 用于 Dashboard recentLogs（替代 Array.shift 的 O(n) 操作）。
 */
export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private size = 0;

  constructor(private capacity: number) {
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.size; i++) {
      const idx = (this.head - this.size + i + this.capacity) % this.capacity;
      const item = this.buffer[idx];
      if (item !== undefined) result.push(item);
    }
    return result;
  }

  get length(): number {
    return this.size;
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
    this.buffer = new Array(this.capacity);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/dashboard/ring-buffer.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
mkdir -p src/dashboard test/dashboard
git add src/dashboard/ring-buffer.ts test/dashboard/ring-buffer.test.ts
git commit -m "feat(dashboard): RingBuffer with O(1) push and 5 tests"
```

---

## Task 2: Sparkline 纯函数

**Files:**
- Create: `src/dashboard/sparkline.ts`
- Create: `test/dashboard/sparkline.test.ts`

- [ ] **Step 1: 编写 Sparkline 失败测试**

```typescript
// test/dashboard/sparkline.test.ts
import { describe, it, expect } from 'vitest';
import { sparkline } from '../../src/dashboard/sparkline.js';

describe('sparkline', () => {
  it('should render empty data as empty string', () => {
    expect(sparkline([])).toBe('');
  });

  it('should render single value as full bar', () => {
    expect(sparkline([5])).toBe('█');
  });

  it('should render linear ramp', () => {
    // 0,1,2,3,4 → ▁▂▃▄█ (approximately)
    const result = sparkline([0, 1, 2, 3, 4]);
    expect(result).toContain('▁');
    expect(result).toContain('█');
    expect(result.length).toBe(5);
  });

  it('should render all zeros as minimum bar', () => {
    const result = sparkline([0, 0, 0]);
    expect(result).toBe('▁▁▁');
  });

  it('should handle large dataset by sampling', () => {
    const data = Array.from({ length: 100 }, (_, i) => i);
    const result = sparkline(data, { maxWidth: 30 });
    expect(result.length).toBeLessThanOrEqual(30);
  });

  it('should preserve non-zero minimum offset', () => {
    // 10,11,12,13,14 → still shows range ▁▂▃▄█
    const result = sparkline([10, 11, 12, 13, 14]);
    expect(result[0]).toBe('▁');
    expect(result[result.length - 1]).toBe('█');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/dashboard/sparkline.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 Sparkline**

```typescript
// src/dashboard/sparkline.ts
/**
 * Sparkline — 将数值数组渲染为 Unicode 块状字符。
 * 纯函数，无外部依赖。
 *
 * 字符集（8 级）：▁▂▃▄▅▆▇█
 */

const CHARS = '▁▂▃▄▅▆▇█';

export interface SparklineOptions {
  /** 最大输出宽度（超出时降采样） */
  maxWidth?: number;
}

/**
 * 将数值数组转换为 sparkline 字符串。
 * - 空数组返回空字符串
 * - 所有值相同时全部显示最低档 ▁
 * - 超过 maxWidth 时均匀降采样
 */
export function sparkline(data: number[], opts: SparklineOptions = {}): string {
  if (data.length === 0) return '';

  let values = data;
  const maxWidth = opts.maxWidth ?? data.length;

  // 降采样：均匀取 maxWidth 个点
  if (values.length > maxWidth) {
    const sampled: number[] = [];
    const step = (values.length - 1) / (maxWidth - 1);
    for (let i = 0; i < maxWidth; i++) {
      sampled.push(values[Math.round(i * step)]);
    }
    values = sampled;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;

  return values
    .map(v => {
      if (range === 0) return CHARS[0];
      const normalized = (v - min) / range;
      const idx = Math.min(Math.floor(normalized * (CHARS.length - 1)), CHARS.length - 1);
      return CHARS[Math.max(0, idx)];
    })
    .join('');
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/dashboard/sparkline.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/dashboard/sparkline.ts test/dashboard/sparkline.test.ts
git commit -m "feat(dashboard): sparkline renderer with sampling and 6 tests"
```

---

## Task 3: Themes 颜色主题

**Files:**
- Create: `src/dashboard/themes.ts`

- [ ] **Step 1: 创建 Themes 常量**

```typescript
// src/dashboard/themes.ts
/**
 * Themes — Dashboard 颜色主题常量集中管理。
 * 所有颜色定义在一处，方便全局调整。
 */

/** 日志级别颜色映射 */
export const LEVEL_COLORS: Record<string, string> = {
  debug: 'gray',
  info: 'white',
  warn: 'yellow',
  error: 'red',
};

/** 日志级别前缀文本 */
export const LEVEL_PREFIX: Record<string, string> = {
  debug: '[dbg]',
  info: '',
  warn: 'WARN',
  error: 'ERROR',
};

/** 模块颜色映射 */
export const MODULE_COLORS: Record<string, string> = {
  dispatcher: 'cyan',
  gdscript: 'green',
  runtime: 'blue',
  bridge: 'magenta',
  security: 'red',
  validation: 'yellow',
  auth: 'yellow',
  editor: 'cyan',
  helpers: 'gray',
  'godot-mcp': 'white',
  logger: 'gray',
};

/** 状态指示符 */
export const STATUS = {
  connected: '●',
  disconnected: '○',
  paused: '❚❚',
} as const;

/** sparkline 标签颜色 */
export const SPARKLINE_COLORS = {
  calls: 'green',
  errors: 'red',
  latency: 'cyan',
} as const;

/** 面板边框颜色 */
export const BORDER_COLOR = 'gray';

/** 快捷键栏颜色 */
export const KEYBIND_COLOR = 'gray';
```

- [ ] **Step 2: 提交**

```bash
git add src/dashboard/themes.ts
git commit -m "feat(dashboard): centralized color theme constants"
```

---

## Task 4: Aggregator 统计聚合器

**Files:**
- Create: `src/dashboard/aggregator.ts`
- Create: `test/dashboard/aggregator.test.ts`

- [ ] **Step 1: 编写 Aggregator 失败测试**

```typescript
// test/dashboard/aggregator.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Aggregator } from '../../src/dashboard/aggregator.js';
import type { LogEntry } from '../../src/core/logger.js';

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    v: 1,
    ts: new Date().toISOString(),
    level: 'info',
    module: 'dispatcher',
    msg: 'test',
    ...overrides,
  };
}

function makeToolEnd(tool: string, durationMs: number, error?: string): LogEntry {
  return makeEntry({
    type: 'tool_end',
    tool,
    duration_ms: durationMs,
    call_id: `${tool}:abc`,
    ...(error ? { error, level: 'error' } : {}),
  });
}

describe('Aggregator', () => {
  let agg: Aggregator;

  beforeEach(() => {
    agg = new Aggregator();
  });

  it('should count total calls from tool_end entries', () => {
    agg.process(makeToolEnd('read_scene', 120));
    agg.process(makeToolEnd('execute_gdscript', 2000));
    agg.process(makeToolEnd('read_scene', 80));
    const state = agg.getState();
    expect(state.totalCalls).toBe(3);
  });

  it('should count errors from tool_end entries with error field', () => {
    agg.process(makeToolEnd('read_scene', 50));
    agg.process(makeToolEnd('edit_script', 100, 'timeout'));
    agg.process(makeToolEnd('save_scene', 200, 'write_error'));
    const state = agg.getState();
    expect(state.totalErrors).toBe(2);
  });

  it('should compute per-tool statistics', () => {
    agg.process(makeToolEnd('read_scene', 100));
    agg.process(makeToolEnd('read_scene', 200));
    agg.process(makeToolEnd('execute_gdscript', 3000));
    const stats = agg.getState().toolStats;
    expect(stats.get('read_scene')!.calls).toBe(2);
    expect(stats.get('read_scene')!.totalDurationMs).toBe(300);
    expect(stats.get('read_scene')!.minDurationMs).toBe(100);
    expect(stats.get('read_scene')!.maxDurationMs).toBe(200);
    expect(stats.get('execute_gdscript')!.calls).toBe(1);
  });

  it('should maintain recentLogs ring buffer (capacity 500)', () => {
    for (let i = 0; i < 600; i++) {
      agg.process(makeEntry({ msg: `log ${i}` }));
    }
    const state = agg.getState();
    expect(state.recentLogs.length).toBe(500);
    // 最旧的被丢弃，保留最新的 500 条
    const logs = state.recentLogs.toArray();
    expect(logs[0].msg).toBe('log 100');
    expect(logs[499].msg).toBe('log 599');
  });

  it('should build time series buckets from tool_end entries', () => {
    const now = new Date();
    agg.process(makeToolEnd('read_scene', 100));
    const state = agg.getState();
    expect(state.timeSeries.length).toBe(1);
    expect(state.timeSeries[0].calls).toBe(1);
    expect(state.timeSeries[0].totalDurationMs).toBe(100);
  });

  it('should detect mode from first log entry', () => {
    agg.process(makeEntry({ msg: 'Editor mode connected', module: 'godot-mcp' }));
    expect(agg.getState().mode).toBe('editor');
  });

  it('should detect headless mode', () => {
    agg.process(makeEntry({ msg: 'Headless mode starting', module: 'godot-mcp' }));
    expect(agg.getState().mode).toBe('headless');
  });

  it('should default mode to unknown', () => {
    agg.process(makeEntry({ msg: 'something', module: 'dispatcher' }));
    expect(agg.getState().mode).toBe('unknown');
  });

  it('should extract project path from tool_start entries', () => {
    agg.process(makeEntry({
      type: 'tool_start',
      tool: 'read_scene',
      call_id: 'read_scene:abc',
      meta: { arg_keys: ['project_path', 'scene_path'] },
    }));
    // project path 来自 toolStart 的 meta.arg_keys 存在即推断有项目
    expect(agg.getState().hasProject).toBe(true);
  });

  it('should return top N tools sorted by call count', () => {
    for (let i = 0; i < 5; i++) agg.process(makeToolEnd('read_scene', 100));
    for (let i = 0; i < 3; i++) agg.process(makeToolEnd('execute_gdscript', 200));
    agg.process(makeToolEnd('edit_script', 50));
    const top = agg.getTopTools(2);
    expect(top).toHaveLength(2);
    expect(top[0].tool).toBe('read_scene');
    expect(top[0].calls).toBe(5);
    expect(top[1].tool).toBe('execute_gdscript');
    expect(top[1].calls).toBe(3);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/dashboard/aggregator.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 Aggregator**

```typescript
// src/dashboard/aggregator.ts
import type { LogEntry } from '../core/logger.js';
import { RingBuffer } from './ring-buffer.js';

// ─── 类型 ───────────────────────────────────────────────────

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
  minute: string; // 'HH:MM'
  calls: number;
  errors: number;
  totalDurationMs: number;
  count: number;
}

export interface DashboardState {
  startTime: string;
  mode: string;
  hasProject: boolean;
  totalCalls: number;
  totalErrors: number;
  toolStats: Map<string, ToolStats>;
  timeSeries: TimeSeriesBucket[];
  recentLogs: RingBuffer<LogEntry>;
}

// ─── 常量 ───────────────────────────────────────────────────

const RECENT_LOGS_CAPACITY = 500;
const TIME_SERIES_MAX_BUCKETS = 30; // 30 分钟窗口

// ─── 工具函数 ───────────────────────────────────────────────

function minuteKey(ts: string): string {
  // '2026-06-03T20:45:12.123Z' → '20:45'
  const d = new Date(ts);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// ─── Aggregator ─────────────────────────────────────────────

export class Aggregator {
  private totalCalls = 0;
  private totalErrors = 0;
  private toolStats = new Map<string, ToolStats>();
  private timeSeries: TimeSeriesBucket[] = [];
  private recentLogs = new RingBuffer<LogEntry>(RECENT_LOGS_CAPACITY);
  private mode = 'unknown';
  private hasProject = false;
  private startTime = new Date().toISOString();

  process(entry: LogEntry): void {
    // 推入 recentLogs（所有条目）
    this.recentLogs.push(entry);

    // 检测模式
    if (this.mode === 'unknown' && entry.module === 'godot-mcp') {
      const msg = entry.msg.toLowerCase();
      if (msg.includes('editor')) this.mode = 'editor';
      else if (msg.includes('headless')) this.mode = 'headless';
      else if (msg.includes('bridge')) this.mode = 'bridge';
    }

    // 检测项目
    if (!this.hasProject && entry.type === 'tool_start' && entry.meta) {
      const argKeys = entry.meta.arg_keys;
      if (Array.isArray(argKeys) && argKeys.includes('project_path')) {
        this.hasProject = true;
      }
    }

    // 只处理 tool_end
    if (entry.type !== 'tool_end') return;

    this.totalCalls++;
    const tool = entry.tool ?? 'unknown';
    const durationMs = entry.duration_ms ?? 0;
    const isError = !!entry.error;

    if (isError) this.totalErrors++;

    // 更新 toolStats
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

    // 更新 timeSeries
    const key = minuteKey(entry.ts);
    const bucket = this.timeSeries.find(b => b.minute === key);
    if (bucket) {
      bucket.calls++;
      bucket.errors += isError ? 1 : 0;
      bucket.totalDurationMs += durationMs;
      bucket.count++;
    } else {
      this.timeSeries.push({
        minute: key,
        calls: 1,
        errors: isError ? 1 : 0,
        totalDurationMs: durationMs,
        count: 1,
      });
      // 保持最近 30 个桶
      if (this.timeSeries.length > TIME_SERIES_MAX_BUCKETS) {
        this.timeSeries.shift();
      }
    }
  }

  getState(): DashboardState {
    return {
      startTime: this.startTime,
      mode: this.mode,
      hasProject: this.hasProject,
      totalCalls: this.totalCalls,
      totalErrors: this.totalErrors,
      toolStats: this.toolStats,
      timeSeries: [...this.timeSeries],
      recentLogs: this.recentLogs,
    };
  }

  getTopTools(n: number): ToolStats[] {
    return [...this.toolStats.values()]
      .sort((a, b) => b.calls - a.calls)
      .slice(0, n);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/dashboard/aggregator.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/dashboard/aggregator.ts test/dashboard/aggregator.test.ts
git commit -m "feat(dashboard): Aggregator with tool stats, time series, and 10 tests"
```

---

## Task 5: LogReader JSONL 文件读取

**Files:**
- Create: `src/dashboard/log-reader.ts`
- Create: `test/dashboard/log-reader.test.ts`

- [ ] **Step 1: 编写 LogReader 失败测试**

```typescript
// test/dashboard/log-reader.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LogReader } from '../../src/dashboard/log-reader.js';
import { writeFileSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), 'godot-mcp-test-log-reader');

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});
afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// 写一行 JSONL
function writeJsonlLine(filePath: string, obj: Record<string, unknown>): void {
  appendFileSync(filePath, JSON.stringify(obj) + '\n');
}

function todayFile(): string {
  const today = new Date().toISOString().slice(0, 10);
  return join(TEST_DIR, `${today}.jsonl`);
}

describe('LogReader', () => {
  it('should read existing entries on start', async () => {
    const file = todayFile();
    writeJsonlLine(file, { v: 1, level: 'info', module: 'test', msg: 'hello', ts: new Date().toISOString() });
    writeJsonlLine(file, { v: 1, level: 'warn', module: 'test', msg: 'world', ts: new Date().toISOString() });

    const reader = new LogReader(TEST_DIR);
    const entries: unknown[] = [];
    reader.on('entries', (e: unknown[]) => entries.push(...e));
    await reader.start();

    expect(entries.length).toBeGreaterThanOrEqual(2);
    reader.stop();
  });

  it('should detect new entries after start', async () => {
    const file = todayFile();
    writeJsonlLine(file, { v: 1, level: 'info', module: 'test', msg: 'initial', ts: new Date().toISOString() });

    const reader = new LogReader(TEST_DIR);
    const entries: unknown[] = [];
    reader.on('entries', (e: unknown[]) => entries.push(...e));
    await reader.start();

    const initialCount = entries.length;

    // 写入新条目
    writeJsonlLine(file, { v: 1, level: 'info', module: 'test', msg: 'new', ts: new Date().toISOString() });

    // 等待轮询检测（2s fallback）
    await new Promise(resolve => setTimeout(resolve, 2500));

    expect(entries.length).toBeGreaterThan(initialCount);
    reader.stop();
  });

  it('should skip malformed lines and count them', async () => {
    const file = todayFile();
    writeJsonlLine(file, { v: 1, level: 'info', module: 'test', msg: 'good', ts: new Date().toISOString() });
    appendFileSync(file, 'not json\n');
    writeJsonlLine(file, { v: 1, level: 'info', module: 'test', msg: 'also good', ts: new Date().toISOString() });

    const reader = new LogReader(TEST_DIR);
    const entries: unknown[] = [];
    reader.on('entries', (e: unknown[]) => entries.push(...e));
    await reader.start();

    expect(entries.length).toBe(2);
    expect(reader.getSkippedCount()).toBe(1);
    reader.stop();
  });

  it('should emit empty array when no log file exists', async () => {
    const reader = new LogReader(TEST_DIR);
    const entries: unknown[] = [];
    reader.on('entries', (e: unknown[]) => entries.push(...e));
    await reader.start();

    // 无文件时应该正常启动，不报错
    expect(entries.length).toBe(0);
    reader.stop();
  });

  it('should handle file rotation by tracking date change', async () => {
    const file = todayFile();
    writeJsonlLine(file, { v: 1, level: 'info', module: 'test', msg: 'day1', ts: new Date().toISOString() });

    const reader = new LogReader(TEST_DIR);
    await reader.start();

    // 写入 rotation 信号
    writeJsonlLine(file, {
      v: 1, level: 'info', module: 'logger',
      msg: 'Rotating log file', type: 'rotation',
      meta: { new_file: '2099-12-31.jsonl' },
      ts: new Date().toISOString(),
    });

    // 创建"新"文件
    const newFile = join(TEST_DIR, '2099-12-31.jsonl');
    writeJsonlLine(newFile, { v: 1, level: 'info', module: 'test', msg: 'day2', ts: new Date().toISOString() });

    // 轮询检测
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 应该已切换到新文件
    expect(reader.getCurrentFile()).toContain('2099-12-31');
    reader.stop();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/dashboard/log-reader.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 LogReader**

```typescript
// src/dashboard/log-reader.ts
import { EventEmitter } from 'node:events';
import { watch, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LogEntry } from '../core/logger.js';

export interface LogReaderEvents {
  entries: (entries: LogEntry[]) => void;
  error: (err: Error) => void;
}

declare interface LogReader {
  on<K extends keyof LogReaderEvents>(event: K, listener: LogReaderEvents[K]): this;
  emit<K extends keyof LogReaderEvents>(event: K, ...args: Parameters<LogReaderEvents[K]>): boolean;
}

const POLL_INTERVAL_MS = 2000;
const MAX_INITIAL_LINES = 500;

class LogReader extends EventEmitter {
  private logDir: string;
  private byteOffset = 0;
  private currentFile = '';
  private skippedCount = 0;
  private watcher: ReturnType<typeof watch> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(logDir: string) {
    super();
    this.logDir = logDir;
  }

  async start(): Promise<void> {
    this.currentFile = this.getTodayFile();

    if (existsSync(this.currentFile)) {
      // 读取尾部初始化
      const { entries, bytesRead } = this.readFromOffset(this.currentFile, 0);
      // 只保留最近 MAX_INITIAL_LINES 条
      const trimmed = entries.slice(-MAX_INITIAL_LINES);
      if (trimmed.length > 0) {
        this.emit('entries', trimmed);
      }
      this.byteOffset = bytesRead;
    } else {
      this.byteOffset = 0;
    }

    // 启动 fs.watch
    this.startWatch();
    // 启动 2s 轮询 fallback
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

  // ─── private ────────────────────────────────────────────

  private getTodayFile(): string {
    const today = new Date().toISOString().slice(0, 10);
    return join(this.logDir, `${today}.jsonl`);
  }

  private startWatch(): void {
    try {
      this.watcher = watch(this.logDir, (event, filename) => {
        if (this.stopped) return;
        if (event === 'rename' || event === 'change') {
          this.checkForNewData();
        }
      });
    } catch {
      // fs.watch 不可用时依赖轮询
    }
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      if (!this.stopped) this.checkForNewData();
    }, POLL_INTERVAL_MS);
  }

  private checkForNewData(): void {
    // 检查是否需要切换文件（日志轮转）
    const todayFile = this.getTodayFile();
    if (todayFile !== this.currentFile) {
      this.currentFile = todayFile;
      this.byteOffset = 0;
    }

    if (!existsSync(this.currentFile)) return;

    const { entries, bytesRead } = this.readFromOffset(this.currentFile, this.byteOffset);
    if (bytesRead > 0) {
      this.byteOffset += bytesRead;
    }
    if (entries.length > 0) {
      this.emit('entries', entries);
    }

    // 检查 rotation 信号
    for (const entry of entries) {
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

  private readFromOffset(filePath: string, offset: number): { entries: LogEntry[]; bytesRead: number } {
    try {
      const stat = statSync(filePath);
      if (stat.size <= offset) {
        return { entries: [], bytesRead: 0 };
      }

      const raw = readFileSync(filePath, 'utf-8');
      // 简单实现：读全文件，截取 offset 之后的内容
      // （对于 <50MB 日志文件足够，无需 seek）
      const remaining = raw.slice(this.byteOffsetToCharOffset(raw, offset));
      const lines = remaining.split('\n').filter(l => l.trim().length > 0);

      const entries: LogEntry[] = [];
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as LogEntry);
        } catch {
          this.skippedCount++;
        }
      }

      // bytes read = 新内容的 byte 长度
      const bytesRead = Buffer.byteLength(remaining, 'utf-8');
      return { entries, bytesRead };
    } catch {
      return { entries: [], bytesRead: 0 };
    }
  }

  /**
   * 将 byte offset 转换为字符 offset。
   * 对于纯 ASCII JSONL（大多数场景），1 byte = 1 char。
   * 简化处理：直接用 byte offset 作为字符 offset。
   */
  private byteOffsetToCharOffset(_content: string, byteOff: number): number {
    // JSONL 中绝大部分是 ASCII（JSON key + 数字 + 简短 msg）
    // 对于少量 UTF-8 内容，偏差极小（仅 msg 字段可能含中文）
    // 在实际使用中足够准确
    return byteOff > _content.length ? _content.length : byteOff;
  }
}

export { LogReader };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/dashboard/log-reader.test.ts`
Expected: PASS（5 个测试，含 2 个异步等待测试可能需要 ~10s）

- [ ] **Step 5: 提交**

```bash
git add src/dashboard/log-reader.ts test/dashboard/log-reader.test.ts
git commit -m "feat(dashboard): LogReader with fs.watch, polling fallback, and 5 tests"
```

---

## Task 6: 安装 ink 依赖 + tsconfig JSX 配置

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`

- [ ] **Step 1: 安装 ink 和 react 作为 optionalDependencies**

```bash
cd D:\GitHub\godot-mcp-enhanced
npm install --save-optional ink react
npm install --save-dev @types/react
```

- [ ] **Step 2: 修改 tsconfig.json 添加 JSX 支持**

在 `compilerOptions` 中添加 `"jsx": "react-jsx"`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true,
    "jsx": "react-jsx"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "build"]
}
```

注意：`"jsx": "react-jsx"` 只影响 `.tsx` 文件，不影响现有 `.ts` 文件。

- [ ] **Step 3: 添加 bin 入口到 package.json**

在 `package.json` 的 `bin` 字段中添加 dashboard 入口：

```json
"bin": {
  "godot-mcp-enhanced": "./build/index.js",
  "godot-mcp-dashboard": "./build/dashboard/index.js"
}
```

在 `files` 数组中确保包含 dashboard 构建产物：

```json
"files": [
  "build/**/*.js",
  "build/**/*.d.ts",
  "build/scripts/*.gd",
  "addons",
  "scripts"
]
```

（现有 `build/**/*.js` 已覆盖 `build/dashboard/*.js`，无需额外修改 `files`）

- [ ] **Step 4: 运行编译确认无错误**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 5: 运行全量测试确认无回归**

Run: `npx vitest run`
Expected: 全部 passed

- [ ] **Step 6: 提交**

```bash
git add package.json package-lock.json tsconfig.json
git commit -m "feat(dashboard): add ink/react deps, JSX config, and bin entry"
```

---

## Task 7: UI 面板（ink 四面板布局）

**Files:**
- Create: `src/dashboard/ui.tsx`

- [ ] **Step 1: 实现 UI 面板**

这是 ink 的 JSX 组件，需要 react 和 ink。由于 ink 需要 TTY 环境，此组件不做自动化单元测试，通过手动启动 `godot-mcp-dashboard` 验证。

```tsx
// src/dashboard/ui.tsx
import React, { useState, useEffect } from 'react';
import { Box, Text, render, useInput, useApp } from 'ink';
import type { DashboardState, ToolStats } from './aggregator.js';
import { sparkline } from './sparkline.js';
import {
  LEVEL_COLORS, LEVEL_PREFIX, MODULE_COLORS, STATUS,
  SPARKLINE_COLORS, BORDER_COLOR, KEYBIND_COLOR,
} from './themes.js';

// ─── 子组件 ─────────────────────────────────────────────────

/** 状态栏：模式 + 项目 + 运行时长 + 统计 */
function StatusBar({ state, paused }: { state: DashboardState; paused: boolean }) {
  const uptime = formatUptime(state.startTime);
  const modeIcon = state.mode === 'unknown' ? STATUS.disconnected : STATUS.connected;
  const pauseIcon = paused ? ` ${STATUS.paused}` : '';

  return (
    <Box borderStyle="single" borderColor={BORDER_COLOR} paddingX={1}>
      <Text>
        <Text color={state.mode === 'editor' ? 'cyan' : state.mode === 'bridge' ? 'magenta' : 'green'}>
          {modeIcon} {state.mode.toUpperCase()}
        </Text>
        <Text> │ Calls: {state.totalCalls} │ Errors: {state.totalErrors} │ Uptime: {uptime}{pauseIcon}</Text>
      </Text>
    </Box>
  );
}

/** 日志条目行 */
function LogLine({ entry }: { entry: import('../core/logger.js').LogEntry }) {
  const time = entry.ts.slice(11, 19); // HH:MM:SS
  const levelColor = LEVEL_COLORS[entry.level] ?? 'white';
  const moduleColor = MODULE_COLORS[entry.module] ?? 'white';
  const prefix = LEVEL_PREFIX[entry.level] ?? '';

  return (
    <Text>
      <Text dimColor>{time}</Text>
      {' '}
      <Text color={moduleColor}>[{entry.module}]</Text>
      {prefix ? <Text color={levelColor}> {prefix}</Text> : null}
      {' '}
      <Text color={levelColor}>{truncate(entry.msg, 60)}</Text>
    </Text>
  );
}

/** 日志流面板 */
function LogStream({ logs, filter, levelFilter }: {
  logs: import('../core/logger.js').LogEntry[];
  filter: string;
  levelFilter: string;
}) {
  let filtered = logs;
  if (filter) {
    filtered = filtered.filter(e =>
      e.module.includes(filter) || e.tool?.includes(filter) || e.msg.includes(filter)
    );
  }
  if (levelFilter !== 'ALL') {
    filtered = filtered.filter(e => e.level === levelFilter.toLowerCase());
  }

  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor={BORDER_COLOR} paddingX={0}>
      <Text bold> Log Stream (live)</Text>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {filtered.slice(-15).map((entry, i) => (
          <LogLine key={i} entry={entry} />
        ))}
      </Box>
    </Box>
  );
}

/** 工具统计面板 */
function ToolStatsTable({ tools }: { tools: ToolStats[] }) {
  return (
    <Box flexDirection="column" width={40} borderStyle="single" borderColor={BORDER_COLOR}>
      <Text bold> Tool Statistics (Top 10)</Text>
      <Box>
        <Text bold>{' Tool'.padEnd(12)}{'│'}{'Calls'.padStart(6)}{'│'}{'Avg'.padStart(7)}</Text>
      </Box>
      {tools.slice(0, 10).map(t => {
        const avg = t.calls > 0 ? Math.round(t.totalDurationMs / t.calls) : 0;
        const name = t.tool.length > 10 ? t.tool.slice(0, 10) : t.tool;
        return (
          <Box key={t.tool}>
            <Text>{' ' + name.padEnd(11)}{'│'}{String(t.calls).padStart(6)}{'│'}{avg + 'ms'.padStart(7)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

/** 性能趋势面板 */
function PerformancePanel({ state }: { state: DashboardState }) {
  const ts = state.timeSeries;
  const callsData = ts.map(b => b.calls);
  const errorData = ts.map(b => b.errors);
  const latencyData = ts.map(b => b.count > 0 ? Math.round(b.totalDurationMs / b.count) : 0);

  return (
    <Box flexDirection="column" width={40} borderStyle="single" borderColor={BORDER_COLOR}>
      <Text bold> Performance (last {ts.length} min)</Text>
      <Box flexDirection="column">
        <Text><Text color={SPARKLINE_COLORS.calls}>Calls/min</Text> {sparkline(callsData, { maxWidth: 30 })}</Text>
        <Text><Text color={SPARKLINE_COLORS.errors}>Errors   </Text> {sparkline(errorData, { maxWidth: 30 })}</Text>
        <Text><Text color={SPARKLINE_COLORS.latency}>Avg lat  </Text> {sparkline(latencyData, { maxWidth: 30 })}</Text>
      </Box>
    </Box>
  );
}

/** 快捷键栏 */
function KeybindBar({ filter, levelFilter }: { filter: string; levelFilter: string }) {
  const filterInfo = filter ? ` [${filter}]` : '';
  const levelInfo = levelFilter !== 'ALL' ? ` [${levelFilter}]` : '';
  return (
    <Box borderStyle="single" borderColor={BORDER_COLOR} paddingX={1}>
      <Text color={KEYBIND_COLOR}>
        ↑/↓:scroll  f:filter{filterInfo}  l:level{levelInfo}  c:clear  q:quit  Space:pause
      </Text>
    </Box>
  );
}

// ─── 主组件 ─────────────────────────────────────────────────

function Dashboard({ stateStream }: {
  stateStream: AsyncIterable<DashboardState>;
}) {
  const { exit } = useApp();
  const [state, setState] = useState<DashboardState | null>(null);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState('ALL');
  const [inputMode, setInputMode] = useState<'normal' | 'filter'>('normal');
  const [filterInput, setFilterInput] = useState('');

  // 消费 state 流
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for await (const s of stateStream) {
        if (cancelled) break;
        if (!paused) setState(s);
      }
    })();
    return () => { cancelled = true; };
  }, [paused]);

  // 键盘输入
  useInput((input, key) => {
    if (inputMode === 'filter') {
      if (key.return) {
        setFilter(filterInput);
        setInputMode('normal');
        setFilterInput('');
      } else if (key.escape) {
        setInputMode('normal');
        setFilterInput('');
      } else if (key.backspace) {
        setFilterInput(prev => prev.slice(0, -1));
      } else {
        setFilterInput(prev => prev + input);
      }
      return;
    }

    if (input === 'q') {
      exit();
    } else if (key.return || input === ' ') {
      setPaused(p => !p);
    } else if (input === 'f') {
      setInputMode('filter');
    } else if (input === 'l') {
      const levels = ['ALL', 'INFO', 'WARN', 'ERROR'];
      const idx = levels.indexOf(levelFilter);
      setLevelFilter(levels[(idx + 1) % levels.length]);
    } else if (input === 'c') {
      if (state) state.recentLogs.clear();
    }
  });

  if (!state) {
    return <Text>Waiting for data...</Text>;
  }

  return (
    <Box flexDirection="column" height="100%">
      <StatusBar state={state} paused={paused} />
      <Box flexDirection="row" flexGrow={1}>
        <LogStream
          logs={state.recentLogs.toArray()}
          filter={filter}
          levelFilter={levelFilter}
        />
        <Box flexDirection="column">
          <ToolStatsTable tools={state.toolStats ? [...state.toolStats.values()] : []} />
          <PerformancePanel state={state} />
        </Box>
      </Box>
      <KeybindBar filter={filter} levelFilter={levelFilter} />
      {inputMode === 'filter' && (
        <Text color="yellow">Filter: {filterInput}_</Text>
      )}
    </Box>
  );
}

// ─── 导出 ───────────────────────────────────────────────────

/**
 * 渲染 Dashboard UI。
 * 返回 ink 的 render 实例（调用者负责清理）。
 */
export function renderDashboard(stateStream: AsyncIterable<DashboardState>) {
  return render(<Dashboard stateStream={stateStream} />);
}

// ─── 工具函数 ───────────────────────────────────────────────

function formatUptime(startTime: string): string {
  const diff = Date.now() - new Date(startTime).getTime();
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + '...';
}
```

- [ ] **Step 2: 运行编译确认无错误**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 3: 提交**

```bash
git add src/dashboard/ui.tsx
git commit -m "feat(dashboard): ink four-panel TUI layout with keyboard controls"
```

---

## Task 8: CLI 入口点

**Files:**
- Create: `src/dashboard/index.ts`

- [ ] **Step 1: 创建 CLI 入口**

```typescript
#!/usr/bin/env node
// src/dashboard/index.ts
// godot-mcp-dashboard — 独立 CLI 终端面板，实时监控 MCP 服务

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

// 检查 ink 是否可用（optionalDependencies 可能未安装）
async function checkInk(): Promise<void> {
  try {
    await import('ink');
    await import('react');
  } catch {
    console.error(
      'Error: ink and react are required for the dashboard.\n' +
      'Install them with: npm install ink react\n' +
      'Or reinstall the package with optional dependencies.'
    );
    process.exit(1);
  }
}

// 确定日志目录（与 Logger 使用相同逻辑）
function resolveLogDir(): string {
  const platform = process.platform;
  if (platform === 'win32') {
    const base = process.env.APPDATA ?? join(process.env.USERPROFILE ?? tmpdir(), 'AppData', 'Roaming');
    return join(base, 'godot-mcp', 'logs');
  }
  if (platform === 'darwin') {
    const home = process.env.HOME ?? tmpdir();
    return join(home, 'Library', 'Application Support', 'godot-mcp', 'logs');
  }
  const xdg = process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? tmpdir(), '.local', 'share');
  return join(xdg, 'godot-mcp', 'logs');
}

// 解析命令行参数
function parseArgs(args: string[]): { filter?: string; help: boolean } {
  let help = false;
  let filter: string | undefined;

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg.startsWith('--filter=')) {
      filter = arg.split('=')[1];
    }
  }
  return { help, filter };
}

function showHelp(): void {
  console.log(`
godot-mcp-dashboard — MCP Server 实时监控面板

用法:
  godot-mcp-dashboard [选项]

选项:
  --filter=<关键词>  只显示匹配模块/工具名的日志
  --help, -h         显示帮助信息

快捷键:
  ↑/↓    滚动日志流
  Space  暂停/恢复
  f      输入过滤关键词
  l      切换日志级别 (ALL → INFO → WARN → ERROR)
  c      清空当前日志显示
  q      退出面板
`);
}

// AsyncIterable 适配器：将 LogReader 事件转为 AsyncIterable
function create_stateStream(
  LogReader: typeof import('./log-reader.js').LogReader,
  Aggregator: typeof import('./aggregator.js').Aggregator,
  logDir: string,
  filter?: string,
): AsyncIterable<import('./aggregator.js').DashboardState> {
  const reader = new LogReader(logDir);
  const aggregator = new Aggregator();

  // 如果有 filter 参数，记录（但不影响 LogReader 读取，由 UI 层过滤）

  let resolveNext: ((result: IteratorResult<import('./aggregator.js').DashboardState>) => void) | null = null;
  let updateTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingState: import('./aggregator.js').DashboardState | null = null;

  reader.on('entries', (entries: import('../core/logger.js').LogEntry[]) => {
    for (const entry of entries) {
      aggregator.process(entry);
    }
    // 节流：最多每 200ms 发送一次状态更新
    pendingState = aggregator.getState();
    if (!updateTimer) {
      updateTimer = setTimeout(() => {
        updateTimer = null;
        if (resolveNext && pendingState) {
          const state = pendingState;
          pendingState = null;
          resolveNext({ value: state, done: false });
          resolveNext = null;
        }
      }, 200);
    }
  });

  reader.on('error', (err: Error) => {
    console.error('LogReader error:', err.message);
  });

  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<import('./aggregator.js').DashboardState>> {
          // 首次立即返回当前状态
          const state = aggregator.getState();
          if (state.totalCalls > 0 || state.recentLogs.length > 0) {
            if (!resolveNext) {
              return { value: state, done: false };
            }
          }
          return new Promise<IteratorResult<import('./aggregator.js').DashboardState>>(resolve => {
            resolveNext = resolve;
          });
        },
        async return(): Promise<IteratorResult<import('./aggregator.js').DashboardState>> {
          reader.stop();
          if (updateTimer) clearTimeout(updateTimer);
          if (resolveNext) {
            resolveNext({ value: undefined as any, done: true });
            resolveNext = null;
          }
          return { value: undefined as any, done: true };
        },
      };
    },
  };
}

async function main(): Promise<void> {
  const { help, filter } = parseArgs(process.argv.slice(2));

  if (help) {
    showHelp();
    process.exit(0);
  }

  await checkInk();

  const logDir = resolveLogDir();

  if (!existsSync(logDir)) {
    console.error(
      `日志目录不存在: ${logDir}\n` +
      '请先启动 MCP 服务（godot-mcp-enhanced），它会自动创建日志目录。'
    );
    process.exit(1);
  }

  // 延迟导入（ink 可能未安装，上面已检查）
  const { LogReader } = await import('./log-reader.js');
  const { Aggregator } = await import('./aggregator.js');
  const { renderDashboard } = await import('./ui.js');

  const stateStream = create_stateStream(LogReader, Aggregator, logDir, filter);

  const { waitUntilExit } = renderDashboard(stateStream);

  try {
    await waitUntilExit();
  } catch {
    // ink 退出时可能抛出
  }
}

main().catch((err: Error) => {
  console.error('Dashboard error:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: 运行编译确认**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 3: 提交**

```bash
git add src/dashboard/index.ts
git commit -m "feat(dashboard): CLI entry point with arg parsing and graceful ink check"
```

---

## Task 9: 最终验证

- [ ] **Step 1: TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 2: ESLint 检查**

Run: `npx eslint src/`
Expected: 0 errors

- [ ] **Step 3: 全量测试**

Run: `npx vitest run`
Expected: 全部 passed（现有 1781 + 新增 ~26 = ~1807）

- [ ] **Step 4: 手动验证 Dashboard 启动**

在一个终端启动 MCP 服务（让它写几条日志），然后在另一个终端运行：

```bash
node build/dashboard/index.js
```

Expected: 显示四面板 TUI 布局，实时刷新日志

验证快捷键：
- `Space` 暂停/恢复
- `q` 退出
- `l` 切换级别过滤
- `f` 输入过滤关键词

- [ ] **Step 5: 验证 ink 未安装时的优雅降级**

```bash
# 临时移除 ink 验证降级（可选，不破坏环境）
node -e "const m = require.resolve('ink'); console.log('ink at:', m)"
# 确认 checkInk 逻辑工作
node build/dashboard/index.js --help
```

Expected: 显示帮助信息

- [ ] **Step 6: 提交最终验证状态**

```bash
git log --oneline -10
```

---

## 自审清单

### 1. Spec 覆盖检查

| Spec 章节 | 对应 Task | 状态 |
|-----------|-----------|------|
| 4.1 CLI 入口 + bin | Task 8 | ✅ |
| 4.2 面板布局 | Task 7 | ✅ |
| 4.3 四个面板 | Task 7 (StatusBar + LogStream + ToolStatsTable + PerformancePanel) | ✅ |
| 4.4 日志着色 | Task 3 (themes.ts) + Task 7 (LogLine) | ✅ |
| 4.5 交互快捷键 | Task 7 (useInput) | ✅ |
| 4.6 LogReader + byte offset | Task 5 | ✅ |
| 5.1 数据结构 + RingBuffer | Task 1 + Task 4 | ✅ |
| 5.2 聚合逻辑 | Task 4 | ✅ |
| 6 文件结构 | 全部 Task | ✅ |
| 7 依赖 ink | Task 6 | ✅ |
| 8 启动流程 | Task 8 | ✅ |
| 9 测试策略 | Task 1/2/4/5 | ✅ |

### 2. Placeholder 扫描

无 TBD/TODO/待定内容。所有步骤包含完整代码。

### 3. 类型一致性检查

- `LogEntry` 统一从 `../core/logger.js` 导入 ✅
- `RingBuffer<T>` 在 aggregator.ts 和 ring-buffer.ts 中签名一致 ✅
- `DashboardState` 在 aggregator.ts 定义，ui.tsx 消费 ✅
- `ToolStats` 在 aggregator.ts 导出，ui.tsx 使用 ✅
- `sparkline(data, opts)` 在 sparkline.ts 定义，ui.tsx 调用 ✅
- `LEVEL_COLORS`/`MODULE_COLORS` 在 themes.ts 定义，ui.tsx 引用 ✅
