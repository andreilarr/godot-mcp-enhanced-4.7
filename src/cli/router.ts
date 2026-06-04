import type { ClientAdapter } from './clients/types.js';

const SUBCOMMANDS = ['setup', 'doctor', 'init', 'dashboard'] as const;
export type Subcommand = typeof SUBCOMMANDS[number];

export function parseSubcommand(args: string[]): { subcommand: Subcommand; rest: string[] } | null {
  if (args.length === 0) return null;
  const first = args[0];
  if ((SUBCOMMANDS as readonly string[]).includes(first)) {
    return { subcommand: first as Subcommand, rest: args.slice(1) };
  }
  return null;
}

export async function routeCommand(args: string[]): Promise<void> {
  const parsed = parseSubcommand(args);
  if (!parsed) {
    console.error(`Unknown command: ${args[0]}`);
    console.error('Run "godot-mcp-enhanced --help" for usage.');
    process.exit(1);
  }

  switch (parsed.subcommand) {
    case 'setup': {
      const { runSetup } = await import('./setup.js');
      await runSetup(parsed.rest);
      break;
    }
    case 'doctor': {
      const { runDoctor } = await import('./doctor.js');
      await runDoctor(parsed.rest);
      break;
    }
    case 'init': {
      const { runInit } = await import('./init.js');
      await runInit(parsed.rest);
      break;
    }
    case 'dashboard': {
      const { launchDashboardOnce } = await import('../dashboard/launcher.js');
      launchDashboardOnce();
      console.log('Dashboard starting... (use the separate terminal window)');
      process.exit(0);
    }
  }
}

export function isCliInvocation(args: string[]): boolean {
  if (args.length === 0) return false;
  const first = args[0];
  if (first.startsWith('-')) {
    // --help / --version 走 CLI
    if (first === '--help' || first === '-h' || first === '--version' || first === '-v') return true;
    // --profile=xxx 等 MCP flags 不走 CLI
    return false;
  }
  // 子命令走 CLI
  return (SUBCOMMANDS as readonly string[]).includes(first);
}

export function showHelp(): void {
  console.log(`
godot-mcp-enhanced — Godot AI 开发环境

用法:
  godot-mcp-enhanced                  启动 MCP 服务器（stdio 模式）
  godot-mcp-enhanced setup            一键配置 AI 客户端
  godot-mcp-enhanced doctor           环境诊断
  godot-mcp-enhanced init <name>      创建 Godot 项目
  godot-mcp-enhanced dashboard        启动监控面板

MCP 参数:
  --profile=<name>  工具 profile (full/minimal/lite)
  --minimal         最小工具集
  --lite            轻量工具集
  --help, -h        显示帮助
  --version, -v     显示版本
`);
}

export function showVersion(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pkg = require('../../package.json');
  console.log(`godot-mcp-enhanced v${pkg.version}`);
}
