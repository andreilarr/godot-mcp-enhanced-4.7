#!/usr/bin/env node
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { GodotServer } from './GodotServer.js';
import { getLogger } from './core/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function startMcpServer(args: string[]): Promise<void> {
  // H-08: Reject security bypass flags in production unless explicitly acknowledged
  const dangerousBypassFlags = [
    'GODOT_MCP_DISABLE_SAFETY',
    'GODOT_MCP_UNRESTRICTED',
    'GODOT_MCP_SANDBOX',
  ];
  const isDev = process.env.NODE_ENV === 'development' || process.env.GODOT_MCP_ALLOW_UNSAFE === 'true';

  if (!isDev) {
    for (const flag of dangerousBypassFlags) {
      if (process.env[flag] !== undefined) {
        console.error(`[FATAL] ${flag} is set but NODE_ENV is not "development". ` +
          `Set NODE_ENV=development or GODOT_MCP_ALLOW_UNSAFE=true to acknowledge the risk. Exiting.`);
        process.exit(1);
      }
    }
  }

  // I-05: Warn loudly when security bypass flags are active
  const securityBypassFlags = [
    'GODOT_MCP_UNRESTRICTED',
    'GODOT_MCP_SANDBOX',
    'GODOT_MCP_ALLOW_UNSAFE',
    'GODOT_MCP_DISABLE_SAFETY',
  ];
  for (const flag of securityBypassFlags) {
    const val = process.env[flag];
    if (val !== undefined) {
      const logger = getLogger();
      logger.error('security', `Security bypass flag ${flag}=${val} is ACTIVE — this disables safety checks`);
    }
  }

  // C-08: Path access is deny-by-default (restricted to cwd) when ALLOWED_PROJECT_PATHS unset — see path-utils.ts isPathInAllowedRoots
  if (!process.env.ALLOWED_PROJECT_PATHS && !process.env.GODOT_MCP_UNRESTRICTED) {
    const logger = getLogger();
    logger.info('security', 'ALLOWED_PROJECT_PATHS is not set — access restricted to the current working directory (deny-by-default). ' +
      'Set ALLOWED_PROJECT_PATHS=/path1;/path2 for explicit multi-project access.');
  }

  // Feature flags info
  const { getAllFeatureFlags } = await import('./core/feature-flags.js');
  const flags = getAllFeatureFlags();
  const disabledFeatures = Object.entries(flags).filter(([, v]) => !v).map(([k]) => k);
  if (disabledFeatures.length > 0) {
    getLogger().info('godot-mcp', `Features disabled: ${disabledFeatures.join(', ')}`);
  }

  // --profile=<name> or GODOT_MCP_PROFILE for fine-grained tool selection
  const profileArg = args.find(a => a.startsWith('--profile='));
  const profileFromArg = profileArg ? profileArg.split('=')[1] : null;
  const profileFromEnv = process.env.GODOT_MCP_PROFILE;

  const activeProfile = profileFromArg || profileFromEnv;

  const toolMode: string = activeProfile ?? (
    args.includes('--minimal') ? 'minimal'
    : args.includes('--lite') ? 'lite'
    : process.env.GODOT_MCP_MODE === 'minimal' ? 'minimal'
    : process.env.GODOT_MCP_MODE === 'lite' ? 'lite'
    : 'full'
  );

  const connectionMode = process.env.GODOT_MCP_MODE === 'editor' ? 'editor' : 'headless';
  const readOnly = process.env.GODOT_MCP_READ_ONLY === 'true' || process.env.READ_ONLY_MODE === 'true';
  const noFallback = process.env.GODOT_MCP_NO_FALLBACK === 'true';

  const server = new GodotServer(join(__dirname, 'scripts', 'godot_operations.gd'), {
    mode: toolMode,
    connectionMode,
    readOnly,
    noFallback,
  });

  let shuttingDown = false;
  async function gracefulShutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      // A-2: second signal forces immediate exit (first shutdown may be stuck in server.close)
      process.exit(1);
    }
    shuttingDown = true;
    const logger = getLogger();
    logger.info('godot-mcp', `Received ${signal}, shutting down...`);
    try {
      await server.close();    // 先关闭服务器（内部会记录 killProcess 等日志）
      logger.close();          // 最后 flush 缓冲区 + 关闭文件句柄
    } catch (err) {
      // logger 可能已关闭，用 console 兜底
      console.error(`Error during shutdown: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(0);
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  server.run().catch((error: unknown) => {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    getLogger().error('godot-mcp', 'Failed to run server', { error: msg });
    // I-CQ-01: Graceful cleanup before exit
    getLogger().close();
    process.exit(1);
  });

  // Auto-launch Dashboard TUI in a new terminal window
  import('./dashboard/launcher.js').then(({ launchDashboardOnce }) => {
    getLogger().info('godot-mcp', 'Auto-launching Dashboard TUI...');
    launchDashboardOnce();
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn('godot-mcp', `Dashboard auto-launch skipped: ${msg}`);
  });
}

// ── 入口分流 ──────────────────────────────────────────────
const args = process.argv.slice(2);

(async () => {
  const { isCliInvocation, showHelp, showVersion, routeCommand } = await import('./cli/router.js');

  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }
  if (args.includes('--version') || args.includes('-v')) {
    await showVersion();
    process.exit(0);
  }
  if (isCliInvocation(args)) {
    await routeCommand(args);
    process.exit(0);
  }

  // 默认: MCP stdio 模式
  await startMcpServer(args);
})();
