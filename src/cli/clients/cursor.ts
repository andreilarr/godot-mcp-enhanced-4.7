import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ClientAdapter } from './types.js';

export class CursorAdapter implements ClientAdapter {
  name = 'Cursor';

  async detect(): Promise<boolean> {
    return existsSync(join(homedir(), '.cursor'));
  }

  async isConfigured(projectDir: string): Promise<boolean> {
    const mcpPath = join(projectDir, '.cursor', 'mcp.json');
    if (!existsSync(mcpPath)) return false;
    try {
      const content = JSON.parse(readFileSync(mcpPath, 'utf-8'));
      return !!(content.mcpServers?.godot);
    } catch { return false; }
  }

  async configure(projectDir: string, godotPath: string, mcpCommand: string, mcpArgs: string[]): Promise<void> {
    const cursorDir = join(projectDir, '.cursor');
    const mcpPath = join(cursorDir, 'mcp.json');
    if (!existsSync(cursorDir)) mkdirSync(cursorDir, { recursive: true });
    let config: Record<string, unknown> = {};
    if (existsSync(mcpPath)) {
      try { config = JSON.parse(readFileSync(mcpPath, 'utf-8')); } catch { /* ignore */ }
    }
    if (!config.mcpServers) config.mcpServers = {};
    (config.mcpServers as Record<string, unknown>).godot = {
      command: mcpCommand,
      ...(mcpArgs.length > 0 ? { args: mcpArgs } : {}),
      env: { GODOT_PATH: godotPath },
    };
    writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  }
}
