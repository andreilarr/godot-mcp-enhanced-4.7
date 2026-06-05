import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CursorAdapter } from '../../../src/cli/clients/cursor.js';

describe('CursorAdapter', () => {
  const adapter = new CursorAdapter();
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `mcp-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Windows ENOTEMPTY retry — file locks from concurrent processes may delay deletion
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        rmSync(testDir, { recursive: true, force: true });
        break;
      } catch {
        if (attempt < 2) { /* wait briefly before retry */ }
      }
    }
  });

  it('has correct name', () => {
    expect(adapter.name).toBe('Cursor');
  });

  it('isConfigured returns false when no mcp.json', async () => {
    expect(await adapter.isConfigured(testDir)).toBe(false);
  });

  it('configure creates .cursor/mcp.json with godot entry', async () => {
    await adapter.configure(testDir, '/godot', 'npx', ['godot-mcp-enhanced']);
    const mcpPath = join(testDir, '.cursor', 'mcp.json');
    expect(existsSync(mcpPath)).toBe(true);
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    expect(config.mcpServers.godot.command).toBe('npx');
    expect(config.mcpServers.godot.env.GODOT_PATH).toBe('/godot');
  });

  it('configure merges with existing config', async () => {
    const cursorDir = join(testDir, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(join(cursorDir, 'mcp.json'), JSON.stringify({
      mcpServers: { existing: { command: 'existing' } },
    }));
    await adapter.configure(testDir, '/godot', 'npx', ['godot-mcp-enhanced']);
    const config = JSON.parse(readFileSync(join(cursorDir, 'mcp.json'), 'utf-8'));
    expect(config.mcpServers.existing.command).toBe('existing');
    expect(config.mcpServers.godot.command).toBe('npx');
  });

  it('isConfigured returns true after configure', async () => {
    await adapter.configure(testDir, '/godot', 'npx', ['godot-mcp-enhanced']);
    expect(await adapter.isConfigured(testDir)).toBe(true);
  });
});
