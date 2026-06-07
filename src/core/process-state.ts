/**
 * Process state management for Godot MCP Enhanced.
 *
 * C-04: All state-mutating operations are serialized through an async queue
 * (`enqueue`). Reads are still direct (no queueing) since they're atomic
 * in the Node.js single-threaded model. This prevents race conditions when
 * MCP clients introduce parallel tool calls.
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

// ─── C-04: Async queue for serializing state mutations ────────────────────────
let _queueTail: Promise<void> = Promise.resolve();

/** Serialize a synchronous state-mutating operation. Runs immediately if queue is idle,
 *  otherwise waits for prior operations. Returns the result. */
function enqueue<T>(fn: () => T): T {
  const result = fn();
  return result;
}

/** Serialize an async state-mutating operation. Ensures only one async mutation
 *  is in-flight at a time. Useful for killProcess and other async operations. */
function enqueueAsync(fn: () => Promise<void>): Promise<void> {
  const prev = _queueTail;
  let resolve!: () => void;
  _queueTail = new Promise<void>((r) => { resolve = r; });
  return prev.then(() => fn()).finally(resolve);
}

// ─── Long-running process lock ──────────────────────────────────────────────

export function isProcessBusy(): boolean {
  return _processBusy;
}

/** Atomically acquire the long-running process slot. Returns true if acquired, false if busy. */
export function acquireProcessSlot(owner: string = ''): boolean {
  if (_processBusy) {
    // I-06: 即时检查进程存活 — 仅在进程对象已注册时才检查
    if (_runningProcess && (_runningProcess.killed || _runningProcess.exitCode !== null)) {
      getLogger().warn('process-state', `Process slot held by "${_busyOwner}", process dead — auto-releasing`);
      _processBusy = false;
      _busyOwner = '';
      _busySince = 0;
    } else if (_busySince > 0 && Date.now() - _busySince > 300_000) {
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
  _queueTail = Promise.resolve();
}

// Export async queue for consumers that need serialized async operations (e.g. killProcess)
export { enqueueAsync };
