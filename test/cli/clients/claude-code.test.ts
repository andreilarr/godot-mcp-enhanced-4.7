import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ClaudeCodeAdapter } from '../../../src/cli/clients/claude-code.js';

describe('ClaudeCodeAdapter', () => {
  const adapter = new ClaudeCodeAdapter();
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `mcp-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('has correct name', () => {
    expect(adapter.name).toBe('Claude Code');
  });

  it('isConfigured returns false when no settings file', async () => {
    expect(await adapter.isConfigured(testDir)).toBe(false);
  });

  it('isConfigured returns false when no godot entry', async () => {
    const claudeDir = join(testDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ mcpServers: {} }));
    expect(await adapter.isConfigured(testDir)).toBe(false);
  });

  it('isConfigured returns true when godot entry exists', async () => {
    const claudeDir = join(testDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
      mcpServers: { godot: { command: 'npx', args: ['godot-mcp-enhanced'] } },
    }));
    expect(await adapter.isConfigured(testDir)).toBe(true);
  });

  it('configure creates settings file with godot entry', async () => {
    await adapter.configure(testDir, '/path/to/godot', 'npx', ['godot-mcp-enhanced']);
    const settingsPath = join(testDir, '.claude', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(settings.mcpServers.godot.command).toBe('npx');
    expect(settings.mcpServers.godot.env.GODOT_PATH).toBe('/path/to/godot');
  });

  it('configure merges with existing settings', async () => {
    const claudeDir = join(testDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
      otherSetting: true,
      mcpServers: { other: { command: 'other' } },
    }));
    await adapter.configure(testDir, '/godot', 'npx', ['godot-mcp-enhanced']);
    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'));
    expect(settings.otherSetting).toBe(true);
    expect(settings.mcpServers.other.command).toBe('other');
    expect(settings.mcpServers.godot.command).toBe('npx');
  });
});
