import { spawn } from 'child_process';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { appendOutput, clearOutputBuffer, killProcess, forceKillTree, setProcessBusy, acquireProcessSlot, acquireShortRunningSlot, releaseShortRunningSlot, buildBusyErrorMessage, killOrphanGodotProcesses } from '../core/process-state.js';
import { requireProjectPath, checkVersionMismatch, buildSafeEnv } from '../helpers.js';
import { handleRecordingAction } from './recording.js';
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
  // ── Recording actions (merged from recording.ts, v0.18.0) ──
  'record_start',
  'record_stop',
  'record_save',
  'record_load',
  'record_play',
] as const;

// ─── classifyOutput helper ──────────────────────────────────────────────────

// A-06: Use precise pattern matching to avoid false positives like "no errors found"
const ERROR_PATTERNS = [
  /^\s*error:/i,           // "ERROR:" or "  error:" at line start
  /\berror\b(?!\s+found)/i, // "error" but not "error found" or "errors found"
  /traceback/i,
  /exception/i,
  /SCRIPT ERROR/i,
  /\*\*ERROR\*\*/i,
];

const WARN_PATTERNS = [
  /^\s*warn(?:ing)?:/i,    // "WARNING:" or "warn:" at line start
  /\bwarn(?:ing)?\b(?!\s+found)/i, // "warning"/"warn" but not "warning found" or "warnings found"
  /\*\*WARNING\*\*/i,
];

function classifyOutput(lines: string[]): {
  errors: string[];
  warnings: string[];
  prints: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const prints: string[] = [];

  for (const line of lines) {
    if (ERROR_PATTERNS.some(p => p.test(line))) {
      errors.push(line);
    } else if (WARN_PATTERNS.some(p => p.test(line))) {
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
            enum: ['launch_editor', 'run_project', 'stop_project', 'get_debug_output', 'run_tests', 'get_godot_version', 'record_start', 'record_stop', 'record_save', 'record_load', 'record_play'],
            description: '操作类型',
          },
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          timeout: { type: 'number', description: '自动停止秒数（默认 30）', default: 30 },
          test_script: { type: 'string', description: '测试脚本或目录路径（默认 res://test/）', default: 'res://test/' },
          // ── Recording parameters (merged, v0.18.0) ──
          events_json: { type: 'string', description: '录制：JSON 格式的事件序列字符串' },
          file_name: { type: 'string', description: '录制：录制文件名（仅接受 recording_*.json 格式）' },
          speed: { type: 'number', description: '录制：回放速度倍率（默认 1.0）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
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

      ctx.setRunningProcess(proc, true); // skip busy check — slot acquired via acquireProcessSlot above

      return textResult(warnPrefix + `Running project at ${p} (timeout: ${timeout}s). Use get_debug_output or stop_project to check.`);
    }

    case 'stop_project': {
      if (!ctx.runningProcess) {
        // V-01 second layer: scan for orphaned Godot processes
        const rawPath = args.project_path;
        const projectDir = (typeof rawPath === 'string' && rawPath.length > 0 ? rawPath : '') || ctx.projectDir || '';
        const orphanKilled = await killOrphanGodotProcesses(projectDir);
        if (orphanKilled > 0) {
          return textResult(`Cleaned up ${orphanKilled} orphaned Godot process(es). Project directory: ${projectDir}`);
        }
        return textResult('No project is currently running.');
      }
      await killProcess(ctx.runningProcess);
      setProcessBusy(false);
      ctx.setRunningProcess(null);

      const classified = classifyOutput(ctx.outputBuffer);
      // I-10: Guard against processStartTime=0 producing absurd runtime values
      const runtimeMs = ctx.processStartTime > 0 ? Date.now() - ctx.processStartTime : 0;
      const result = {
        status: 'stopped',
        runtime: `${(runtimeMs / 1000).toFixed(1)}s`,
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
      const debugRuntimeMs = ctx.processStartTime > 0 ? Date.now() - ctx.processStartTime : 0;
      const result = {
        running: ctx.runningProcess !== null,
        runtime: `${(debugRuntimeMs / 1000).toFixed(1)}s`,
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
      const rawTestScript = (args.test_script as string) || 'res://test/';
      // I-SEC-08: Validate test_script starts with res:// to prevent filesystem traversal
      if (!rawTestScript.startsWith('res://')) {
        releaseShortRunningSlot();
        return textResult(`Error: test_script must start with "res://", got: "${rawTestScript}"`);
      }
      const testScript = rawTestScript;
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
          // I-11: Truncate raw_output to prevent excessive MCP channel bandwidth
          const MAX_RAW_OUTPUT = 50_000;
          const rawOutput = out.length > MAX_RAW_OUTPUT
            ? out.slice(0, MAX_RAW_OUTPUT) + `\n... [truncated, ${out.length} total bytes]`
            : out;
          resolve({
            content: [{
              type: 'text',
              text: JSON.stringify({
                exit_code: code,
                passed: passed.join(', '),
                failed: failed.join(', '),
                raw_output: rawOutput,
              }, null, 2),
            }],
          });
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          releaseShortRunningSlot();
          resolve({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
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
          resolve({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
        });
      });
    }

    // ── Recording actions (merged from recording.ts, v0.18.0) ──
    case 'record_start':
    case 'record_stop':
    case 'record_save':
    case 'record_load':
    case 'record_play': {
      return handleRecordingAction(action, args, ctx);
    }

    default:
      return null;
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  runtime: { readonly: false, long_running: true },
};
