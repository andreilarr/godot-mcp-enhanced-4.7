/** setup 命令 — 一键配置 AI 客户端 */
import { join } from 'path';
import { findGodot } from '../core/godot-finder.js';
import { ALL_ADAPTERS } from './clients/index.js';
import { getErrorMessage } from '../types.js';

/** I-08: 检测 MCP command/args — 改进安装方式判断 */
function detectMcpCommand(): { command: string; args: string[] } {
  const entryPath = process.argv[1] ?? '';

  // 优先检查 npm_lifecycle_event 判断运行上下文
  const lifecycle = process.env.npm_lifecycle_event;
  if (lifecycle === 'postinstall' || lifecycle === 'preinstall') {
    return { command: 'npx', args: ['godot-mcp-enhanced'] };
  }

  // 检查是否在全局 node_modules 中（npm -g install）
  // 使用路径分段匹配而非子串包含，避免 npm link 误判
  const pathSegments = entryPath.replace(/\\/g, '/').split('/');
  const inGlobalNodeModules = pathSegments.includes('node_modules') &&
    pathSegments.includes('godot-mcp-enhanced');

  if (inGlobalNodeModules) {
    return { command: 'npx', args: ['godot-mcp-enhanced'] };
  }

  // 本地开发：用 node + 绝对路径
  const devEntry = join(import.meta.dirname ?? '.', '..', 'index.js');
  return { command: 'node', args: [devEntry] };
}

export async function runSetup(_args: string[]): Promise<void> {
  console.log('🔍 Detecting environment...\n');

  // 1. 发现 Godot
  let godotPath: string;
  try {
    godotPath = await findGodot();
    console.log(`✓ Godot found: ${godotPath}`);
  } catch (err) {
    console.error(`✗ Godot not found: ${getErrorMessage(err)}`);
    console.error('  Set GODOT_PATH environment variable or install Godot.');
    process.exit(1);
  }

  // 2. 检测 MCP 命令
  const { command, args: mcpArgs } = detectMcpCommand();

  // 3. 检测 + 配置各客户端
  const projectDir = process.cwd();
  console.log(`\n📁 Project: ${projectDir}\n`);

  let configured = 0;
  for (const adapter of ALL_ADAPTERS) {
    const installed = await adapter.detect();
    if (!installed) {
      console.log(`  ⊘ ${adapter.name}: not installed, skipping`);
      continue;
    }

    const already = await adapter.isConfigured(projectDir);
    if (already) {
      console.log(`  ✓ ${adapter.name}: already configured`);
      continue;
    }

    try {
      await adapter.configure(projectDir, godotPath, command, mcpArgs);
      console.log(`  ✓ ${adapter.name}: configured`);
      configured++;
    } catch (err) {
      console.error(`  ✗ ${adapter.name}: ${getErrorMessage(err)}`);
    }
  }

  console.log(`\n${configured > 0 ? `✓ ${configured} client(s) configured.` : 'No new clients to configure.'}`);
}
