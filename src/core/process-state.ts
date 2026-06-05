/**
 * Process state management for Godot MCP Enhanced.
 *
 * @concurrent_safe false — Module-scoped mutable state (_runningProcess, _outputBuffer, etc.)
 * relies on Node.js single-threaded event loop for serialization. This is safe because MCP
 * communicates over stdio, which is inherently sequential (one tool call at a time).
 *
 * ⚠️ I-03: Known concurrency risk — if MCP clients introduce parallel tool calls (e.g.,
 * Claude Code's parallel agent mode), these shared states WILL have race conditions:
 *   - _runningProcess: two calls to run_project() could race
 *   - _shortRunningCount: acquireShortRunningSlot()/releaseShortRunningSlot() are not atomic
 *     across await points
 *   - _outputBuffer: concurrent writes could interleave
 *
 * MITIGATION PLAN (when parallel calls are introduced):
 *   (a) Add a mutex/queue wrapping each state-mutating operation
 *   (b) Refactor to per-request state objects instead of module singletons
 *   (c) Use AsyncLocalStorage for request-scoped state isolation
 */

import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { getLogger } from './logger.js';

const isWin = process.platform === 'win32';

const MAX_OUTPUT_BUFFER_SIZE = 5000;
const MAX_SHORT_CONCURRENT = 3;

// ─── Cross-platform process termination ────────────────────────────────────

/** Kill process tree without blocking the event loop. Uses async spawn on Windows. */
export function forceKillTree(proc: ChildProcess): void {
  if (proc.killed) return;
  if (isWin) {
    try {
      const child = spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
      child.on('error', () => { proc.kill(); });
    } catch (err) {
      getLogger().debug('process-state', `taskkill failed, falling back to proc.kill: ${err}`);
      proc.kill();
    }
  } else {
    proc.kill('SIGTERM');
  }
}

/** Async kill: waits for 'close' event, with 5 s fallback. */
export function killProcess(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.killed) { resolve(); return; }
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };
    const timer = setTimeout(() => {
      forceKillTree(proc);
      done();
    }, 5000);

    proc.on('close', () => {
      clearTimeout(timer);
      done();
    });
    proc.on('error', () => {
      clearTimeout(timer);
      done();
    });

    forceKillTree(proc);
  });
}

// ─── Module-level mutable state ─────────────────────────────────────────────
// Intentional design: module-scoped "singleton" state accessed exclusively
// through the getter/setter functions below. This avoids class instantiation
// overhead while still providing encapsulation — consumers never touch these
// variables directly. Use resetState() for test isolation.
let _runningProcess: ChildProcess | null = null;
let _outputBuffer: string[] = [];
let _processStartTime = 0;
let _projectDir = '';

// Long-running lock: run_project only (game process that persists for seconds/minutes)
let _processBusy = false;
let _busyOwner = '';
let _busySince = 0;

// Short-running counter: query_scene_tree / inspect_node (seconds-level operations)
let _shortRunningCount = 0;

// ─── Long-running process lock ──────────────────────────────────────────────

export function isProcessBusy(): boolean {
  return _processBusy;
}

/** Atomically acquire the long-running process slot. Returns true if acquired, false if busy. */
export function acquireProcessSlot(owner: string = ''): boolean {
  if (_processBusy) {
    // I-03: 自动清理 — 仅在进程已死亡时才释放（检查 killed 标志）
    // 避免中断合法长时间运行的进程（如 GUT 测试套件）
    if (_busySince > 0 && Date.now() - _busySince > 300_000) {
      const processDead = !_runningProcess || _runningProcess.killed || _runningProcess.exitCode !== null;
      if (processDead) {
        getLogger().warn('process-state', `Process slot held by "${_busyOwner}" for >5min, process dead — auto-releasing`);
        _processBusy = false;
        _busyOwner = '';
        _busySince = 0;
      } else {
        getLogger().warn('process-state', `Process slot held by "${_busyOwner}" for >5min, process still alive — not releasing`);
      }
    }
    if (_processBusy) return false;
  }
  _processBusy = true;
  _busyOwner = owner;
  _busySince = Date.now();
  return true;
}

