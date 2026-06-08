import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { waitForEditorSecret } from './core/editor-auth.js';
import {
  listResources as listMcpResources,
  listResourceTemplates as listMcpResourceTemplates,
  readResource as readMcpResource,
} from './resources.js';
import { listPrompts, getPrompt } from './prompts.js';

// ─── Import and register tool modules ────────────────────────────────────────
// C-ARCH-01: All tool modules centralized in module-loader.ts
import { registerAllModules } from './core/module-loader.js';
registerAllModules();


import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pkgVersion = require('../package.json').version;
import { ReadOnlyGuard } from './core/ReadOnlyGuard.js';
import { ToolDispatcher } from './core/ToolDispatcher.js';
import { EditorConnection } from './core/EditorConnection.js';
import { EditorToolExecutor } from './core/EditorToolExecutor.js';
import { findGodot, clearGodotPathCache, getCachedGodotPath } from './core/godot-finder.js';
import { setOnGroupsChanged } from './tools/manage-tools.js';
import { InstanceManager } from './core/instance-manager.js';
import { InstanceRouter } from './core/instance-router.js';
import { setInstanceManager, setInstanceRouter } from './tools/instance-tools.js';
import { isFeatureEnabled } from './core/feature-flags.js';
import * as ps from './core/process-state.js';
import { killProcess } from './core/process-state.js';
import { getLogger } from './core/logger.js';

// Re-export for backward compatibility (tests import from GodotServer)
export { clearGodotPathCache, getCachedGodotPath };

const DEBUG = process.env.DEBUG === 'true';
const EDITOR_SECRET_TIMEOUT_MS = 5000;

function log(...args: unknown[]): void {
  if (DEBUG) getLogger().debug('godot-mcp', args.map(a => String(a)).join(' '));
}

// ─── GodotServer class ───────────────────────────────────────────────────────

// ─── Server options ───────────────────────────────────────────────────────────

export interface ServerOptions {
  mode?: string;
  connectionMode?: 'headless' | 'editor';
  readOnly?: boolean;
  noFallback?: boolean;
}

export class GodotServer {
  private server: Server;
  private opsScript: string;
  private options: ServerOptions;
  private readOnlyGuard: ReadOnlyGuard;
  private dispatcher: ToolDispatcher | null = null;
  private editorConn: EditorConnection | null = null;
  private editorExecutor: EditorToolExecutor | null = null;
  private connectionMode: 'headless' | 'editor';
  private noFallback: boolean;

  constructor(opsScript: string, options: ServerOptions = {}) {
    this.opsScript = opsScript;
    this.options = options;
    this.readOnlyGuard = new ReadOnlyGuard(options.readOnly ?? false);
    this.connectionMode = options.connectionMode ?? 'headless';
    this.noFallback = options.noFallback ?? false;
    this.server = new Server(
      { name: 'godot-mcp-enhanced', version: pkgVersion },
      { capabilities: { tools: {}, resources: {}, prompts: {} } }
    );
    this.setupHandlers();
  }

  private setupHandlers(): void {
    const dispatcher = new ToolDispatcher({
      readOnly: this.options.readOnly ?? false,
      mode: this.options.mode ?? 'full',
      readOnlyGuard: this.readOnlyGuard,
      connectionMode: this.connectionMode,
      noFallback: this.noFallback,
      opsScript: this.opsScript,
      findGodot,
    });
    this.dispatcher = dispatcher;

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: dispatcher.getFilteredTools(),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, (request) =>
      dispatcher.handleCall(request)
    );

