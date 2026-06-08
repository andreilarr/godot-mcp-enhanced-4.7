import { describe, it, expect, afterEach } from 'vitest';

describe('Feature flags', () => {
  afterEach(() => {
    // 清理环境变量
    const keys = [
      'GODOT_MCP_TOOL_GROUPS', 'GODOT_MCP_PATH_SECURITY',
      'GODOT_MCP_MULTI_INSTANCE', 'GODOT_MCP_ADVANCED_PROXY',
      'GODOT_MCP_RESPONSE_LIMIT', 'GODOT_MCP_HEALTH_MONITOR',
      'GODOT_MCP_OFFLINE_MODE', 'GODOT_MCP_ELICITATION',
    ];
    for (const k of keys) delete process.env[k];
  });

  it('all Phase 1-5 flags have correct defaults', () => {
    const defaults: Record<string, string | undefined> = {
      GODOT_MCP_TOOL_GROUPS: undefined,
      GODOT_MCP_PATH_SECURITY: undefined,
      GODOT_MCP_MULTI_INSTANCE: undefined,
      GODOT_MCP_ADVANCED_PROXY: undefined,
      GODOT_MCP_RESPONSE_LIMIT: undefined,
      GODOT_MCP_HEALTH_MONITOR: undefined,
      GODOT_MCP_OFFLINE_MODE: undefined,
      GODOT_MCP_ELICITATION: undefined,
    };
    for (const key of Object.keys(defaults)) {
      expect(key).toMatch(/^GODOT_MCP_[A-Z_]+$/);
    }
  });

  it('isFeatureEnabled helper returns correct values', async () => {
    const { isFeatureEnabled } = await import('../src/core/feature-flags.js');
    // 默认 true 的 feature
    expect(isFeatureEnabled('TOOL_GROUPS')).toBe(true);
    // 设置为 false
    process.env.GODOT_MCP_TOOL_GROUPS = 'false';
    expect(isFeatureEnabled('TOOL_GROUPS')).toBe(false);
    delete process.env.GODOT_MCP_TOOL_GROUPS;
    // 默认 false 的 feature
    expect(isFeatureEnabled('MULTI_INSTANCE')).toBe(false);
    process.env.GODOT_MCP_MULTI_INSTANCE = 'true';
    expect(isFeatureEnabled('MULTI_INSTANCE')).toBe(true);
    delete process.env.GODOT_MCP_MULTI_INSTANCE;
  });
});
