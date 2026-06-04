import { spawn, type ChildProcess } from 'child_process';
import { buildSafeEnv } from '../helpers.js';
import { forceKillTree } from '../core/process-state.js';

export interface SpawnResult {
  stdout: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * 通用 Godot headless spawn：带超时、输出收集、settled 防重入。
 *
 * - `killFn` 默认使用 `forceKillTree`（杀整个进程树），可覆盖为 `proc.kill()` 等。
 * - spawn() 同步异常被捕获并返回 `{ exitCode: -1 }`。
 */
export function spawnGodot(
  godot: string,
  args: string[],
  opts?: {
    timeoutMs?: number;
    maxOutput?: number;
    killFn?: (proc: ChildProcess) => void;
  },
): Promise<SpawnResult> {
  const {
    timeoutMs = 60_000,
    maxOutput = 100_000,
    killFn = (p: ChildProcess) => { if (!p.killed) forceKillTree(p); },
  } = opts ?? {};

  const env = buildSafeEnv();

  return new Promise<SpawnResult>((resolve) => {
    let proc: ChildProcess;
    let settled = false;
    let out = '';

    try {
      proc = spawn(godot, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    } catch (spawnErr) {
      resolve({
        stdout: `SPAWN_FAILED: ${(spawnErr as Error).message}`,
        exitCode: -1,
        timedOut: false,
      });
      return;
    }

    proc.stdout!.on('data', (d: Buffer) => { if (out.length < maxOutput) out += d.toString(); });
    proc.stderr!.on('data', (d: Buffer) => { if (out.length < maxOutput) out += d.toString(); });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killFn(proc);
      resolve({ stdout: out, exitCode: null, timedOut: true });
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ stdout: out, exitCode: code, timedOut: false });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      out += `\nError: ${err.message}`;
      resolve({ stdout: out, exitCode: -1, timedOut: false });
    });
  });
}
