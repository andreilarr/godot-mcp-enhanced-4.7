import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/core/godot-finder.js', () => ({
  findGodot: vi.fn().mockResolvedValue('/usr/bin/godot'),
}));

vi.mock('../../src/cli/clients/claude-code.js', () => ({
  ClaudeCodeAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Claude Code'; this.detect = vi.fn().mockResolvedValue(true); this.isConfigured = vi.fn().mockResolvedValue(true);
  }),
}));

vi.mock('../../src/cli/clients/cursor.js', () => ({
  CursorAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Cursor'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/opencode.js', () => ({
  OpenCodeAdapter: vi.fn().mockImplementation(function () {
    this.name = 'OpenCode'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

vi.mock('../../src/cli/clients/codex.js', () => ({
  CodexAdapter: vi.fn().mockImplementation(function () {
    this.name = 'Codex'; this.detect = vi.fn().mockResolvedValue(false); this.isConfigured = vi.fn().mockResolvedValue(false);
  }),
}));

describe('doctor', () => {
  it('runDoctor completes and reports Node version', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runDoctor([]);
    const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('Node.js');
    expect(output).toContain('Godot');
    consoleSpy.mockRestore();
  });
});
