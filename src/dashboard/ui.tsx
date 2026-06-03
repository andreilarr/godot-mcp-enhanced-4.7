import React, { useState, useEffect } from 'react';
import { Box, Text, render, useInput, useApp } from 'ink';
import type { LogEntry } from '../core/logger.js';
import type { DashboardState, ToolStats } from './aggregator.js';
import { sparkline } from './sparkline.js';
import {
  LEVEL_COLORS, LEVEL_PREFIX, MODULE_COLORS, STATUS,
  SPARKLINE_COLORS, BORDER_COLOR, KEYBIND_COLOR,
} from './themes.js';

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

function LogStream({ logs, filter, levelFilter, scrollOffset }: {
  logs: LogEntry[];
  filter: string;
  levelFilter: string;
  scrollOffset: number;
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

  // C-01: 支持 scrollOffset 从底部向上滚动
  const maxVisible = 15;
  const endIdx = Math.max(0, filtered.length - scrollOffset);
  const startIdx = Math.max(0, endIdx - maxVisible);
  const visible = filtered.slice(startIdx, endIdx);

  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor={BORDER_COLOR} paddingX={0}>
      <Text bold> Log Stream (live)</Text>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {visible.map((entry, i) => (
          <LogLine key={`${entry.ts}-${i}`} entry={entry} />
        ))}
      </Box>
    </Box>
  );
}

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
  const [scrollOffset, setScrollOffset] = useState(0);
  const [streamEnded, setStreamEnded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for await (const s of stateStream) {
        if (cancelled) break;
        if (!paused) {
          setState(s);
          setScrollOffset(0);
        }
      }
      if (!cancelled) setStreamEnded(true);
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
      // C-02: clear 后强制重渲染
      if (state) {
        state.recentLogs.clear();
        setState({ ...state });
      }
    } else if (key.upArrow) {
      // C-01: 向上滚动（查看更早的日志），限制不超过日志总量
      setScrollOffset(prev => {
        const maxOffset = Math.max(0, (state?.recentLogs.length ?? 1) - 1);
        return Math.min(prev + 1, maxOffset);
      });
    } else if (key.downArrow) {
      // C-01: 向下滚动（回到最新）
      setScrollOffset(prev => Math.max(0, prev - 1));
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
          scrollOffset={scrollOffset}
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
      {streamEnded && (
        <Text color="yellow">Stream ended — press q to quit</Text>
      )}
    </Box>
  );
}

export function renderDashboard(stateStream: AsyncIterable<DashboardState>, initialFilter?: string) {
  return render(<Dashboard stateStream={stateStream} initialFilter={initialFilter} />);
}

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
