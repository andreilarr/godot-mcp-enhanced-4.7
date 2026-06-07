#!/usr/bin/env node
// src/dashboard/index.ts
// godot-mcp-dashboard — 独立 CLI 终端面板，实时监控 MCP 服务

import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLogDir } from '../core/logger.js';
import type { LogEntry } from '../core/logger.js';
import type { LogReader } from './log-reader.js';
import type { Aggregator } from './aggregator.js';
import type { DashboardState } from './aggregator.js';

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

function createStateStream(
  ReaderClass: typeof LogReader,
  AggregatorClass: typeof Aggregator,
  logDir: string,
  abortSignal: AbortSignal,
  _initialFilter?: string,
): AsyncIterable<DashboardState> {
  const reader = new ReaderClass(logDir, { pollIntervalMs: 2000 });
  const aggregator = new AggregatorClass();
  const stateQueue: DashboardState[] = [];
  let resolveNext: ((result: IteratorResult<DashboardState>) => void) | null = null;
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;

  function flushState(): void {
    if (resolveNext && stateQueue.length > 0) {
      const state = stateQueue.shift()!;
      resolveNext({ value: state, done: false });
      resolveNext = null;
    }
  }

  reader.on('entries', (entries: LogEntry[]) => {
    for (const entry of entries) {
      aggregator.process(entry);
    }
    stateQueue.push(aggregator.getState());
    if (!throttleTimer) {
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        flushState();
      }, 200);
    }
  });

  reader.on('error', (err: Error) => {
    // I-04: 输出错误信息到 stderr，让用户知道发生了什么
    // NOTE: 保留 console.error — dashboard 是独立 CLI 进程，logger 未初始化，需直接输出到终端
    console.error('[dashboard] Log read error:', err.message);
  });

  reader.start().catch((err: Error) => {
    console.error('[dashboard] Failed to start log reader:', err.message);
  });

  abortSignal.addEventListener('abort', () => {
    reader.stop();
    if (throttleTimer) clearTimeout(throttleTimer);
    if (resolveNext) {
      resolveNext({ value: undefined as unknown as DashboardState, done: true });
      resolveNext = null;
    }
  });

  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<DashboardState>> {
          if (stateQueue.length > 0) {
            return { value: stateQueue.shift()!, done: false };
          }
          return new Promise<IteratorResult<DashboardState>>(resolve => {
            resolveNext = resolve;
          });
        },
        async return(): Promise<IteratorResult<DashboardState>> {
          reader.stop();
          if (throttleTimer) clearTimeout(throttleTimer);
          return { value: undefined as unknown as DashboardState, done: true };
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

  const logDir = resolveLogDir();

  if (!existsSync(logDir)) {
    // Auto-create log directory — MCP server may not have started yet
    try {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(logDir, { recursive: true });
    } catch {
      console.error(`无法创建日志目录: ${logDir}`);
      process.exit(1);
    }
  }

  const { LogReader: ReaderClass } = await import('./log-reader.js');
  const { Aggregator: AggregatorClass } = await import('./aggregator.js');
  const { renderDashboard } = await import('./ui.js');

  const abortController = new AbortController();

  const onSigint = () => {
    abortController.abort();
    process.exit(0);
  };
  process.on('SIGINT', onSigint);

  const stateStream = createStateStream(ReaderClass, AggregatorClass, logDir, abortController.signal, filter);

  const { waitUntilExit } = renderDashboard(stateStream, filter);

  try {
    await waitUntilExit();
  } catch {
    // 渲染退出时可能抛出
  } finally {
    abortController.abort();
    process.removeListener('SIGINT', onSigint);
  }
}

main().catch((err: Error) => {
  // Write crash log to file for diagnostics
  try {
    const crashLog = join(tmpdir(), 'godot-mcp-dashboard-crash.log');
    writeFileSync(crashLog, `[${new Date().toISOString()}] Dashboard crashed: ${err.message}\n${err.stack}\n`);
    console.error(`Dashboard crashed! Log: ${crashLog}`);
    console.error(err.message);
  } catch { /* ignore */ }
  // Keep window open for 10 seconds so user can read the error
  setTimeout(() => process.exit(1), 10000);
});

// Catch startup errors before main() runs (module loading etc.)
process.on('uncaughtException', (err: Error) => {
  try {
    const crashLog = join(tmpdir(), 'godot-mcp-dashboard-crash.log');
    writeFileSync(crashLog, `[${new Date().toISOString()}] Uncaught: ${err.message}\n${err.stack}\n`);
    console.error(`Dashboard crashed! Log: ${crashLog}`);
    console.error(err.message);
  } catch { /* ignore */ }
  setTimeout(() => process.exit(1), 10000);
});
