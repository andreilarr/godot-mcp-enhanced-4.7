import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import type { ClientAdapter } from './types.js';

export class ClaudeCodeAdapter implements ClientAdapter {
  name = 'Claude Code';

  async detect(): Promise<boolean> {
    return existsSync(join(homedir(), '.claude'));
  }

  async isConfigured(projectDir: string): Promise<boolean> {
    const settingsPath = join(projectDir, '.claude', 'settings.json');
    if (!existsSync(settingsPath)) return false;
    try {
      const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      return !!(content.mcpServers?.godot);
    } catch { return false; }
  }

  async configure(projectDir: string, godotPath: string, mcpCommand: string, mcpArgs: string[]): Promise<void> {
    const claudeDir = join(projectDir, '.claude');
    const settingsPath = join(claudeDir, 'settings.json');
    if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch { /* ignore */ }
    }
    if (!settings.mcpServers) settings.mcpServers = {};
    (settings.mcpServers as Record<string, unknown>).godot = {
      command: mcpCommand,
      ...(mcpArgs.length > 0 ? { args: mcpArgs } : {}),
      env: { GODOT_PATH: godotPath },
    };
    // 原子写入：先写临时文件再 rename，防止并发竞态
    const tmpPath = join(claudeDir, `.settings.${randomUUID()}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    renameSync(tmpPath, settingsPath);
  }
}