    // ── MCP Resources handlers ──────────────────────────────────────────────
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const projectPath = this.detectProjectPath();
      const resources = listMcpResources(projectPath);
      return { resources };
    });

    this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      const templates = listMcpResourceTemplates();
      return { resourceTemplates: templates };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      const projectPath = this.detectProjectPath();
      const content = await readMcpResource(uri, projectPath);
      return { contents: [content] };
    });

    // Connect manage-tools notification callback
    setOnGroupsChanged(() => this.sendToolListChanged());

    // ── MCP Prompts handlers (Phase 5b) ────────────────────────────────────────
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: listPrompts(),
    }));

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: promptArgs } = request.params;
      return getPrompt(name, (promptArgs ?? {}) as Record<string, string>);
    });

    // Phase 2b: Multi-instance initialization (gated by feature flag)
    if (isFeatureEnabled('MULTI_INSTANCE')) {
      const projectDir = ps.getProjectDir();
      const manager = new InstanceManager({
        projectRegistryDir: projectDir
          ? join(projectDir, '.godot', 'mcp-instances')
          : undefined,
      });
      const router = new InstanceRouter({
        instances: manager.loadFromRegistry(),
        sendToInstance: async () => ({
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Direct bridge routing not yet implemented' }) }],
        }),
      });
      setInstanceManager(manager);
      setInstanceRouter(router);
      getLogger().info('instance', 'Multi-instance mode enabled');
    }
  }

  /** Send tools/list_changed notification to client. Called when active groups change. */
  sendToolListChanged(): void {
    this.server.notification({
      method: 'notifications/tools/list_changed',
    });
  }

  // I-PERF-07: Cache detectProjectPath result (30s TTL — path rarely changes mid-session)
  private _cachedProjectPath: string | undefined;
  private _cachedProjectPathTime = 0;
  private static readonly CACHE_TTL_MS = 30_000;

  private detectProjectPath(): string | undefined {
    const now = Date.now();
    if (this._cachedProjectPathTime > 0 && now - this._cachedProjectPathTime < GodotServer.CACHE_TTL_MS) {
      return this._cachedProjectPath;
    }
    // Allow explicit override via environment variable
    const envPath = process.env.GODOT_PROJECT_PATH;
    if (envPath) {
      if (existsSync(join(envPath, 'project.godot'))) {
        this._cachedProjectPath = envPath;
        this._cachedProjectPathTime = now;
        return envPath;
      }
      getLogger().warn('godot-mcp', `GODOT_PROJECT_PATH="${envPath}" does not contain project.godot, ignoring`);
    }
    // I-06: 增加上限到 30 层 + 添加诊断日志帮助用户定位
    let dir = process.cwd();
    const searchedPaths: string[] = [];
    for (let i = 0; i < 30; i++) {
      if (existsSync(join(dir, 'project.godot'))) {
        this._cachedProjectPath = dir;
        this._cachedProjectPathTime = now;
        return dir;
      }
      searchedPaths.push(dir);
      const parent = join(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
    getLogger().warn('godot-mcp', `detectProjectPath: no project.godot found. Searched: ${searchedPaths.join(' → ')}`);
    this._cachedProjectPath = undefined;
    this._cachedProjectPathTime = now;
    return undefined;
  }

  // ─── Run ───────────────────────────────────────────────────────────────────

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    log('Godot MCP Enhanced server running on stdio');

    // Phase 5d: Project context notification
    setImmediate(() => {
      try {
        this.server.notification({
          method: 'notifications/message',
          params: {
            level: 'info',
            data: '[Godot MCP] Project context available at godot://project-context. Read it for coding guidelines and architecture notes.',
          },
        });
      } catch { /* best-effort */ }
    });

    if (this.connectionMode === 'editor') {
      const port = parseInt(process.env.GODOT_EDITOR_PORT ?? '9090', 10);
      const projectPath = this.detectProjectPath();
      let secret: string | undefined;
      if (projectPath) {
        secret = (await waitForEditorSecret(projectPath, EDITOR_SECRET_TIMEOUT_MS)) ?? undefined;
      }
      if (!secret) {
        getLogger().warn('auth', 'No editor secret found — plugin may not be running');
        if (this.noFallback) {
          getLogger().error('auth', 'Editor auth required but no secret available. Install the editor plugin.');
          // I-CQ-01: Graceful cleanup before exit
          getLogger().close();
          process.exit(1);
        }
        getLogger().warn('godot-mcp', 'Running in Headless mode (no editor auth).');
        this.dispatcher?.markEditorFallback();
        this.connectionMode = 'headless';
        this.dispatcher?.setConnectionMode('headless');
      } else {
        this.editorConn = new EditorConnection({ port, reconnect: true, secret });
        try {
          await this.editorConn.connect();
          this.editorExecutor = new EditorToolExecutor(this.editorConn);
          this.dispatcher?.setEditorExecutor(this.editorExecutor);
          // I-04: Use dedicated reconnect-exhausted handler instead of disconnect handler.
          // The disconnect handler fires on every ws.close (including between reconnect attempts),
          // which would prematurely degrade to headless. This handler only fires when all retries fail.
          this.editorConn.addOnReconnectExhaustedHandler(() => {
            getLogger().warn('godot-mcp', 'Editor reconnect attempts exhausted — degrading to headless mode.');
            this.dispatcher?.markEditorFallback();
            this.connectionMode = 'headless';
            // I-04: Use atomic degradeToHeadless() to avoid two separate _pendingModeSwitch writes racing
            this.dispatcher?.degradeToHeadless();
            this.editorConn = null;
          });
          log('Editor: Connected to Godot plugin on port %d', port);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (this.noFallback) {
            getLogger().error('auth', `Editor mode required but connection failed: ${msg}`);
            getLogger().error('auth', 'Set GODOT_MCP_NO_FALLBACK=false to allow fallback, or install the plugin.');
            process.exit(1);
          }
          getLogger().warn('godot-mcp', `Editor connection failed: ${msg}.`);
          getLogger().warn('godot-mcp', 'Running in Headless mode. UndoRedo disabled, no scene state persistence.');
          this.dispatcher?.markEditorFallback();
          this.connectionMode = 'headless';
          this.dispatcher?.setConnectionMode('headless');
          this.editorConn = null;
        }
      }
    }
  }

  async close(): Promise<void> {
    if (this.editorConn) {
      this.editorConn.disconnect();
      this.editorConn = null;
      this.dispatcher?.setEditorExecutor(null);
      log('Editor connection closed');
    }
    const proc = ps.getRunningProcess();
    if (proc && !proc.killed) {
      await killProcess(proc);
      ps.setProcessBusy(false);
      ps.setRunningProcess(null);
      log('Running Godot process killed');
    }
    await this.server.close();
    setOnGroupsChanged(null);
    log('Server shut down');
  }
}
