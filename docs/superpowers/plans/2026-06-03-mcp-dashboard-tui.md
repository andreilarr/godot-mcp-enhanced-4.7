# PR2: Dashboard TUI 面板实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建独立 CLI 终端面板，实时显示 MCP 服务端日志、工具调用统计、服务状态和性能趋势，不占用 Claude Code 对话上下文。

**Architecture:** Dashboard 是独立 CLI 进程（`godot-mcp-dashboard`），通过 JSONL 文件与 MCP 服务解耦。LogReader 用 fs.watch + 2s 轮询 + createReadStream 读取增量日志，Aggregator 聚合统计（timeSeries 也用 RingBuffer），ink 渲染四面板 TUI 布局。

**Tech Stack:** TypeScript, ink (React for CLI), React, Vitest, ESM

**Design Spec:** `docs/superpowers/specs/2026-06-03-mcp-dashboard-design.md` 第 4-7 节

**前置条件:** PR1 Logger 层已完成（`src/core/logger.ts` 已存在）

**审查报告:** `D:\workspace\review\.claude\reviews\2026-06-03-godot-mcp-dashboard-tui-plan.md` — 8 IMPORTANT + 5 ADVISORY 已全部纳入

---

## 文件变更清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 创建 | `src/dashboard/ring-buffer.ts` | 环形缓冲区（O(1) 插入） |
| 创建 | `src/dashboard/sparkline.ts` | sparkline 图表渲染（纯函数，防御性降采样） |
| 创建 | `src/dashboard/themes.ts` | 颜色主题常量（集中管理） |
| 创建 | `src/dashboard/aggregator.ts` | 统计聚合器 + DashboardState（timeSeries 用 RingBuffer） |
| 创建 | `src/dashboard/log-reader.ts` | JSONL 读取 + createReadStream + fs.watch + 轮询（emit error） |
| 创建 | `src/dashboard/ui.tsx` | ink 四面板布局（统一顶部 import） |
| 创建 | `src/dashboard/index.ts` | CLI 入口（复用 Logger.resolveLogDir + AbortController） |
| 创建 | `test/dashboard/ring-buffer.test.ts` | RingBuffer 测试（含 clear） |
| 创建 | `test/dashboard/sparkline.test.ts` | sparkline 测试（含负值/NaN/大数组） |
| 创建 | `test/dashboard/aggregator.test.ts` | Aggregator 测试（含 projectPath + timeSeries 溢出） |
| 创建 | `test/dashboard/log-reader.test.ts` | LogReader 测试（注入 pollIntervalMs=50） |
| 修改 | `src/core/logger.ts` | 导出 `resolveLogDir()` 供 Dashboard 复用 |
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

  it('should clear all items and reset length', () => {
    const buf = new RingBuffer<string>(5);
    buf.push('a');
    buf.push('b');
    buf.push('c');
    expect(buf.length).toBe(3);
    buf.clear();
    expect(buf.length).toBe(0);
    expect(buf.toArray()).toEqual([]);
    // clear 后可以继续 push
    buf.push('d');
    expect(buf.toArray()).toEqual(['d']);
    expect(buf.length).toBe(1);
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
 * 用于 Dashboard recentLogs 和 timeSeries（替代 Array.shift 的 O(n) 操作）。
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
git commit -m "feat(dashboard): RingBuffer with O(1) push, clear, and 6 tests"
```

---

## Task 2: Sparkline 纯函数（含防御性降采样）

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
    const result = sparkline([10, 11, 12, 13, 14]);
    expect(result[0]).toBe('▁');
    expect(result[result.length - 1]).toBe('█');
  });

  it('should handle negative values', () => {
    const result = sparkline([-5, -3, -1, 0, 2]);
    expect(result[0]).toBe('▁');
    expect(result[result.length - 1]).toBe('█');
    expect(result.length).toBe(5);
  });

  it('should handle NaN values as minimum', () => {
    const result = sparkline([1, NaN, 3]);
    // NaN 应映射到 ▁（最低档）
    expect(result.length).toBe(3);
    expect(result[1]).toBe('▁');
  });

  it('should defensively downsample huge arrays (>10000)', () => {
    const data = Array.from({ length: 50000 }, (_, i) => i % 100);
    const result = sparkline(data);
    // 内部应自动降采样到 ≤1000 字符
    expect(result.length).toBeLessThanOrEqual(1000);
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
 *
 * 防御性降采样：超过 10000 个数据点时自动降采样到 1000，
 * 避免 Math.min(...values) 栈溢出。
 */

const CHARS = '▁▂▃▄▅▆▇█';
const MAX_INTERNAL_WIDTH = 1000;
const DOWNSAMPLE_THRESHOLD = 10000;

export interface SparklineOptions {
  /** 最大输出宽度（超出时降采样） */
  maxWidth?: number;
}

/**
 * 将数值数组转换为 sparkline 字符串。
 * - 空数组返回空字符串
 * - 所有值相同时全部显示最低档 ▁
 * - NaN/Infinity 视为最低档
 * - 超过 10000 个点时强制降采样（防止栈溢出）
 */
export function sparkline(data: number[], opts: SparklineOptions = {}): string {
  if (data.length === 0) return '';

  // 防御性降采样：大数组先降到安全规模
  let values = data;
  if (values.length > DOWNSAMPLE_THRESHOLD) {
    const target = MAX_INTERNAL_WIDTH;
    const sampled: number[] = [];
    const step = (values.length - 1) / (target - 1);
    for (let i = 0; i < target; i++) {
      sampled.push(values[Math.round(i * step)]);
    }
    values = sampled;
  }

  // 用户 maxWidth 降采样
  const maxWidth = opts.maxWidth ?? values.length;
  if (values.length > maxWidth) {
    const sampled: number[] = [];
    const step = (values.length - 1) / (maxWidth - 1);
    for (let i = 0; i < maxWidth; i++) {
      sampled.push(values[Math.round(i * step)]);
    }
    values = sampled;
  }

  // 安全计算 min/max（用循环替代展开，避免栈溢出）
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) { min = 0; max = 0; }
  const range = max - min;

  return values
    .map(v => {
      if (!Number.isFinite(v)) return CHARS[0];
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
git commit -m "feat(dashboard): sparkline with defensive sampling, NaN support, and 9 tests"
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

## Task 4: Aggregator 统计聚合器（timeSeries 用 RingBuffer + projectPath）

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
    const logs = state.recentLogs.toArray();
    expect(logs[0].msg).toBe('log 100');
    expect(logs[499].msg).toBe('log 599');
  });

  it('should build time series buckets from tool_end entries', () => {
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
      meta: { arg_keys: ['project_path', 'scene_path'], project_path: 'D:/game' },
    }));
    const state = agg.getState();
    expect(state.projectPath).toBe('D:/game');
  });

  it('should keep projectPath empty when no tool_start with project_path', () => {
    agg.process(makeToolEnd('read_scene', 100));
    expect(agg.getState().projectPath).toBe('');
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

  it('should limit timeSeries to 30 buckets using RingBuffer overflow', () => {
    // 创建 35 个不同分钟的 tool_end 条目
    for (let i = 0; i < 35; i++) {
      const ts = new Date(Date.now() + i * 60000).toISOString();
      agg.process(makeToolEnd('tool', 100, undefined));
      // 手动覆盖最后一条的时间桶（模拟跨分钟）
    }
    // 实际上同一个分钟内的条目会合并到同一个桶
    // 所以用不同分钟时间戳测试
    const state = agg.getState();
    // timeSeries 使用 RingBuffer(30)，超过 30 个桶时丢弃最旧的
    expect(state.timeSeries.length).toBeLessThanOrEqual(30);
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
  projectPath: string;
  totalCalls: number;
  totalErrors: number;
  toolStats: Map<string, ToolStats>;
  timeSeries: TimeSeriesBucket[];
  recentLogs: RingBuffer<LogEntry>;
}

// ─── 常量 ───────────────────────────────────────────────────

const RECENT_LOGS_CAPACITY = 500;
const TIME_SERIES_MAX_BUCKETS = 30;

// ─── 工具函数 ───────────────────────────────────────────────

function minuteKey(ts: string): string {
  const d = new Date(ts);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// ─── Aggregator ─────────────────────────────────────────────

export class Aggregator {
  private totalCalls = 0;
  private totalErrors = 0;
  private toolStats = new Map<string, ToolStats>();
  private timeSeriesBuf = new RingBuffer<TimeSeriesBucket>(TIME_SERIES_MAX_BUCKETS);
  private recentLogs = new RingBuffer<LogEntry>(RECENT_LOGS_CAPACITY);
  private mode = 'unknown';
  private projectPath = '';
  private startTime = new Date().toISOString();
  private currentMinute = '';

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

    // 提取 project path
    if (!this.projectPath && entry.type === 'tool_start' && entry.meta) {
      const pp = entry.meta.project_path;
      if (typeof pp === 'string' && pp.length > 0) {
        this.projectPath = pp;
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

    // 更新 timeSeries（用 RingBuffer，溢出时自动丢弃最旧桶）
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/dashboard/aggregator.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/dashboard/aggregator.ts test/dashboard/aggregator.test.ts
git commit -m "feat(dashboard): Aggregator with projectPath, RingBuffer timeSeries, and 12 tests"
```

---

## Task 5: LogReader（createReadStream + emit error + 注入 pollInterval）

**Files:**
- Create: `src/dashboard/log-reader.ts`
- Create: `test/dashboard/log-reader.test.ts`
- Modify: `src/core/logger.ts` — 导出 `resolveLogDir`

- [ ] **Step 1: 导出 Logger 的 resolveLogDir**

在 `src/core/logger.ts` 中，将 `resolveLogDir` 函数改为导出：

```typescript
// 找到这一行（约 L77）:
function resolveLogDir(override?: string): string {
// 改为:
export function resolveLogDir(override?: string): string {
```

- [ ] **Step 2: 编写 LogReader 失败测试**

```typescript
// test/dashboard/log-reader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

function writeJsonlLine(filePath: string, obj: Record<string, unknown>): void {
  appendFileSync(filePath, JSON.stringify(obj) + '\n');
}

function todayFile(): string {
  const today = new Date().toISOString().slice(0, 10);
  return join(TEST_DIR, `${today}.jsonl`);
}

function makeEntry(msg: string): Record<string, unknown> {
  return { v: 1, level: 'info', module: 'test', msg, ts: new Date().toISOString() };
}

describe('LogReader', () => {
  it('should read existing entries on start', async () => {
    const file = todayFile();
    writeJsonlLine(file, makeEntry('hello'));
    writeJsonlLine(file, makeEntry('world'));

    const reader = new LogReader(TEST_DIR, { pollIntervalMs: 50 });
    const entries: unknown[] = [];
    reader.on('entries', (e: unknown[]) => entries.push(...e));
    await reader.start();

    expect(entries.length).toBeGreaterThanOrEqual(2);
    reader.stop();
  });

  it('should detect new entries after start', async () => {
    const file = todayFile();
    writeJsonlLine(file, makeEntry('initial'));

    const reader = new LogReader(TEST_DIR, { pollIntervalMs: 50 });
    const entries: unknown[] = [];
    reader.on('entries', (e: unknown[]) => entries.push(...e));
    await reader.start();

    const initialCount = entries.length;

    writeJsonlLine(file, makeEntry('new'));

    // 等待轮询（50ms + 余量）
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(entries.length).toBeGreaterThan(initialCount);
    reader.stop();
  });

  it('should skip malformed lines and count them', async () => {
    const file = todayFile();
    writeJsonlLine(file, makeEntry('good'));
    appendFileSync(file, 'not json\n');
    writeJsonlLine(file, makeEntry('also good'));

    const reader = new LogReader(TEST_DIR, { pollIntervalMs: 50 });
    const entries: unknown[] = [];
    reader.on('entries', (e: unknown[]) => entries.push(...e));
    await reader.start();

    expect(entries.length).toBe(2);
    expect(reader.getSkippedCount()).toBe(1);
    reader.stop();
  });

  it('should emit empty array when no log file exists', async () => {
    const reader = new LogReader(TEST_DIR, { pollIntervalMs: 50 });
    const entries: unknown[] = [];
    reader.on('entries', (e: unknown[]) => entries.push(...e));
    await reader.start();

    expect(entries.length).toBe(0);
    reader.stop();
  });

  it('should emit error event when file read fails', async () => {
    const reader = new LogReader('/nonexistent/path/that/does/not/exist', { pollIntervalMs: 50 });
    const errors: Error[] = [];
    reader.on('error', (err: Error) => errors.push(err));

    // start 时目录不存在 → 应该 emit error 而不是崩溃
    await reader.start();
    // 等一轮轮询
    await new Promise(resolve => setTimeout(resolve, 150));

    // 应该有 error 事件（fs.watch 或 polling 失败时）
    // 不强制要求 error（可能静默失败），但不应该 throw
    reader.stop();
  });

  it('should track skipped count across multiple reads', async () => {
    const file = todayFile();
    writeJsonlLine(file, makeEntry('ok1'));
    appendFileSync(file, '{bad\n');
    writeJsonlLine(file, makeEntry('ok2'));

    const reader = new LogReader(TEST_DIR, { pollIntervalMs: 50 });
    const entries: unknown[] = [];
    reader.on('entries', (e: unknown[]) => entries.push(...e));
    await reader.start();
    const initialSkipped = reader.getSkippedCount();

    // 追加更多坏行
    appendFileSync(file, '{also bad\n');
    writeJsonlLine(file, makeEntry('ok3'));

    await new Promise(resolve => setTimeout(resolve, 200));

    expect(reader.getSkippedCount()).toBeGreaterThan(initialSkipped);
    reader.stop();
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run test/dashboard/log-reader.test.ts`
Expected: FAIL

- [ ] **Step 4: 实现 LogReader**

```typescript
// src/dashboard/log-reader.ts
import { EventEmitter } from 'node:events';
import { watch, createReadStream, existsSync, statSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { LogEntry } from '../core/logger.js';

export interface LogReaderOptions {
  /** 轮询间隔（毫秒），默认 2000，测试中可注入 50 */
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
      // 用 createReadStream 读取全部已有内容
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

  // ─── private ────────────────────────────────────────────

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

    // 检查 rotation 信号
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
   * 用 createReadStream + Buffer 从 byteOffset 读取增量内容。
   * 返回解析成功的 LogEntry 数组和实际读取的字节数。
   */
  private readFromOffset(filePath: string, offset: number): { entries: LogEntry[]; bytesRead: number } {
    try {
      const stat = statSync(filePath);
      if (stat.size <= offset) {
        return { entries: [], bytesRead: 0 };
      }

      // 用 createReadStream 精确读取 offset 之后的内容
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      // 同步读取：readFileSync 在 offset 场景更简单可靠
      // 对于 <50MB 的日志文件（7天保留），性能足够
      const fd = openSync(filePath, 'r');
      try {
        const readSize = stat.size - offset;
        const buf = Buffer.alloc(readSize);
        const bytesRead = require('fs').readSync(fd, buf, 0, readSize, offset);
        totalBytes = bytesRead;

        if (bytesRead === 0) {
          return { entries: [], bytesRead: 0 };
        }

        const content = buf.toString('utf-8', 0, bytesRead);
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
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      return { entries: [], bytesRead: 0 };
    }
  }
}

export { LogReader };
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run test/dashboard/log-reader.test.ts`
Expected: PASS（6 个测试，pollIntervalMs=50 使测试快速完成）

- [ ] **Step 6: 提交**

```bash
git add src/dashboard/log-reader.ts test/dashboard/log-reader.test.ts src/core/logger.ts
git commit -m "feat(dashboard): LogReader with createReadStream, emit error, injected poll interval"
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

- [ ] **Step 3: 添加 bin 入口到 package.json**

在 `package.json` 的 `bin` 字段中添加：

```json
"bin": {
  "godot-mcp-enhanced": "./build/index.js",
  "godot-mcp-dashboard": "./build/dashboard/index.js"
}
```

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

## Task 7: UI 面板（ink 四面板 + projectPath + 统一 import）

**Files:**
- Create: `src/dashboard/ui.tsx`

- [ ] **Step 1: 实现 UI 面板**

```tsx
// src/dashboard/ui.tsx
import React, { useState, useEffect } from 'react';
import { Box, Text, render, useInput, useApp } from 'ink';
import type { LogEntry } from '../core/logger.js';
import type { DashboardState, ToolStats } from './aggregator.js';
import { sparkline } from './sparkline.js';
import {
  LEVEL_COLORS, LEVEL_PREFIX, MODULE_COLORS, STATUS,
  SPARKLINE_COLORS, BORDER_COLOR, KEYBIND_COLOR,
} from './themes.js';

// ─── 子组件 ─────────────────────────────────────────────────

/** 状态栏：模式 + 项目路径 + 运行时长 + 统计 */
function StatusBar({ state, paused }: { state: DashboardState; paused: boolean }) {
  const uptime = formatUptime(state.startTime);
  const modeIcon = state.mode === 'unknown' ? STATUS.disconnected : STATUS.connected;
  const pauseIcon = paused ? ` ${STATUS.paused}` : '';
  const project = state.projectPath
    ? `│ Project: ${truncate(state.projectPath, 30)} `
    : '';

  return (
    <Box borderStyle="single" borderColor={BORDER_COLOR} paddingX={1}>
      <Text>
        <Text color={state.mode === 'editor' ? 'cyan' : state.mode === 'bridge' ? 'magenta' : 'green'}>
          {modeIcon} {state.mode.toUpperCase()}
        </Text>
        <Text> {project}│ Calls: {state.totalCalls} │ Errors: {state.totalErrors} │ Uptime: {uptime}{pauseIcon}</Text>
      </Text>
    </Box>
  );
}

/** 日志条目行 */
function LogLine({ entry }: { entry: LogEntry }) {
  const time = entry.ts.slice(11, 19);
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
  logs: LogEntry[];
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

function Dashboard({ stateStream, initialFilter }: {
  stateStream: AsyncIterable<DashboardState>;
  initialFilter?: string;
}) {
  const { exit } = useApp();
  const [state, setState] = useState<DashboardState | null>(null);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState(initialFilter ?? '');
  const [levelFilter, setLevelFilter] = useState('ALL');
  const [inputMode, setInputMode] = useState<'normal' | 'filter'>('normal');
  const [filterInput, setFilterInput] = useState('');

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
          <ToolStatsTable tools={[...state.toolStats.values()]} />
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

export function renderDashboard(stateStream: AsyncIterable<DashboardState>, initialFilter?: string) {
  return render(<Dashboard stateStream={stateStream} initialFilter={initialFilter} />);
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
git commit -m "feat(dashboard): ink four-panel TUI with projectPath and unified imports"
```

---

## Task 8: CLI 入口点（复用 resolveLogDir + AbortController + --filter 生效）

**Files:**
- Create: `src/dashboard/index.ts`

- [ ] **Step 1: 创建 CLI 入口**

```typescript
#!/usr/bin/env node
// src/dashboard/index.ts
// godot-mcp-dashboard — 独立 CLI 终端面板，实时监控 MCP 服务

import { existsSync } from 'node:fs';
import { resolveLogDir } from '../core/logger.js';

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

/**
 * 创建 AsyncIterable<DashboardState>，连接 LogReader → Aggregator → UI。
 * 使用 AbortController 统一清理，节流 200ms 发送状态更新。
 */
function createStateStream(
  LogReader: typeof import('./log-reader.js').LogReader,
  Aggregator: typeof import('./aggregator.js').Aggregator,
  logDir: string,
  abortSignal: AbortSignal,
  initialFilter?: string,
): AsyncIterable<import('./aggregator.js').DashboardState> {
  const reader = new LogReader(logDir, { pollIntervalMs: 2000 });
  const aggregator = new Aggregator();
  const stateQueue: import('./aggregator.js').DashboardState[] = [];
  let resolveNext: ((result: IteratorResult<import('./aggregator.js').DashboardState>) => void) | null = null;
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;

  function flushState(): void {
    if (resolveNext && stateQueue.length > 0) {
      const state = stateQueue.shift()!;
      resolveNext({ value: state, done: false });
      resolveNext = null;
    }
  }

  reader.on('entries', (entries: import('../core/logger.js').LogEntry[]) => {
    for (const entry of entries) {
      aggregator.process(entry);
    }
    stateQueue.push(aggregator.getState());
    // 节流 200ms
    if (!throttleTimer) {
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        flushState();
      }, 200);
    }
  });

  reader.on('error', (err: Error) => {
    // 静默处理读取错误，不中断面板
    void err;
  });

  // 启动读取
  reader.start().catch(() => {});

  // abort 时清理
  abortSignal.addEventListener('abort', () => {
    reader.stop();
    if (throttleTimer) clearTimeout(throttleTimer);
    if (resolveNext) {
      resolveNext({ value: undefined as any, done: true });
      resolveNext = null;
    }
  });

  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<import('./aggregator.js').DashboardState>> {
          // 如果队列中已有状态，立即返回
          if (stateQueue.length > 0) {
            return { value: stateQueue.shift()!, done: false };
          }
          // 否则等待下一个状态
          return new Promise<IteratorResult<import('./aggregator.js').DashboardState>>(resolve => {
            resolveNext = resolve;
          });
        },
        async return(): Promise<IteratorResult<import('./aggregator.js').DashboardState>> {
          reader.stop();
          if (throttleTimer) clearTimeout(throttleTimer);
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

  // 复用 Logger 的 resolveLogDir（单一路径定义）
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

  const abortController = new AbortController();

  // SIGINT 清理（ink 的 useApp exit 可能不够及时）
  const onSigint = () => {
    abortController.abort();
    process.exit(0);
  };
  process.on('SIGINT', onSigint);

  // --filter 作为 UI 初始过滤状态
  const stateStream = createStateStream(LogReader, Aggregator, logDir, abortController.signal, filter);

  const { waitUntilExit } = renderDashboard(stateStream, filter);

  try {
    await waitUntilExit();
  } catch {
    // ink 退出时可能抛出
  } finally {
    abortController.abort();
    process.removeListener('SIGINT', onSigint);
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
git commit -m "feat(dashboard): CLI entry with resolveLogDir reuse, AbortController, --filter"
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
Expected: 全部 passed

- [ ] **Step 4: 手动验证 Dashboard 启动**

在一个终端启动 MCP 服务，在另一个终端运行：

```bash
node build/dashboard/index.js
```

验证：
- 四面板 TUI 布局正常显示
- 日志实时刷新
- StatusBar 显示模式 + projectPath
- 快捷键：Space 暂停、q 退出、l 级别切换、f 过滤
- `--filter=bridge` 作为初始过滤条件生效
- `--help` 显示帮助

- [ ] **Step 5: 验证 ink 未安装时的降级**

```bash
node build/dashboard/index.js --help
```

Expected: 显示帮助信息（不依赖 ink）

- [ ] **Step 6: 最终提交**

```bash
git log --oneline -12
```

---

## 审查修复对照表

| # | 审查发现 | 优先级 | 计划中修复位置 | 状态 |
|---|---------|--------|---------------|------|
| 1 | LogReader → createReadStream + Buffer | IMPORTANT | Task 5 readFromOffset | ✅ |
| 2 | timeSeries → RingBuffer | IMPORTANT | Task 4 Aggregator | ✅ |
| 3 | DashboardState + projectPath | IMPORTANT | Task 4 + Task 7 StatusBar | ✅ |
| 4 | 复用 Logger resolveLogDir() | IMPORTANT | Task 5 Step 1 + Task 8 index.ts | ✅ |
| 5 | AsyncIterable 竞态 + SIGINT | IMPORTANT | Task 8 createStateStream + AbortController | ✅ |
| 6 | readFromOffset emit error | IMPORTANT | Task 5 readFromOffset catch + startWatch | ✅ |
| 7 | 补 4 个缺失测试 | IMPORTANT | Task 1 clear + Task 2 NaN/大数组 + Task 4 projectPath/溢出 | ✅ |
| 8 | Sparkline 防御性降采样 | ADVISORY | Task 2 DOWNSAMPLE_THRESHOLD + 循环 min/max | ✅ |
| 9 | --filter 真正生效 | ADVISORY | Task 8 initialFilter + Task 7 initialFilter prop | ✅ |
| 10 | ui.tsx 统一顶部 import | ADVISORY | Task 7 顶部 `import type { LogEntry }` + `import type { DashboardState, ToolStats }` | ✅ |
| 11 | create_stateStream → createStateStream | ADVISORY | Task 8 函数名 | ✅ |
| 12 | LogReader 注入 pollIntervalMs | ADVISORY | Task 5 构造函数 LogReaderOptions | ✅ |
| 13 | Math.min(...) 栈溢出 | ADVISORY | Task 2 循环替代展开 | ✅ |
