/**
 * Process state management for Godot MCP Enhanced.
 *
 * C-04: Async state-mutating operations are serialized through `enqueueAsync`.
 * Reads are still direct (no queueing) since they're atomic in the Node.js
 * single-threaded model. This prevents race conditions when MCP clients
 * introduce parallel tool calls.
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
    // F-5: 进程已自然退出(exitCode !== null)也立即 resolve,避免无谓等 5s timer
    if (proc.killed || proc.exitCode !== null) { resolve(); return; }
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

/** Serialize an async state-mutating operation. Ensures only one async mutation
 *  is in-flight at a time. Supports returning a value from the serialized function. */
function enqueueAsync<T>(fn: () => (Promise<T> | T)): Promise<T> {
  let resolve!: (value: void) => void;
  const prev = _queueTail;
  _queueTail = new Promise<void>((r) => { resolve = r; });
  return prev
    .then(() => fn())
    .then(
      (result) => { resolve(); return result; },
      (err) => { resolve(); throw err; },
    );
}

// ─── Long-running process lock ──────────────────────────────────────────────

export function isProcessBusy(): boolean {
  return _processBusy;
}

/**
 * Acquire the long-running process slot through the async serialization queue.
 * Serialized via enqueueAsync to prevent race conditions when MCP clients
 * issue parallel tool calls (e.g. run_project + execute_gdscript simultaneously).
 * Returns true if acquired, false if slot is busy.
 */
export async function acquireProcessSlot(owner: string = ''): Promise<boolean> {
  return enqueueAsync(() => {
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
  });
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

export function setRunningProcess(proc: ChildProcess | null, skipBusyCheck = false): void {
  if (!skipBusyCheck && _processBusy && proc !== null) {
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
  _lastOrphanScanTime = 0;
}

// Export async queue for consumers that need serialized async operations (e.g. killProcess)
export { enqueueAsync };

// ─── Orphan process cleanup (V-01 second layer) ────────────────────────────

let _lastOrphanScanTime = 0;
const ORPHAN_SCAN_INTERVAL_MS = 30_000;

/** Escape single quotes for PowerShell single-quoted strings (' → ''). */
function escapePsSingleQuote(s: string): string {
  return s.replace(/'/g, "''");
}

/** Escape single quotes for POSIX shell single-quoted strings (' → '\''). */
function escapeShellArg(s: string): string {
  return s.replace(/'/g, "'\\''");
}

const ORPHAN_SCAN_TIMEOUT_MS = 15_000;

/**
 * Scan OS for orphaned Godot processes matching a project directory and kill them.
 * Returns the number of processes killed. Throttled to once per 30s.
 *
 * Windows: uses Get-CimInstance with PowerShell variable for path parameterization.
 * Linux/macOS: uses pgrep + grep -F for literal path matching.
 */
export async function killOrphanGodotProcesses(projectDir: string): Promise<number> {
  if (Date.now() - _lastOrphanScanTime < ORPHAN_SCAN_INTERVAL_MS) return 0;
  _lastOrphanScanTime = Date.now();

  if (!projectDir) return 0;

  const normalizedDir = projectDir.replace(/\\/g, '/');

  if (isWin) {
    const safePath = escapePsSingleQuote(normalizedDir);
    return new Promise((resolve) => {
      let settled = false;
      const ps = spawn('powershell', [
        '-NoProfile', '-Command',
        // I-01 fix: use ('*'+$path+'*') instead of "*$path*" to avoid $ expansion in -like
        `$path = '${safePath}'; ` +
        `Get-CimInstance Win32_Process -Filter "Name LIKE 'Godot%'" | ` +
        `Where-Object { $_.CommandLine -like '*--path*' -and $_.CommandLine -like ('*' + $path + '*') } | ` +
        `Select-Object -ExpandProperty ProcessId | ForEach-Object { Write-Output $_ }`
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      // I-03 fix: 15s timeout to prevent hanging on unresponsive WMI/shell
      const timer = setTimeout(() => {
        if (!settled && !ps.killed) {
          settled = true;
          ps.kill();
          resolve(0);
        }
      }, ORPHAN_SCAN_TIMEOUT_MS);

      let out = '';
      let stderr = '';
      ps.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      ps.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      ps.on('close', () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        const pids = out.trim().split('\n').map(Number).filter(n => n > 0);
        for (const pid of pids) {
          try {
            spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
          } catch { /* best effort */ }
        }
        if (stderr) getLogger().debug('process-state', `orphan scan stderr: ${stderr.slice(0, 200)}`);
        resolve(pids.length);
      });
      ps.on('error', (err) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        getLogger().debug('process-state', `orphan scan error: ${err.message}`);
        resolve(0);
      });
    });
  } else {
    // I-02 fix: use single-quoted shell argument with proper escaping
    const safeDir = escapeShellArg(normalizedDir);
    return new Promise((resolve) => {
      let settled = false;
      const ps = spawn('sh', ['-c',
        `pgrep -f godot | xargs -I{} sh -c 'cat /proc/{}/cmdline 2>/dev/null | tr "\\0" " " | grep -F -- '${safeDir}' && echo {}'`
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      const timer = setTimeout(() => {
        if (!settled && !ps.killed) {
          settled = true;
          ps.kill();
          resolve(0);
        }
      }, ORPHAN_SCAN_TIMEOUT_MS);

      let out = '';
      let stderr = '';
      ps.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      ps.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      ps.on('close', () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        const lines = out.trim().split('\n').filter(l => /^\d+$/.test(l.trim()));
        const pids = lines.map(Number).filter(n => n > 0);
        for (const pid of pids) {
          try { process.kill(pid, 'SIGTERM'); } catch { /* best effort */ }
        }
        if (stderr) getLogger().debug('process-state', `orphan scan stderr: ${stderr.slice(0, 200)}`);
        resolve(pids.length);
      });
      ps.on('error', (err) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        getLogger().debug('process-state', `orphan scan error: ${err.message}`);
        resolve(0);
      });
    });
  }
}
