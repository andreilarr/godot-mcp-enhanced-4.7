import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { ClientAdapter } from './types.js';

const execFileAsync = promisify(execFile);

export class OpenCodeAdapter implements ClientAdapter {
  name = 'OpenCode';

  async detect(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('opencode', ['--version'], { timeout: 5000 });
      return stdout.length > 0;
    } catch { return false; }
  }

  // IMPORTANT-6: opencode `mcp add` 是交互式 prompts(不接受 --command/--args/--env flag,
  // 见 sst/opencode packages/opencode/src/cli/cmd/mcp.ts 的 McpAddCommand —— 全程 prompts.text/select)。
  // 非交互式 execFile 调用会挂起超时。改为直接读/写 opencode.json 配置(与 cursor/claude-code 一致)。
  async isConfigured(projectDir: string): Promise<boolean> {
    const configPath = join(projectDir, 'opencode.json');
    if (!existsSync(configPath)) return false;
    try {
      const content = JSON.parse(readFileSync(configPath, 'utf-8'));
      return !!(content.mcp?.godot);
    } catch { return false; }
  }

  async configure(projectDir: string, godotPath: string, mcpCommand: string, mcpArgs: string[]): Promise<void> {
    const configPath = join(projectDir, 'opencode.json');
    let config: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try { config = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { /* ignore */ }
    }
    if (!config.mcp) config.mcp = {};
    // opencode local MCP 配置:command 数组 + environment 对象(见 mcp.ts local 分支)
    (config.mcp as Record<string, unknown>).godot = {
      type: 'local',
      command: [mcpCommand, ...mcpArgs],
      environment: { GODOT_PATH: godotPath },
    };
    // 原子写入:先写临时文件再 rename,防止并发竞态
    const tmpPath = join(projectDir, `.opencode.${randomUUID()}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    renameSync(tmpPath, configPath);
  }
}
