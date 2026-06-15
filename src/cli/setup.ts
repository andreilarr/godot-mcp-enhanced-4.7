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

  // IMPORTANT-7: 原路径段启发式(npm pack 解压临时目录、CI 本地 node_modules)会误判为全局安装。
  // 改进:优先 npm_config_global 强信号;路径段匹配时排除 npm pack 的隐藏临时段(.package/.staging 等)。
  const pathSegments = entryPath.replace(/\\/g, '/').split('/');
  const hasTempSegment = pathSegments.some(seg => seg.startsWith('.') && seg !== '.');
  const inGlobalNodeModules = (process.env.npm_config_global === 'true' ||
      (pathSegments.includes('node_modules') && pathSegments.includes('godot-mcp-enhanced'))) &&
    !hasTempSegment;

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
