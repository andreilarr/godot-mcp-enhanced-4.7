import { expect, vi } from 'vitest';
import { getToolDefinitions, handleTool, TOOL_META } from '../src/tools/game-bridge.js';

// ─── Tool definition tests ──────────────────────────────────────────────────

describe('game-bridge tool definitions', () => {
  const tools = getToolDefinitions();

  it('has 1 merged tool', () => {
    expect(tools.length).toBe(1);
  });

  it('tool name is "game"', () => {
    expect(tools[0].name).toBe('game');
  });

  it('tool has action enum with expected operations', () => {
    const actionEnum = tools[0].inputSchema.properties.action.enum;
    expect(actionEnum).toEqual([
      'game_bridge_install',
      'game_bridge_uninstall',
      'game_query',
      'game_write',
      'game_input',
      'game_wait',
      'monitor_start',
      'monitor_stop',
      'monitor_poll',
    ]);
  });

  it('tool has required inputSchema', () => {
    expect(tools[0].inputSchema).toBeTruthy();
    expect(tools[0].inputSchema.properties).toBeTruthy();
    expect(tools[0].inputSchema.required).toContain('project_path');
    expect(tools[0].inputSchema.required).toContain('action');
  });
});

// ─── TOOL_META tests ────────────────────────────────────────────────────────

describe('game-bridge TOOL_META', () => {
  it('has single entry for "game"', () => {
    expect(Object.keys(TOOL_META).length).toBe(1);
    expect(TOOL_META.game).toBeDefined();
  });

  it('game is not readonly', () => {
    expect(TOOL_META.game.readonly).toBe(false);
  });

  it('game is not long_running', () => {
    expect(TOOL_META.game.long_running).toBe(false);
  });
});

// ─── handleTool routing tests ────────────────────────────────────────────────

describe('game-bridge handleTool routing', () => {
  const mockCtx = { projectDir: '/tmp/test-project', opsScript: '/tmp/ops.gd' };

  it('returns null for unknown tool names', async () => {
    const result = await handleTool('unknown_tool', {}, mockCtx);
    expect(result).toBeNull();
  });

  it('rejects unknown method for game_query', async () => {
    const result = await handleTool('game', { action: 'game_query', method: 'send_key' }, mockCtx);
    expect(result).toBeTruthy();
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('Unknown method');
    expect(text).toContain('send_key');
  });

  it('rejects unknown method for game_write', async () => {
    const result = await handleTool('game', { action: 'game_write', method: 'ping' }, mockCtx);
    expect(result).toBeTruthy();
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('Unknown method');
  });

  it('rejects unknown method for game_input', async () => {
    const result = await handleTool('game', { action: 'game_input', method: 'ping', params: {} }, mockCtx);
    expect(result).toBeTruthy();
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('Unknown method');
  });

  it('rejects unknown method for game_wait', async () => {
    const result = await handleTool('game', { action: 'game_wait', method: 'ping', params: {} }, mockCtx);
    expect(result).toBeTruthy();
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('Unknown method');
  });

  it('game_query accepts only read methods', async () => {
    const readMethods = ['ping', 'get_tree', 'find_nodes', 'get_node_properties', 'get_performance', 'get_viewport_info', 'take_screenshot'];
    for (const method of readMethods) {
      const result = await handleTool('game', { action: 'game_query', method }, mockCtx);
      const text = result?.content?.[0]?.text ?? '';
      expect(text).not.toContain('Unknown method');
    }
  });

  it('game_write accepts only write methods', async () => {
    const writeMethods = ['set_node_property', 'call_method'];
    for (const method of writeMethods) {
      const result = await handleTool('game', { action: 'game_write', method, params: {} }, mockCtx);
      const text = result?.content?.[0]?.text ?? '';
      expect(text).not.toContain('Unknown method');
    }
  });

  it('game_query rejects write methods', async () => {
    const writeMethods = ['set_node_property', 'call_method'];
    for (const method of writeMethods) {
      const result = await handleTool('game', { action: 'game_query', method }, mockCtx);
      const text = result?.content?.[0]?.text ?? '';
      expect(text).toContain('Unknown method');
    }
  });

  it('returns ECONNREFUSED error when bridge is not running', async () => {
    const result = await handleTool('game', { action: 'game_query', method: 'ping' }, mockCtx);
    expect(result).toBeTruthy();
    const text = result.content?.[0]?.text ?? '';
    expect(text).toMatch(/connect|ECONNREFUSED|secret not found/i);
  });
});
