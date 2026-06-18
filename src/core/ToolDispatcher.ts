// src/core/ToolDispatcher.ts
import type { ToolResult, ToolContext, DispatchContext, Middleware, ToolCallDelegate } from '../types.js';
import type { ChildProcess } from 'child_process';
import type { ReadOnlyGuard } from './ReadOnlyGuard.js';
import type { EditorToolExecutor } from './EditorToolExecutor.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { executeMiddleware, createRateLimitMiddleware } from './middleware.js';
import { HealthMonitor } from './health-monitor.js';
import {
  requiresConfirmation,
  createPendingToken,
  consumeToken,
} from '../guard.js';
import {
  getAllToolDefinitions,
  getModuleForTool,
  isToolAllowed,
  LITE_TOOLS,
  MINIMAL_TOOLS,
  registerInlineTool,
  resolveProfile,
  skipProjectPath,
  tryLegacyMapping,
} from './tool-registry.js';
import { isPathInAllowedRoots, parseGodotConfig } from '../helpers.js';
import { opsErrorResult, COMMON_ERROR_CODES } from '../tools/shared.js';
import { truncateResponse } from './response-limiter.js';
import * as ps from './process-state.js';
import { getLogger } from './logger.js';
import { resolveProjectPath } from './path-utils.js';
import type { AgentContextManager } from './agent-context.js';

/** Known profile names for IDE autocomplete. Unknown strings fall through to resolveProfile(). */
type KnownProfile = 'full' | 'lite' | 'minimal' | 'bridge_dev' | '3d_dev';

const DEBUG = process.env.DEBUG === 'true';
function log(...args: unknown[]): void {
  if (DEBUG) getLogger().debug('dispatcher', args.map(a => String(a)).join(' '));
}

export interface DispatcherOptions {
  // 模式控制
  readOnly: boolean;
  mode: KnownProfile | string;  // 'full' | 'lite' | 'minimal' | profile name | comma-separated groups
  connectionMode: 'headless' | 'editor';
  noFallback: boolean;

  // 依赖注入
  readOnlyGuard: ReadOnlyGuard;
  editorExecutor?: EditorToolExecutor;
  opsScript: string;
  findGodot: (projectPath?: string) => Promise<string>;
  toolCallDelegate: (fn: ToolCallDelegate | null) => void;
  agentContext?: AgentContextManager;
}

export class ToolDispatcher {
  private readonly options: DispatcherOptions;
  private readonly readOnlyGuard: ReadOnlyGuard;
  private connectionMode: 'headless' | 'editor';
  private editorExecutor: EditorToolExecutor | null;
  private readonly ctx: ToolContext;
  private _editorFallback = false;
  private _editorFallbackWarned = false;
  private healthMonitor: HealthMonitor;
  private readonly middleware: Middleware[];

  /** Deferred mode switch — applied at the start of the next handleCall. Prevents
   *  editor disconnect callbacks from switching mode mid-request (C-01). */
  private _pendingModeSwitch: { mode: 'headless' | 'editor'; executor: EditorToolExecutor | null } | null = null;

  constructor(options: DispatcherOptions) {
    this.options = options;
    this.readOnlyGuard = options.readOnlyGuard;
    this.connectionMode = options.connectionMode;
    this.editorExecutor = options.editorExecutor ?? null;

    // 构建 ctx — 直接 import process-state（内部实现细节）
    this.ctx = {
      opsScript: options.opsScript,
      findGodot: options.findGodot,
      get runningProcess() { return ps.getRunningProcess(); },
      setRunningProcess(proc: ChildProcess | null, skipBusyCheck?: boolean) { ps.setRunningProcess(proc, skipBusyCheck); },
      get outputBuffer() { return ps.getOutputBuffer(); },
      setOutputBuffer(buf: string[]) { ps.setOutputBuffer(buf); },
      get processStartTime() { return ps.getProcessStartTime(); },
      setProcessStartTime(t: number) { ps.setProcessStartTime(t); },
      get projectDir() { return ps.getProjectDir(); },
      setProjectDir(d: string) { ps.setProjectDir(d); },
      parseGodotConfig,
    };

    // 注册内联工具的元数据（confirm_and_execute 不属于任何 ToolModule）
    registerInlineTool('confirm_and_execute', { readonly: true, long_running: false });

    // Health monitor for middleware pipeline
    this.healthMonitor = new HealthMonitor();
    this.middleware = this.buildMiddleware();

    // Phase 3a: Wire proxy delegate through handleCall for full middleware chain
    // (ReadOnlyGuard, path validation, confirmation tokens, etc.)
    this.options.toolCallDelegate(async (targetTool, toolArgs) => {
      // Recursion guard: proxy must not delegate to itself
      if (targetTool === 'godot_advanced_tool') {
        return opsErrorResult('PROXY_RECURSION', 'Cannot proxy godot_advanced_tool through itself');
      }
      return this.handleCall({ params: { name: targetTool, arguments: toolArgs } });
    });
  }

