/** doctor 命令 — 环境诊断 */
import { existsSync } from 'fs';
import { join } from 'path';
import { findGodot } from '../core/godot-finder.js';
import { ClaudeCodeAdapter } from './clients/claude-code.js';
import { CursorAdapter } from './clients/cursor.js';
import { OpenCodeAdapter } from './clients/opencode.js';
import { CodexAdapter } from './clients/codex.js';
import type { ClientAdapter } from './clients/types.js';

const ALL_ADAPTERS: ClientAdapter[] = [
  new ClaudeCodeAdapter(),
  new CursorAdapter(),
  new OpenCodeAdapter(),
  new CodexAdapter(),
];

function status(ok: boolean, msg: string): string {
  return ok ? `  ✓ ${msg}` : `  ✗ ${msg}`;
}

export async function runDoctor(_args: string[]): Promise<void> {
  let hasError = false;

  // 1. Node.js 版本
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0], 10);
  console.log(status(nodeMajor >= 18, `Node.js ${nodeVersion}${nodeMajor >= 18 ? '' : ' (requires >= 18)'}`));
  if (nodeMajor < 18) hasError = true;

  // 2. Godot 发现
  try {
    const godotPath = await findGodot();
    console.log(status(true, `Godot found: ${godotPath}`));
  } catch {
    console.log(status(false, 'Godot not found (set GODOT_PATH)'));
    hasError = true;
  }

  // 3. AI 客户端
  console.log('\nAI Clients:');
  const projectDir = process.cwd();
  for (const adapter of ALL_ADAPTERS) {
    const installed = await adapter.detect();
    if (!installed) {
      console.log(status(false, `${adapter.name}: not installed`));
      continue;
    }
    const configured = await adapter.isConfigured(projectDir);
    console.log(status(configured, `${adapter.name}: ${configured ? 'configured' : 'not configured'}`));
  }

  // 4. 项目结构
  console.log('\nProject:');
  const hasProject = existsSync(join(projectDir, 'project.godot'));
  console.log(status(hasProject, `project.godot ${hasProject ? 'found' : 'not found'}`));

  const hasClaudeMd = existsSync(join(projectDir, 'CLAUDE.md'));
  console.log(status(hasClaudeMd, `CLAUDE.md ${hasClaudeMd ? 'found' : 'not found'}`));

  if (hasError) process.exit(1);
}
