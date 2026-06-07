import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { GodotServer } from './GodotServer.js';
import { getLogger } from './core/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function startMcpServer(args: string[]): Promise<void> {
  // I-05: Warn loudly when security bypass flags are active in production
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

  // --profile=<name> or GODOT_MCP_PROFILE for fine-grained tool selection
  const profileArg = args.find(a => a.startsWith('--profile='));
  const profileFromArg = profileArg ? profileArg.split('=')[1] : null;
  const profileFromEnv = process.env.GODOT_MCP_PROFILE;

  const activeProfile = profileFromArg || profileFromEnv;

  const toolMode = activeProfile ? activeProfile
    : args.includes('--minimal') ? 'minimal'
    : args.includes('--lite') ? 'lite'
    : process.env.GODOT_MCP_MODE === 'minimal' ? 'minimal'
    : process.env.GODOT_MCP_MODE === 'lite' ? 'lite'
    : 'full';

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
    if (shuttingDown) return;
    shuttingDown = true;
    const logger = getLogger();
    logger.info('godot-mcp', `Received ${signal}, shutting down...`);
    try {
      logger.close(); // flush 缓冲区 + 关闭文件句柄
      await server.close();
    } catch (err) {
      logger.error('godot-mcp', `Error during shutdown: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(0);
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  server.run().catch((error: unknown) => {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    getLogger().error('godot-mcp', 'Failed to run server', { error: msg });
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
