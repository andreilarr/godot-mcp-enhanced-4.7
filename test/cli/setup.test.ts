import { describe, it, expect, vi } from 'vitest';

// Mock godot-finder
vi.mock('../../src/core/godot-finder.js', () => ({
  findGodot: vi.fn().mockResolvedValue('/usr/bin/godot'),
}));

// Mock all client adapters
vi.mock('../../src/cli/clients/claude-code.js', () => ({
  ClaudeCodeAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Claude Code';
    this.detect = vi.fn().mockResolvedValue(true);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('../../src/cli/clients/cursor.js', () => ({
  CursorAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Cursor';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('../../src/cli/clients/opencode.js', () => ({
  OpenCodeAdapter: vi.fn().mockImplementation(function () {
    this.name = 'OpenCode';
    this.detect = vi.fn().mockResolvedValue(true);
    this.isConfigured = vi.fn().mockResolvedValue(true);
    this.configure = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('../../src/cli/clients/codex.js', () => ({
  CodexAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Codex';
    this.detect = vi.fn().mockResolvedValue(false);
    this.isConfigured = vi.fn().mockResolvedValue(false);
    this.configure = vi.fn().mockResolvedValue(undefined);
  }),
}));

describe('setup', () => {
  it('runSetup completes without error', async () => {
    const { runSetup } = await import('../../src/cli/setup.js');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runSetup([]);
    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('Godot found');
    expect(output).toContain('Claude Code');
    consoleSpy.mockRestore();
    consoleError.mockRestore();
  });
});