  getHealthMonitor(): HealthMonitor {
    return this.healthMonitor;
  }

  getFilteredTools(): Tool[] {
    let allTools = getAllToolDefinitions();

    // 内联工具: confirm_and_execute
    allTools.push({
      name: 'confirm_and_execute',
      description: 'Execute a previously blocked tool using a confirmation token. Use this when a tool returns a confirmation_token.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          token: { type: 'string', description: 'Confirmation token from the blocked tool response' },
        },
        required: ['token'],
      },
    });

    // READ_ONLY_MODE 过滤
    if (this.options.readOnly) {
      allTools = allTools.filter(t => !this.readOnlyGuard.check(t.name).blocked);
      log('READ_ONLY_MODE: %d tools available', allTools.length);
    }

    // LITE / MINIMAL / PROFILE 模式过滤
    if (this.options.mode === 'lite') {
      allTools = allTools.filter(t => LITE_TOOLS.has(t.name));
      log('LITE mode: %d tools available', allTools.length);
    } else if (this.options.mode === 'minimal') {
      allTools = allTools.filter(t => MINIMAL_TOOLS.has(t.name));
      log('MINIMAL mode: %d tools available', allTools.length);
    } else if (this.options.mode !== 'full') {
      // Profile mode: resolve profile name or comma-separated groups
      const profileTools = resolveProfile(this.options.mode);
      if (profileTools.size > 0) {
        allTools = allTools.filter(t => profileTools.has(t.name));
        log('PROFILE mode (%s): %d tools available', this.options.mode, allTools.length);
      } else {
        getLogger().warn('dispatcher', `Profile "${String(this.options.mode)}" resolved to empty set — falling back to full mode. Check for typos.`);
      }
    }

    // slim mode: ensure proxy tool is always present (it belongs to core group,
    // but guard against edge cases where filtering might exclude it)
    if (this.options.mode === 'slim') {
      const hasProxy = allTools.some(t => t.name === 'godot_advanced_tool');
      if (!hasProxy) {
        allTools.push(...getAllToolDefinitions().filter(t => t.name === 'godot_advanced_tool'));
      }
    }

    // activeGroups 过滤（Phase 1 动态管理）
    if (process.env.GODOT_MCP_TOOL_GROUPS !== 'false') {
      allTools = allTools.filter(t => isToolAllowed(t.name));
      log('activeGroups filter: %d tools available', allTools.length);
    }

    return allTools;
  }

  async handleCall(request: { params: { name: string; arguments?: Record<string, unknown> } }): Promise<ToolResult> {
    // Apply deferred mode switch before processing
    this._applyPendingModeSwitch();

    const { name, arguments: rawArgs } = request.params;
    const startTime = Date.now();
    const args = this.normalizeArgs(rawArgs);

    // 从 _meta 中提取 agent 身份标识
    const meta = (request as { params?: { _meta?: Record<string, unknown> } }).params?._meta;
    const agentId = (meta?.agentId ?? meta?.agent_id) as string | undefined;
    if (this.options.agentContext) {
      this.options.agentContext.getOrCreate(agentId);
    }

    const ctx: DispatchContext = { toolName: name, args, startTime, phase: 'before' };

    return executeMiddleware(this.middleware, ctx, async () => {
      return this.executeToolCall(name, args, startTime);
    });
  }

  private async executeToolCall(name: string, args: Record<string, unknown>, startTime: number): Promise<ToolResult> {
    // Snapshot current mode + executor for consistent routing throughout this call
    const currentMode = this.connectionMode;
    const currentExecutor = this.editorExecutor;

    try {
      // ── 0.5. Default project_path injection ──
      if (!args.project_path && !skipProjectPath(name)) {
        const resolved = resolveProjectPath();
        if (!resolved) {
          return opsErrorResult(
            COMMON_ERROR_CODES.INVALID_PARAMS,
            'project_path is required but not provided, and no default could be resolved. ' +
            'Set GODOT_PROJECT_PATH env var, run from a Godot project directory, or pass project_path explicitly.',
          );
        }
        args.project_path = resolved;
      }

      // ── 0.6. Project-aware findGodot injection ──
      // C-CONC-1: findGodot override 作为局部变量,沿调用链显式传入 dispatchTool。
      // 不能用实例字段 — MCP SDK 经 Promise.resolve().then(handler) 异步派发多个 tools/call,
      // 请求并发执行,实例字段会被互相覆盖(旧注释"MCP serializes so no race"为错误前提)。
      // CR-2: confirm_and_execute 分支须基于 pending.args(原始工具 args)重算,而非
      // confirm_and_execute 自身 args(只有 token)—— 见该分支内 resolveFindGodotOverride 调用。
      const { override: findGodotOverride, error: findGodotErr } = await this.resolveFindGodotOverride(args);
      if (findGodotErr) return findGodotErr;

      // ── 0. Common arg type validation ──
      const typeErr = this.validateCommonArgs(args);
      if (typeErr) return typeErr;

      // ── 1. ReadOnlyGuard ──
      const guardResult = this.readOnlyGuard.check(name);
      if (guardResult.blocked) {
        return opsErrorResult(String(guardResult.errorCode ?? 'READ_ONLY'), guardResult.message ?? 'Operation blocked in read-only mode');
      }

      // ── 1.5. Path allowlist validation (all modes) ──
      const pathErr = this.validatePathArgs(args);
      if (pathErr) return pathErr;

      // ── 2. confirm_and_execute 分支 ──
      if (name === 'confirm_and_execute') {
        const token = args.token as string;
        if (!token || typeof token !== 'string') {
          return opsErrorResult('MISSING_TOKEN', 'confirmation_token is required');
        }
        const pending = consumeToken(token);
        if (!pending) {
          return opsErrorResult('INVALID_TOKEN', 'Invalid or expired confirmation token');
        }

        // I-07: Refuse execution if args were truncated — the code/data would be incomplete
        if (pending.wasTruncated) {
          return opsErrorResult('ARGS_TRUNCATED',
            `Confirmation token args were truncated (exceeded 10KB limit). ` +
            `Please call the original tool again — the server will re-generate a fresh token with the full args.`);
        }

        // 二次 guard 检查
        const confirmedGuardResult = this.readOnlyGuard.check(pending.toolName);
        if (confirmedGuardResult.blocked) {
          return opsErrorResult(String(confirmedGuardResult.errorCode ?? 'READ_ONLY'), confirmedGuardResult.message ?? 'Operation blocked in read-only mode');
        }

        // 二次路径校验（pending.args 可能包含与外层 args 不同的 project_path）
        const confirmedPathErr = this.validatePathArgs(pending.args);
        if (confirmedPathErr) return confirmedPathErr;

        // CR-2: 基于 pending.args(原始工具 args)重新计算 findGodotOverride,而非复用入口处
        // 基于 confirm_and_execute 自身 args(只有 token)算出的 override。godot_path 校验
        // 在产生 token 的那次调用里已执行过(第 229-234 行),token 有 3min TTL + 单次消费
        // + 服务端生成,客户端无法伪造,故此处无需重新 validateGodotBinary。
        const { override: confirmedFindGodotOverride, error: confirmedFindGodotErr } =
          await this.resolveFindGodotOverride(pending.args);
        if (confirmedFindGodotErr) return confirmedFindGodotErr;

        // 复用同一 editor/headless 分支逻辑
        log('[CONFIRM] Executing confirmed tool: %s', pending.toolName);
        if (currentMode === 'editor' && currentExecutor) {
          const logger = getLogger();
          const confirmCallId = logger.toolStart(pending.toolName, pending.args);
          const editorResult = await currentExecutor.execute(pending.toolName, pending.args);
          const duration = Date.now() - startTime;
          logger.toolEnd(confirmCallId, pending.toolName, duration);
          // I-08: Only append _duration_ms if the editor plugin didn't already include it
          const hasDuration = editorResult.content?.some((c: { type?: string; text?: string }) =>
            typeof c.text === 'string' && c.text.startsWith('_duration_ms:'));
          const content = hasDuration
            ? editorResult.content
            : [...editorResult.content, { type: 'text' as const, text: `_duration_ms: ${duration}` }];
          return this.attachFallbackWarning({ ...editorResult, content });
        }
        return this.attachFallbackWarning(await this.dispatchTool(pending.toolName, pending.args, startTime, confirmedFindGodotOverride));
      }

      // ── 3. 确认令牌检查 ──
      if (requiresConfirmation(name, args)) {
        const token = createPendingToken(name, args);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              requires_confirmation: true,
              tool: name,
              confirmation_token: token,
              message: `Tool "${name}" requires confirmation. Call confirm_and_execute with this token to proceed.`,
              ttl_seconds: 180,
            }),
          }],
        };
      }

      // ── 4. editor 模式 dispatch ──
      if (currentMode === 'editor' && currentExecutor) {
        const logger = getLogger();
        const callId = logger.toolStart(name, args);
        const editorResult = await currentExecutor.execute(name, args);
        const duration = Date.now() - startTime;
        logger.toolEnd(callId, name, duration);
        // I-08: Only append _duration_ms if the editor plugin didn't already include it
        const hasDuration = editorResult.content?.some((c: { type?: string; text?: string }) =>
          typeof c.text === 'string' && c.text.startsWith('_duration_ms:'));
        const content = hasDuration
          ? editorResult.content
          : [...editorResult.content, { type: 'text' as const, text: `_duration_ms: ${duration}` }];
        return this.attachFallbackWarning({ ...editorResult, content });
      }

      // ── 5. headless dispatch ──
      // CR-1: 必须传入 findGodotOverride,否则 perCallCtx 回退到 this.ctx.findGodot,
      // 导致 godot_path 参数和项目感知 findGodot 在最常用路径失效。
      return this.attachFallbackWarning(await this.dispatchTool(name, args, startTime, findGodotOverride));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('Tool error:', name, msg);
      return opsErrorResult('TOOL_ERROR', msg);
    }
  }

  private buildMiddleware(): Middleware[] {
    const mw: Middleware[] = [];

    // Health sample middleware (after hook — runs on both success and failure)
    mw.push({
      name: 'healthSample',
      before: async () => ({ passed: true }),
      after: async (ctx, result) => {
        const duration = Date.now() - ctx.startTime;
        const isError = result.isError === true || this.checkJsonSuccessFalse(result);
        if (isError) {
          this.healthMonitor.recordFailure('TOOL_ERROR', `Tool ${ctx.toolName} failed`);
        } else {
          this.healthMonitor.recordSuccess(duration);
        }
        return result;
      },
    });

    // IMPORTANT-5: 全局 rate limit(防 AI 失控循环耗尽资源)。默认 60 次/秒软限。
    mw.push(createRateLimitMiddleware());

    return mw;
  }

  /** Schedule a connection mode change. Applied at the start of the next handleCall
   *  to prevent mid-request mode switches from editor disconnect callbacks (C-01). */
  setConnectionMode(mode: 'headless' | 'editor'): void {
    this._pendingModeSwitch = { mode, executor: this._resolvePendingExecutor() };
  }

  /** Schedule an executor change. Destroys the old executor immediately to release
   *  resources (WebSocket listeners, etc.), but defers the instance assignment to the
   *  next handleCall entry (C-01). This ensures a running handleCall keeps its snapshot
   *  executor reference stable throughout the async operation. */
  setEditorExecutor(executor: EditorToolExecutor | null): void {
    // Destroy old executor immediately — no point keeping dead listeners around
    const currentExec = this._resolvePendingExecutor();
    if (currentExec) {
      currentExec.destroy();
    }
    this._pendingModeSwitch = { mode: this.connectionMode, executor };
  }

  /** I-04: Atomically degrade to headless mode. Avoids two separate calls to
   *  setConnectionMode + setEditorExecutor racing on _pendingModeSwitch. */
  degradeToHeadless(): void {
    const currentExec = this._resolvePendingExecutor();
    if (currentExec) {
      currentExec.destroy();
    }
    this._pendingModeSwitch = { mode: 'headless', executor: null };
  }

  /** Get the effective executor: pending switch takes precedence over current instance. */
  private _resolvePendingExecutor(): EditorToolExecutor | null {
    return this._pendingModeSwitch?.executor ?? this.editorExecutor;
  }

  /** Apply any deferred mode switch. Called at the top of handleCall, outside of any await. */
  private _applyPendingModeSwitch(): void {
    if (this._pendingModeSwitch) {
      this.connectionMode = this._pendingModeSwitch.mode;
      this.editorExecutor = this._pendingModeSwitch.executor;
      this._pendingModeSwitch = null;
    }
  }

  /** 标记 editor fallback 状态（由 GodotServer.run() 调用） */
  markEditorFallback(): void {
    this._editorFallback = true;
  }

  /** I-05: Convert camelCase arg keys to snake_case, recursively for nested plain objects. */
  private static readonly MAX_NORMALIZE_DEPTH = 5;
  private normalizeArgs(rawArgs: Record<string, unknown> | undefined, depth = 0): Record<string, unknown> {
    if (!rawArgs || depth > ToolDispatcher.MAX_NORMALIZE_DEPTH) {
      // I-04: Warn when recursion limit is hit — nested params won't get snake_case conversion
      if (rawArgs && depth > ToolDispatcher.MAX_NORMALIZE_DEPTH) log(`normalizeArgs: depth limit (${ToolDispatcher.MAX_NORMALIZE_DEPTH}) reached, keys beyond this depth won't be converted`);
      return rawArgs ?? {};
    }
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawArgs)) {
      const snake = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
      // Recursively normalize nested plain objects (e.g. layout/flex params in UI tools)
      // A-16: Skip class instances (Error, etc.) — only recurse into plain objects
      if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
          && Object.getPrototypeOf(value) === Object.prototype) {
        args[snake] = this.normalizeArgs(value as Record<string, unknown>, depth + 1);
      } else {
        args[snake] = value;
      }
    }
    return args;
  }

  /** Validate common arg types (project_path, action). Returns error ToolResult or null. */
  private validateCommonArgs(args: Record<string, unknown>): ToolResult | null {
    if ('project_path' in args) {
      const v = args.project_path;
      if (typeof v !== 'string' || v.trim() === '') {
        return opsErrorResult(
          COMMON_ERROR_CODES.INVALID_PARAMS,
          `project_path must be a non-empty string, got: ${typeof v === 'string' ? '""' : JSON.stringify(v)}`,
        );
      }
    }
    if ('action' in args) {
      const v = args.action;
      if (typeof v !== 'string' || v.trim() === '') {
        return opsErrorResult(
          COMMON_ERROR_CODES.INVALID_PARAMS,
          `action must be a non-empty string, got: ${typeof v === 'string' ? '""' : JSON.stringify(v)}`,
        );
      }
    }
    return null;
  }

  /**
   * A-10 (advisory): 仅校验根级路径字段(project_path/search_dir)是否在 ALLOWED_PROJECT_PATHS。
   * 其余路径参数(file_path/script_path/scene_path 等)语义多样(res://、项目内相对、绝对路径),
   * 由各工具自行调 resolveWithinRoot 校验——**新增工具须确保其路径参数经过 resolveWithinRoot**,
   * 否则绕过根限制。未做通用扩展因 file_path 等字段语义不一,通用 isPathInAllowedRoots 会误伤。
   */
  private validatePathArgs(args: Record<string, unknown>): ToolResult | null {
    if (typeof args.project_path === 'string' && !isPathInAllowedRoots(args.project_path)) {
      return opsErrorResult('PATH_NOT_ALLOWED', `Path not in ALLOWED_PROJECT_PATHS: ${args.project_path}. Check your ALLOWED_PROJECT_PATHS setting.`);
    }
    if (typeof args.search_dir === 'string' && !isPathInAllowedRoots(args.search_dir)) {
      return opsErrorResult('PATH_NOT_ALLOWED', `Search directory not in ALLOWED_PROJECT_PATHS: ${args.search_dir}. Check your ALLOWED_PROJECT_PATHS setting.`);
    }
    return null;
  }

  /**
   * CR-1/CR-2: 基于 args 计算本次调用的 findGodot override。
   * - 有 godot_path → 校验绝对路径 + Godot 二进制后返回固定值
   * - 无 godot_path → 返回项目感知 findGodot(基于 project_path)
   * 抽取为独立方法以便 executeToolCall 入口和 confirm_and_execute 分支
   * (后者须基于 pending.args 而非 confirm_and_execute 自身 args)各自调用。
   */
  private async resolveFindGodotOverride(
    args: Record<string, unknown>,
  ): Promise<{ override: ((projectPath?: string) => Promise<string>) | undefined; error: ToolResult | null }> {
    const godotOverride = typeof args.godot_path === 'string' ? args.godot_path.trim() : undefined;
    const projectPathForGodot = typeof args.project_path === 'string' ? args.project_path : undefined;
    if (godotOverride) {
      // H-02: Validate godot_path is an absolute path (security — prevent relative path tricks)
      // Absolute paths on Windows start with drive letter (C:\), on POSIX with /
      const isAbsolute = godotOverride.startsWith('/') || /^[A-Za-z]:[\\/]/.test(godotOverride);
      if (!isAbsolute) {
        return {
          override: undefined,
          error: opsErrorResult('INVALID_PARAMS', `godot_path must be an absolute path, got: "${godotOverride}"`),
        };
      }
      // H-01: Validate the binary is actually Godot before allowing override
      const { validateGodotBinary } = await import('../core/godot-finder.js');
      if (!(await validateGodotBinary(godotOverride))) {
        return {
          override: undefined,
          error: opsErrorResult('INVALID_PARAMS', `godot_path failed validation (not a valid Godot binary): ${godotOverride}`),
        };
      }
      return { override: () => Promise.resolve(godotOverride), error: null };
    }
    // Project-aware findGodot — uses .godot/mcp-godot.json, project.godot [godot_mcp], etc.
    return { override: () => this.options.findGodot(projectPathForGodot), error: null };
  }

  private async dispatchTool(toolName: string, args: Record<string, unknown>, startTime: number, findGodotOverride?: ((projectPath?: string) => Promise<string>)): Promise<ToolResult> {
    let targetMod = getModuleForTool(toolName);
    let effectiveToolName = toolName;
    let effectiveArgs = args;

    // ── Legacy fallback: 旧工具名 → 新 (tool, action) ──
    if (!targetMod) {
      const legacy = tryLegacyMapping(toolName);
      if (legacy) {
        effectiveToolName = legacy.tool;
        effectiveArgs = { ...args, action: legacy.action };
        targetMod = getModuleForTool(effectiveToolName);
      }
    }

    if (!targetMod) {
      return opsErrorResult('UNKNOWN_TOOL', `Unknown tool: ${toolName}`);
    }

    const logger = getLogger();
    const callId = logger.toolStart(effectiveToolName, effectiveArgs);

    let result: ToolResult | null;
    try {
      // C-CONC-1: per-call findGodot 经参数传入(局部变量),避免实例字段被并发请求覆盖
      const perCallCtx = { ...this.ctx, findGodot: findGodotOverride ?? this.ctx.findGodot };
      result = await targetMod.handleTool(effectiveToolName, effectiveArgs, perCallCtx);
    } catch (err) {
      const duration = Date.now() - startTime;
      logger.toolEnd(callId, effectiveToolName, duration, err instanceof Error ? err.message : String(err));
      throw err;
    }

    const duration = Date.now() - startTime;

    if (result !== null) {
      // 判断是否有错误（使用 MCP 标准的 isError 字段）
      const hasError = result.isError === true;
      logger.toolEnd(callId, effectiveToolName, duration, hasError ? 'tool_error' : undefined);
      return truncateResponse({ ...result, content: [...result.content, { type: 'text' as const, text: `_duration_ms: ${duration}` }] });
    }
    logger.toolEnd(callId, effectiveToolName, duration, 'handler_null');
    return opsErrorResult('HANDLER_NULL', `Tool "${effectiveToolName}" registered but handler returned null`);
  }

  private attachFallbackWarning(result: ToolResult): ToolResult {
    if (this._editorFallback && !this._editorFallbackWarned) {
      this._editorFallbackWarned = true;
      const first = result.content?.[0];
      if (first?.type === 'text') {
        // H-04: Create new content array and text block instead of mutating original
        return {
          ...result,
          content: [
            { type: 'text' as const, text: first.text + '\n\n⚠️ [EDITOR_FALLBACK] Running in Headless mode — Editor features (UndoRedo, live scene sync) unavailable.' },
            ...result.content.slice(1),
          ],
        };
      }
    }
    return result;
  }

  /** Parse content blocks as JSON and check for success === false. */
  private checkJsonSuccessFalse(result: ToolResult): boolean {
    if (!result.content) return false;
    for (const block of result.content) {
      if ("text" in block && typeof block.text === "string") {
        try {
          const parsed = JSON.parse(block.text);
          if (parsed && typeof parsed === "object" && parsed.success === false) return true;
        } catch { /* not JSON */ }
      }
    }
    return false;
  }
}
