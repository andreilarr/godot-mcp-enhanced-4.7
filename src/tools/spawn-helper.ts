import { spawn, type ChildProcess } from 'child_process';
import { buildSafeEnv } from '../helpers.js';
import { forceKillTree } from '../core/process-state.js';

export interface SpawnResult {
  stdout: string;
  stderr: string;       // A-04: 分离 stderr，下游可精确判断错误来源
  output: string;       // A-04: stdout + stderr 合并输出（向后兼容）
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
    let errOut = '';  // A-04: 分离 stderr 收集

    try {
      proc = spawn(godot, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    } catch (spawnErr) {
      const msg = `SPAWN_FAILED: ${(spawnErr as Error).message}`;
      resolve({
        stdout: msg,
        stderr: '',
        output: msg,
        exitCode: -1,
        timedOut: false,
      });
      return;
    }

    proc.stdout!.on('data', (d: Buffer) => { if (out.length < maxOutput) out += d.toString(); });
    proc.stderr!.on('data', (d: Buffer) => { if (errOut.length < maxOutput) errOut += d.toString(); });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killFn(proc);
      resolve({ stdout: out, stderr: errOut, output: out + errOut, exitCode: null, timedOut: true });
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ stdout: out, stderr: errOut, output: out + errOut, exitCode: code, timedOut: false });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      errOut += `\nError: ${err.message}`;
      resolve({ stdout: out, stderr: errOut, output: out + errOut, exitCode: -1, timedOut: false });
    });
  });
}
