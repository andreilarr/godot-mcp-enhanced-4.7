import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ClientAdapter } from './types.js';

const execFileAsync = promisify(execFile);

export class CodexAdapter implements ClientAdapter {
  name = 'Codex';

  async detect(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('codex', ['--version'], { timeout: 5000 });
      return stdout.length > 0;
    } catch { return false; }
  }

  async isConfigured(_projectDir: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('codex', ['mcp', 'list'], { timeout: 5000 });
      return stdout.includes('godot');
    } catch { return false; }
  }

  async configure(_projectDir: string, godotPath: string, mcpCommand: string, mcpArgs: string[]): Promise<void> {
    // 分别传递 command 和 args，避免字符串拼接注入风险
    await execFileAsync('codex', [
      'mcp', 'add', 'godot',
      '--command', mcpCommand,
      ...(mcpArgs.length > 0 ? ['--args', ...mcpArgs] : []),
      '--env', `GODOT_PATH=${godotPath}`,
    ], { timeout: 10000 });
  }
}