export function setProcessBusy(busy: boolean): void {
  _processBusy = busy;
  if (!busy) {
    _busyOwner = '';
    _busySince = 0;
  }
}

/** Get info about what is currently holding the long-running lock. */
export function getBusyInfo(): { owner: string; startTime: number; projectDir: string } {
  return { owner: _busyOwner, startTime: _processStartTime, projectDir: _projectDir };
}

/** Build a user-friendly error message when the long-running slot is occupied. */
export function buildBusyErrorMessage(): string {
  if (!_processBusy) return '';
  const info = getBusyInfo();

  const details: string[] = [];
  if (info.startTime > 0) {
    const elapsed = Math.round((Date.now() - info.startTime) / 1000);
    details.push(`running for ${elapsed}s`);
  }
  if (info.projectDir) {
    details.push(`project: ${info.projectDir}`);
  }

  let msg = 'Error: another Godot process is running';
  if (info.owner) {
    msg += ` (started by ${info.owner}`;
    if (details.length > 0) msg += ', ' + details.join(', ');
    msg += ')';
  } else if (details.length > 0) {
    msg += ' (' + details.join(', ') + ')';
  }
  return msg + '. Use stop_project to release it.';
}

// ─── Short-running process lock ─────────────────────────────────────────────

export function acquireShortRunningSlot(): boolean {
  if (_shortRunningCount >= MAX_SHORT_CONCURRENT) return false;
  _shortRunningCount++;
  return true;
}

export function releaseShortRunningSlot(): void {
  _shortRunningCount = Math.max(0, _shortRunningCount - 1);
}

export function getShortRunningCount(): number {
  return _shortRunningCount;
}

// ─── Running process management ─────────────────────────────────────────────

export function getRunningProcess(): ChildProcess | null {
  return _runningProcess;
}

export function setRunningProcess(proc: ChildProcess | null): void {
  if (_processBusy && proc !== null) {
    throw new Error('Cannot replace process while another operation is using it');
  }
  // Clearing the process always clears busy state
  if (proc === null) {
    if (_processBusy) {
      getLogger().debug('process-state', `setRunningProcess(null) called while process is busy (owner: ${_busyOwner || '(unknown)'}). This bypasses acquire/release semantics.`);
    }
    _processBusy = false;
    _busyOwner = '';
    _busySince = 0;
  }
  if (_runningProcess && !_runningProcess.killed && proc !== _runningProcess) {
    forceKillTree(_runningProcess);
  }
  _runningProcess = proc;
  if (!proc) {
    _outputBuffer = [];
    _processStartTime = 0;
  }
}

export function getOutputBuffer(): string[] {
  return _outputBuffer;
}

export function appendOutput(lines: string[]): void {
  _outputBuffer.push(...lines);
  if (_outputBuffer.length > MAX_OUTPUT_BUFFER_SIZE) {
    _outputBuffer = _outputBuffer.slice(-MAX_OUTPUT_BUFFER_SIZE);
  }
}

export function clearOutputBuffer(): void {
  _outputBuffer = [];
}

export function setOutputBuffer(buf: string[]): void {
  _outputBuffer = buf;
}

export function getProcessStartTime(): number {
  return _processStartTime;
}

export function setProcessStartTime(t: number): void {
  _processStartTime = t;
}

export function getProjectDir(): string {
  return _projectDir;
}

export function setProjectDir(d: string): void {
  _projectDir = d;
}

/** Reset all module-level state — for test isolation. */
export function resetState(): void {
  _runningProcess = null;
  _outputBuffer = [];
  _processStartTime = 0;
  _projectDir = '';
  _processBusy = false;
  _busyOwner = '';
  _busySince = 0;
  _shortRunningCount = 0;
}
