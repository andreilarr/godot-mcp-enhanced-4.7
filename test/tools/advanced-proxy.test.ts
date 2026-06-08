import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getToolDefinitions,
  handleTool,
  setToolCallDelegate,
} from '../../src/tools/advanced-proxy.js';
import {
  setActiveGroups,
  getActiveGroups,
  registerTools,
  TOOL_GROUPS,
} from '../../src/core/tool-registry.js';
import type { ToolContext, ToolResult } from '../../src/types.js';

const mockCtx = {} as ToolContext;

describe('advanced-proxy', () => {
  let savedGroups: ReadonlySet<string>;

  beforeEach(() => {
    setToolCallDelegate(null);
    // Save current active groups
    savedGroups = getActiveGroups();
  });

  afterEach(() => {
    // Restore active groups
    setActiveGroups(new Set(savedGroups));
  });

  describe('getToolDefinitions', () => {
    it('returns single godot_advanced_tool definition', () => {
      const defs = getToolDefinitions();
      expect(defs).toHaveLength(1);
      expect(defs[0].name).toBe('godot_advanced_tool');
    });

    it('has tool_name and arguments in inputSchema', () => {
      const defs = getToolDefinitions();
      const schema = defs[0].inputSchema as any;
      expect(schema.properties.tool_name).toBeDefined();
      expect(schema.properties.arguments).toBeDefined();
      expect(schema.required).toContain('tool_name');
    });

    it('belongs to core group', () => {
      const defs = getToolDefinitions();
      expect(defs[0].annotations?.tags).toContain('group:core');
    });

    it('description mentions proxy functionality', () => {
      const defs = getToolDefinitions();
      expect(defs[0].description).toContain('proxy');
    });
  });

  describe('handleTool', () => {
    it('returns null for unknown tool name', async () => {
      const result = await handleTool('unknown', {}, mockCtx);
      expect(result).toBeNull();
    });

    it('returns error when tool_name is missing', async () => {
      setToolCallDelegate(vi.fn());

      const result = await handleTool('godot_advanced_tool', {
        arguments: {},
      }, mockCtx);

      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(false);
      expect(parsed.error_code).toBe('MISSING_TOOL_NAME');
    });

    it('returns error when target tool is already directly available', async () => {
      setToolCallDelegate(vi.fn());

      // manage_tools is in ALWAYS_ALLOWED, so it's always "directly available"
      const result = await handleTool('godot_advanced_tool', {
        tool_name: 'manage_tools',
        arguments: {},
      }, mockCtx);

      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(false);
      expect(parsed.error_code).toBe('TOOL_ALREADY_AVAILABLE');
    });

    it('returns fuzzy suggestions for invalid tool_name without full tool list', async () => {
      setToolCallDelegate(vi.fn());

      const result = await handleTool('godot_advanced_tool', {
        tool_name: 'animaton',
        arguments: {},
      }, mockCtx);

      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.error_code).toBe('UNKNOWN_TOOL');
      expect(parsed.suggestions).toBeDefined();
      expect(Array.isArray(parsed.suggestions)).toBe(true);
      // A-01: must NOT leak full tool list
      expect(parsed.available_tools).toBeUndefined();
    });

    it('returns error when tool_name is not a string', async () => {
      setToolCallDelegate(vi.fn());

      const result = await handleTool('godot_advanced_tool', {
        tool_name: 123,
        arguments: {},
      }, mockCtx);

      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(false);
      expect(parsed.error_code).toBe('MISSING_TOOL_NAME');
    });
  });

  describe('delegate path (deactivated tools)', () => {
    // Use setActiveGroups to deactivate animation group, triggering delegate path.
    // This tests the real production code path without mocking.

    beforeEach(() => {
      // Only activate core group — animation group is deactivated
      setActiveGroups(new Set(['core']));
      // Register animation as a known tool (module not loaded in test env)
      registerTools([{ name: 'animation', readonly: false, long_running: false }]);
    });

    it('delegates call when tool is deactivated', async () => {
      const mockDelegate = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '{"success":true,"data":{}}' }],
      });
      setToolCallDelegate(mockDelegate);

      const result = await handleTool('godot_advanced_tool', {
        tool_name: 'animation',
        arguments: { action: 'list_players' },
      }, mockCtx);

      expect(mockDelegate).toHaveBeenCalledWith('animation', { action: 'list_players' });
      const text = (result?.content?.[0] as any)?.text;
      expect(text).toContain('success');
    });

    it('returns NO_DELEGATE when delegate is null and tool is deactivated', async () => {
      setToolCallDelegate(null);

      const result = await handleTool('godot_advanced_tool', {
        tool_name: 'animation',
        arguments: {},
      }, mockCtx);

      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(false);
      expect(parsed.error_code).toBe('NO_DELEGATE');
    });

    it('returns PROXY_ERROR when delegate throws', async () => {
      setToolCallDelegate(async () => {
        throw new Error('Target tool crashed');
      });

      const result = await handleTool('godot_advanced_tool', {
        tool_name: 'animation',
        arguments: {},
      }, mockCtx);

      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(false);
      expect(parsed.error_code).toBe('PROXY_ERROR');
      expect(parsed.error).toContain('crashed');
    });

    it('still rejects directly available tools even in slim mode', async () => {
      setToolCallDelegate(vi.fn());

      // project is in core group, always available
      const result = await handleTool('godot_advanced_tool', {
        tool_name: 'project',
        arguments: {},
      }, mockCtx);

      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(false);
      expect(parsed.error_code).toBe('TOOL_ALREADY_AVAILABLE');
    });
  });
});
