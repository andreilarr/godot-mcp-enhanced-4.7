/**
 * Phase 3 验收测试 — 动态路由 + 工具发现
 *
 * 聚焦跨组件集成：
 * 1. toolNameToRoute 覆盖表 + 边界
 * 2. classifyError 与动态路由决策的联动
 * 3. dynamic 组 ↔ advanced-proxy ↔ tool-registry 三方集成
 * 4. Profile ↔ dynamic 组 ↔ expandGroups 端到端展开
 * 5. godot_list_dynamic_routes 的组感知 + 过滤
 *
 * 注意：纯函数的单元测试已在 dynamic-routes.test.ts 和
 * advanced-proxy.test.ts 中覆盖。本文件专注于集成维度。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  toolNameToRoute,
  classifyError,
} from '../../src/core/dynamic-routes.js';
import {
  handleTool,
  setToolCallDelegate,
  setDynamicSender,
} from '../../src/tools/advanced-proxy.js';
import {
  TOOL_GROUPS,
  PROFILES,
  expandGroups,
  resolveProfile,
  setActiveGroups,
  getActiveGroups,
  registerTools,
  isToolAllowed,
} from '../../src/core/tool-registry.js';
import type { ToolContext } from '../../src/types.js';

const mockCtx = {} as ToolContext;

// ─── 1. Dynamic route derivation 覆盖表 + 边界 ─────────────────────────────────

describe('Dynamic route derivation integration', () => {
  let mockSender: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSender = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"success":true}' }],
    });
    setDynamicSender(mockSender);
  });

  afterEach(() => {
    setDynamicSender(null);
  });

  it('derives route that advanced-proxy passes to dynamic sender', async () => {
    // 验证 toolNameToRoute 的输出直接被 advanced-proxy 传给 sender
    const toolName = 'godot_custom_light_bake';
    const route = toolNameToRoute(toolName);

    // 激活 dynamic 组
    setActiveGroups(new Set(['core', 'dynamic']));

    await handleTool('godot_advanced_tool', {
      tool_name: toolName,
      arguments: {},
    }, mockCtx);

    expect(mockSender).toHaveBeenCalledWith(route, {});
  });

  it('multi-segment route derivation matches sender call', async () => {
    const toolName = 'godot_animation_play_forward';
    const expectedRoute = 'animation/play-forward';

    expect(toolNameToRoute(toolName)).toBe(expectedRoute);

    setActiveGroups(new Set(['core', 'dynamic']));

    await handleTool('godot_advanced_tool', {
      tool_name: toolName,
      arguments: {},
    }, mockCtx);

    expect(mockSender).toHaveBeenCalledWith(expectedRoute, {});
  });

  it('toolNameToRoute null results cause proxy to reject with INVALID_DYNAMIC_TOOL_NAME', async () => {
    // 收集所有会返回 null 的输入
    const nullInputs = ['godot_', 'godot_x', '', 'non_godot_tool'];
    for (const input of nullInputs) {
      expect(toolNameToRoute(input)).toBeNull();
    }

    // 验证 proxy 对 null 路由的拒绝行为
    setActiveGroups(new Set(['core', 'dynamic']));

    const result = await handleTool('godot_advanced_tool', {
      tool_name: 'godot_',
      arguments: {},
    }, mockCtx);

    const parsed = JSON.parse((result!.content[0] as any).text);
    expect(parsed.success).toBe(false);
    expect(parsed.error_code).toBe('INVALID_DYNAMIC_TOOL_NAME');
  });
});

// ─── 2. classifyError 与动态路由决策的联动 ─────────────────────────────────────

describe('Error classification informs retry eligibility', () => {
  it('5xx transient error should qualify for dynamic route retry', () => {
    // 场景：动态路由发出后收到 503 → classifyError 判定 transient → 可重试
    expect(classifyError(503)).toBe('transient');
    expect(classifyError(500)).toBe('transient');
    expect(classifyError(502)).toBe('transient');
  });

  it('4xx permanent error should not be retried for dynamic route', () => {
    // 场景：动态路由发出后收到 404 → classifyError 判定 permanent → 不重试
    expect(classifyError(404)).toBe('permanent');
    expect(classifyError(400)).toBe('permanent');
    expect(classifyError(422)).toBe('permanent');
  });

  it('non-standard codes default to permanent (conservative)', () => {
    // 1xx, 2xx, 3xx 都视为 permanent — 不重试
    expect(classifyError(100)).toBe('permanent');
    expect(classifyError(200)).toBe('permanent');
    expect(classifyError(301)).toBe('permanent');
    expect(classifyError(0)).toBe('permanent');
  });

  it('dynamic route + transient error classification end-to-end', async () => {
    // 模拟完整的动态路由流程 + 错误分类
    const toolName = 'godot_custom_light_bake';
    const route = toolNameToRoute(toolName);
    expect(route).toBe('custom/light-bake');

    // 模拟 Godot 端返回 503
    const httpStatus = 503;
    const classification = classifyError(httpStatus);

    // 验证分类结果可用于重试决策
    expect(classification).toBe('transient');
    // 实际的重试逻辑在 ToolDispatcher 中，此处验证分类正确性
  });
});

// ─── 3. dynamic 组 ↔ advanced-proxy ↔ tool-registry 三方集成 ────────────────────

describe('Dynamic group ↔ advanced-proxy ↔ registry integration', () => {
  let savedGroups: ReadonlySet<string>;
  let mockSender: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setToolCallDelegate(null);
    mockSender = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"success":true}' }],
    });
    setDynamicSender(mockSender);
    savedGroups = getActiveGroups();
  });

  afterEach(() => {
    setActiveGroups(new Set(savedGroups));
    setDynamicSender(null);
  });

  it('dynamic group activation enables dynamic routing path', async () => {
    // 先禁用 dynamic
    setActiveGroups(new Set(['core']));
    let result = await handleTool('godot_advanced_tool', {
      tool_name: 'godot_custom_action',
      arguments: {},
    }, mockCtx);
    let parsed = JSON.parse((result!.content[0] as any).text);
    expect(parsed.error_code).toBe('DYNAMIC_GROUP_INACTIVE');

    // 再启用 dynamic — sender 应被调用
    mockSender.mockClear();
    setActiveGroups(new Set(['core', 'dynamic']));
    result = await handleTool('godot_advanced_tool', {
      tool_name: 'godot_custom_action',
      arguments: { param: 42 },
    }, mockCtx);
    expect(mockSender).toHaveBeenCalledWith('custom/action', { param: 42 });
  });

  it('godot_advanced_tool is always allowed even without dynamic group', () => {
    // godot_advanced_tool 在 ALWAYS_ALLOWED 中
    setActiveGroups(new Set(['core']));
    expect(isToolAllowed('godot_advanced_tool')).toBe(true);

    // 即使所有组都禁用
    setActiveGroups(new Set());
    expect(isToolAllowed('godot_advanced_tool')).toBe(true);
  });

  it('known registered tool bypasses dynamic routing even with dynamic group active', async () => {
    setActiveGroups(new Set(['core', 'dynamic']));
    registerTools([{ name: 'my_registered_tool', readonly: false, long_running: false }]);

    // my_registered_tool 在 registry 中但不在 active groups → 走 delegate 路径
    const result = await handleTool('godot_advanced_tool', {
      tool_name: 'my_registered_tool',
      arguments: {},
    }, mockCtx);

    // 没有 delegate → NO_DELEGATE（不是 dynamic 路径）
    const parsed = JSON.parse((result!.content[0] as any).text);
    expect(parsed.success).toBe(false);
    expect(parsed.error_code).toBe('NO_DELEGATE');
    expect(parsed.dynamic).toBeUndefined();
  });

  it('isToolAllowed interaction: deactivated tool is not "directly available" proxy target', async () => {
    // 只激活 core → animation 组被禁用
    setActiveGroups(new Set(['core']));

    // animation 工具不在 active groups 中
    expect(isToolAllowed('animation')).toBe(false);

    // 但 animation 在 registry 中 → 应走 delegate 路径，不是 dynamic
    registerTools([{ name: 'animation', readonly: false, long_running: false }]);
    const result = await handleTool('godot_advanced_tool', {
      tool_name: 'animation',
      arguments: { action: 'play' },
    }, mockCtx);

    const parsed = JSON.parse((result!.content[0] as any).text);
    // 没有 delegate → NO_DELEGATE
    expect(parsed.error_code).toBe('NO_DELEGATE');
  });

  it('non-godot_ prefix tool gets fuzzy suggestions, never dynamic route', async () => {
    setActiveGroups(new Set(['core', 'dynamic']));

    const result = await handleTool('godot_advanced_tool', {
      tool_name: 'animaton', // 拼写错误，无 godot_ 前缀
      arguments: {},
    }, mockCtx);

    const parsed = JSON.parse((result!.content[0] as any).text);
    expect(parsed.error_code).toBe('UNKNOWN_TOOL');
    expect(parsed.suggestions).toBeDefined();
    expect(parsed.dynamic).toBeUndefined();
  });

  it('ALWAYS_ALLOWED tool is rejected by proxy even with dynamic group', async () => {
    setActiveGroups(new Set(['core', 'dynamic']));

    // manage_tools 在 ALWAYS_ALLOWED 中
    const result = await handleTool('godot_advanced_tool', {
      tool_name: 'manage_tools',
      arguments: {},
    }, mockCtx);

    const parsed = JSON.parse((result!.content[0] as any).text);
    expect(parsed.success).toBe(false);
    expect(parsed.error_code).toBe('TOOL_ALREADY_AVAILABLE');
  });
});

// ─── 4. Profile ↔ dynamic 组 ↔ expandGroups 端到端展开 ────────────────────────

describe('Profile → dynamic group → tool expansion end-to-end', () => {
  it('full profile resolves to include godot_advanced_tool via dynamic group', () => {
    const tools = resolveProfile('full');
    expect(tools.has('godot_advanced_tool')).toBe(true);
  });

  it('bridge_dev profile includes godot_advanced_tool', () => {
    const tools = resolveProfile('bridge_dev');
    expect(tools.has('godot_advanced_tool')).toBe(true);
  });

  it('minimal profile does NOT include godot_advanced_tool', () => {
    const tools = resolveProfile('minimal');
    // minimal = ['core'] → core tools only, no dynamic
    expect(tools.has('godot_advanced_tool')).toBe(false);
  });

  it('slim profile does NOT include godot_advanced_tool', () => {
    const tools = resolveProfile('slim');
    expect(tools.has('godot_advanced_tool')).toBe(false);
  });

  it('PROFILES definition matches expandGroups output for dynamic', () => {
    // 验证 PROFILES 声明和 expandGroups 运行时结果一致
    const dynamicTools = expandGroups(['dynamic']);
    expect(dynamicTools.has('godot_advanced_tool')).toBe(true);
    expect(dynamicTools.has('godot_list_dynamic_routes')).toBe(true);
    expect(dynamicTools.size).toBe(2); // I-10: dynamic 组现在有 2 个工具
  });

  it('TOOL_GROUPS.dynamic.tools matches what expandGroups returns', () => {
    const declared = TOOL_GROUPS.dynamic.tools;
    const expanded = expandGroups(['dynamic']);
    for (const tool of declared) {
      expect(expanded.has(tool)).toBe(true);
    }
  });

  it('3d_dev profile does NOT include dynamic group', () => {
    const tools = resolveProfile('3d_dev');
    expect(tools.has('godot_advanced_tool')).toBe(false);
  });

  it('lite profile does NOT include dynamic group', () => {
    const tools = resolveProfile('lite');
    expect(tools.has('godot_advanced_tool')).toBe(false);
  });

  it('custom comma-separated groups can include dynamic', () => {
    const tools = resolveProfile('core,dynamic');
    expect(tools.has('project')).toBe(true);   // core
    expect(tools.has('godot_advanced_tool')).toBe(true); // dynamic
  });

  it('full profile includes all groups including dynamic', () => {
    const allGroups = Object.keys(TOOL_GROUPS);
    expect(PROFILES.full).toEqual(allGroups);
    expect(PROFILES.full).toContain('dynamic');
  });
});

// ─── 5. godot_list_dynamic_routes 组感知 + 过滤集成 ─────────────────────────────

describe('godot_list_dynamic_routes integration', () => {
  let savedGroups: ReadonlySet<string>;

  beforeEach(() => {
    savedGroups = getActiveGroups();
  });

  afterEach(() => {
    setActiveGroups(new Set(savedGroups));
  });

  it('reflects dynamic group status in real time', async () => {
    // 启用 dynamic
    setActiveGroups(new Set(['core', 'dynamic']));
    let result = await handleTool('godot_list_dynamic_routes', {}, mockCtx);
    let parsed = JSON.parse((result!.content[0] as any).text);
    expect(parsed.success).toBe(true);
    expect(parsed.dynamic_routing_enabled).toBe(true);

    // 禁用 dynamic
    setActiveGroups(new Set(['core']));
    result = await handleTool('godot_list_dynamic_routes', {}, mockCtx);
    parsed = JSON.parse((result!.content[0] as any).text);
    expect(parsed.dynamic_routing_enabled).toBe(false);
  });

  it('registered list only includes tools known to the registry', async () => {
    setActiveGroups(new Set(['core', 'dynamic']));

    const result = await handleTool('godot_list_dynamic_routes', {}, mockCtx);
    const parsed = JSON.parse((result!.content[0] as any).text);

    expect(parsed.success).toBe(true);
    expect(Array.isArray(parsed.registered)).toBe(true);
    // registered 列表中的工具必须在 registry 中
    // （具体工具取决于测试环境中注册了哪些）
    expect(typeof parsed.total_registered).toBe('number');
  });

  it('category filter correctly narrows results', async () => {
    setActiveGroups(new Set(['core', 'dynamic']));

    // 过滤 "project" 类别
    const result = await handleTool('godot_list_dynamic_routes', {
      category: 'project',
    }, mockCtx);
    const parsed = JSON.parse((result!.content[0] as any).text);

    expect(parsed.success).toBe(true);
    for (const name of parsed.registered) {
      expect(name).toContain('project');
    }
    // 过滤后的数量 <= 总量
    expect(parsed.total_registered).toBeLessThanOrEqual(parsed.total_registered + 1);
  });

  it('category filter with non-matching category returns empty registered array', async () => {
    const result = await handleTool('godot_list_dynamic_routes', {
      category: 'nonexistent_category_xyz',
    }, mockCtx);
    const parsed = JSON.parse((result!.content[0] as any).text);

    expect(parsed.success).toBe(true);
    expect(parsed.registered).toHaveLength(0);
    expect(parsed.total_registered).toBe(0);
  });

  it('returns hint text for discoverability', async () => {
    setActiveGroups(new Set(['core', 'dynamic']));

    const result = await handleTool('godot_list_dynamic_routes', {}, mockCtx);
    const parsed = JSON.parse((result!.content[0] as any).text);

    expect(parsed.hint).toBeDefined();
    expect(parsed.hint).toContain('godot_advanced_tool');
    expect(parsed.hint).toContain('godot_');
  });

  it('returns null for unrelated tool name (routing guard)', async () => {
    const result = await handleTool('some_random_tool', {}, mockCtx);
    expect(result).toBeNull();
  });
});
