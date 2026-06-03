import { spawn } from 'child_process';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { appendOutput, clearOutputBuffer, killProcess, forceKillTree, setProcessBusy, acquireProcessSlot, acquireShortRunningSlot, releaseShortRunningSlot, buildBusyErrorMessage } from '../core/process-state.js';
import { requireProjectPath, checkVersionMismatch, buildSafeEnv } from '../helpers.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { getLogger } from '../core/logger.js';

const ACTIONS = [
  'launch_editor',
  'run_project',
  'stop_project',
  'get_debug_output',
  'run_tests',
  'get_godot_version',
] as const;

// ─── classifyOutput helper ──────────────────────────────────────────────────

function classifyOutput(lines: string[]): {
  errors: string[];
  warnings: string[];
  prints: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const prints: string[] = [];

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes('error') || lower.includes('exception') || lower.includes('traceback')) {
      errors.push(line);
    } else if (lower.includes('warning') || lower.includes('warn')) {
      warnings.push(line);
    } else {
      prints.push(line);
    }
  }

  return { errors, warnings, prints };
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'runtime',
      description: '启动编辑器、运行/停止项目、获取调试输出、运行测试、获取 Godot 版本。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['launch_editor', 'run_project', 'stop_project', 'get_debug_output', 'run_tests', 'get_godot_version'],
            description: '操作类型',
          },
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          timeout: { type: 'number', description: '自动停止秒数（默认 30）', default: 30 },
          test_script: { type: 'string', description: '测试脚本或目录路径（默认 res://test/）', default: 'res://test/' },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (name !== 'runtime') return null;
  const action = args.action as string;
  if (!(ACTIONS as readonly string[]).includes(action)) return null;

  switch (action) {
    case 'launch_editor': {
      const p = requireProjectPath(args);
      if (!existsSync(join(p, 'project.godot'))) {
        return textResult(`Error: Not a Godot project (no project.godot found): ${p}`);
      }
      const godot = await ctx.findGodot();
      const child = spawn(godot, ['--editor', '--path', p], { detached: true, stdio: 'ignore', env: buildSafeEnv() });
      child.on('error', (err) => {
        getLogger().error('runtime', `Failed to launch editor: ${err.message}`);
      });
      child.unref();
      return textResult(`Launched Godot editor for project: ${p}`);
    }

    case 'run_project': {
      const p = requireProjectPath(args);
      if (!existsSync(join(p, 'project.godot'))) {
        return textResult(`Error: Not a Godot project (no project.godot found): ${p}`);
      }
      const timeout = Math.max(5, Number(args.timeout) || 30);
      const godot = await ctx.findGodot();

      // Version mismatch warning
      const versionWarning = await checkVersionMismatch(p, godot);
      const warnPrefix = versionWarning ? versionWarning + '\n' : '';

      // Stop existing
      if (ctx.runningProcess) {
        setProcessBusy(false);
        await killProcess(ctx.runningProcess);
        ctx.setRunningProcess(null);
      }

      // Atomically acquire the process slot after clearing any existing process
      if (!acquireProcessSlot('run_project')) {
        return textResult(buildBusyErrorMessage());
      }

      ctx.setProjectDir(p);
      clearOutputBuffer();
      ctx.setProcessStartTime(Date.now());

      const proc = spawn(godot, ['--path', p, '--debug'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildSafeEnv(),
      });

      proc.stdout?.on('data', (data: Buffer) => {
        appendOutput(data.toString().split('\n'));
      });
      proc.stderr?.on('data', (data: Buffer) => {
        appendOutput(data.toString().split('\n'));
      });

      // Auto-stop after timeout
      let autoStopTimer: ReturnType<typeof setTimeout> | undefined;
      if (timeout > 0) {
        autoStopTimer = setTimeout(() => {
          if (ctx.runningProcess === proc) {
            setProcessBusy(false);
            void killProcess(proc);
            ctx.setRunningProcess(null);
          }
        }, timeout * 1000);
      }

      proc.on('close', () => {
        setProcessBusy(false);
        ctx.setRunningProcess(null);
        if (autoStopTimer) clearTimeout(autoStopTimer);
      });

      proc.on('error', (err) => {
        setProcessBusy(false);
        ctx.setRunningProcess(null);
        if (autoStopTimer) clearTimeout(autoStopTimer);
        appendOutput([`Spawn error: ${err.message}`]);
      });

      ctx.setRunningProcess(proc);

      return textResult(warnPrefix + `Running project at ${p} (timeout: ${timeout}s). Use get_debug_output or stop_project to check.`);
    }

    case 'stop_project': {
      if (!ctx.runningProcess) {
        return textResult('No project is currently running.');
      }
      await killProcess(ctx.runningProcess);
      setProcessBusy(false);
      ctx.setRunningProcess(null);

      const classified = classifyOutput(ctx.outputBuffer);
      const result = {
        status: 'stopped',
        runtime: `${((Date.now() - ctx.processStartTime) / 1000).toFixed(1)}s`,
        errors: classified.errors,
        warnings: classified.warnings,
        prints: classified.prints.slice(-50),
        total_lines: ctx.outputBuffer.length,
      };
      clearOutputBuffer();
      return textResult(JSON.stringify(result, null, 2));
    }

    case 'get_debug_output': {
      if (ctx.outputBuffer.length === 0 && !ctx.runningProcess) {
        return textResult('No debug output available. Run a project first.');
      }
      const classified = classifyOutput(ctx.outputBuffer);
      const result = {
        running: ctx.runningProcess !== null,
        runtime: `${((Date.now() - ctx.processStartTime) / 1000).toFixed(1)}s`,
        errors: classified.errors,
        warnings: classified.warnings,
        prints: classified.prints.slice(-50),
        total_lines: ctx.outputBuffer.length,
      };
      return textResult(JSON.stringify(result, null, 2));
    }

    case 'run_tests': {
      const p = requireProjectPath(args);
      if (!existsSync(join(p, 'project.godot'))) {
        return textResult(`Error: Not a Godot project (no project.godot found): ${p}`);
      }
      if (!acquireShortRunningSlot()) return textResult('Error: too many concurrent headless operations (max 3). Please wait and retry.');
      const testScript = (args.test_script as string) || 'res://test/';
      const godot = await ctx.findGodot();

      return new Promise((resolve) => {
        let settled = false;
        const proc = spawn(godot, [
          '--headless', '--path', p,
          '--script', 'addons/gut/gut_cmdln.gd',
          '-gdir', testScript,
          '-gquit',
        ], { stdio: ['pipe', 'pipe', 'pipe'], env: buildSafeEnv() });

        let out = '';
        const MAX_OUTPUT = 500_000;
        proc.stdout?.on('data', (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString(); });
        proc.stderr?.on('data', (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString(); });

        const timer = setTimeout(() => {
          if (!settled && !proc.killed) {
            settled = true;
            forceKillTree(proc);
            releaseShortRunningSlot();
            resolve(textResult('run_tests timed out after 120s'));
          }
        }, 120000);

        proc.on('close', (code) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          releaseShortRunningSlot();
          const passed = (out.match(/Tests: (\d+)/g) || []).map(m => m.replace('Tests: ', ''));
          const failed = (out.match(/Failed: (\d+)/g) || []).map(m => m.replace('Failed: ', ''));
          resolve({
            content: [{
              type: 'text',
              text: JSON.stringify({
                exit_code: code,
                passed: passed.join(', '),
                failed: failed.join(', '),
                raw_output: out,
              }, null, 2),
            }],
          });
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          releaseShortRunningSlot();
          resolve({ content: [{ type: 'text', text: `Error: ${err.message}` }] });
        });
      });
    }

    case 'get_godot_version': {
      if (!acquireShortRunningSlot()) return textResult('Error: too many concurrent headless operations (max 3). Please wait and retry.');
      const godot = await ctx.findGodot();
      return new Promise((resolve) => {
        let settled = false;
        const proc = spawn(godot, ['--version'], { stdio: ['pipe', 'pipe', 'pipe'], env: buildSafeEnv() });
        let out = '';
        proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
        proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });

        const timer = setTimeout(() => {
          if (!settled && !proc.killed) {
            settled = true;
            forceKillTree(proc);
            releaseShortRunningSlot();
            resolve(textResult('get_godot_version timed out after 10s'));
          }
        }, 10000);

        proc.on('close', () => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          releaseShortRunningSlot();
          resolve({ content: [{ type: 'text', text: out.trim() }] });
        });
        proc.on('error', (err) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          releaseShortRunningSlot();
          resolve({ content: [{ type: 'text', text: `Error: ${err.message}` }] });
        });
      });
    }

    default:
      return null;
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  runtime: { readonly: false, long_running: true },
};
