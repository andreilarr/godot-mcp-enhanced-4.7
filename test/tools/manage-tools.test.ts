import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock tool-registry — use vi.hoisted() so mock functions are available when vi.mock factory runs
const { mockSetActiveGroups, mockGetActiveGroups, mockGetGroupForTool } = vi.hoisted(() => ({
  mockSetActiveGroups: vi.fn(),
  mockGetActiveGroups: vi.fn(),
  mockGetGroupForTool: vi.fn(),
}));

vi.mock('../../src/core/tool-registry.js', () => ({
  TOOL_GROUPS: {
    core: { description: '核心工具', tools: ['project', 'scene'], requires: [], protected: true },
    animation: { description: '动画', tools: ['animation'], requires: [] },
    bridge: { description: 'Bridge', tools: ['game'], requires: ['bridge'] },
  },
  setActiveGroups: mockSetActiveGroups,
  getActiveGroups: mockGetActiveGroups,
  getGroupForTool: mockGetGroupForTool,
}));

vi.mock('../../src/tools/shared.js', () => ({
  opsSuccess: (data: unknown) => ({ success: true, data, warnings: [] }),
  opsError: (code: string, msg: string) => ({
    success: false,
    error: msg,
    error_code: code,
    warnings: [],
  }),
  opsErrorResult: (code: string, msg: string) => ({
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ success: false, error: msg, error_code: code }),
      },
    ],
    isError: true,
  }),
}));
vi.mock('../../src/helpers.js', () => ({
  isPathInAllowedRoots: vi.fn().mockReturnValue(true),
}));
vi.mock('../../src/core/process-state.js', () => ({
  getRunningProcess: vi.fn().mockReturnValue(null),
  setRunningProcess: vi.fn(),
  getOutputBuffer: vi.fn().mockReturnValue([]),
  setOutputBuffer: vi.fn(),
  getProcessStartTime: vi.fn().mockReturnValue(0),
  setProcessStartTime: vi.fn(),
  getProjectDir: vi.fn().mockReturnValue(''),
  setProjectDir: vi.fn(),
}));
vi.mock('../../src/guard.js', () => ({
  requiresConfirmation: vi.fn().mockReturnValue(false),
}));

import { handleTool, getToolDefinitions } from '../../src/tools/manage-tools.js';

describe('manage_tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveGroups.mockReturnValue(new Set(['core', 'animation', 'bridge']));
  });

  it('getToolDefinitions returns single tool with action enum', () => {
    const defs = getToolDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('manage_tools');
    const schema = defs[0].inputSchema as Record<string, unknown>;
    expect(schema.properties).toHaveProperty('action');
  });

  it('list_groups returns all groups with status', async () => {
    const result = await handleTool('manage_tools', { action: 'list_groups' }, {} as any);
    const data = JSON.parse((result!.content as any)[0].text);
    expect(data.success).toBe(true);
    expect(data.data.groups).toBeDefined();
    expect(data.data.groups.length).toBeGreaterThan(0);
    const coreGroup = data.data.groups.find((g: any) => g.name === 'core');
    expect(coreGroup).toBeDefined();
    expect(coreGroup.protected).toBe(true);
  });

  it('activate adds groups to active set', async () => {
    mockSetActiveGroups.mockImplementation((groups: Set<string>) => groups);
    const result = await handleTool('manage_tools', {
      action: 'activate',
      groups: ['animation'],
    }, {} as any);
    const data = JSON.parse((result!.content as any)[0].text);
    expect(data.success).toBe(true);
    expect(mockSetActiveGroups).toHaveBeenCalled();
  });

  it('deactivate rejects protected groups', async () => {
    const result = await handleTool('manage_tools', {
      action: 'deactivate',
      groups: ['core'],
    }, {} as any);
    const data = JSON.parse((result!.content as any)[0].text);
    expect(data.success).toBe(false);
    expect(data.error).toContain('protected');
  });

  it('deactivate removes non-protected groups', async () => {
    mockSetActiveGroups.mockImplementation((groups: Set<string>) => groups);
    const result = await handleTool('manage_tools', {
      action: 'deactivate',
      groups: ['animation'],
    }, {} as any);
    const data = JSON.parse((result!.content as any)[0].text);
    expect(data.success).toBe(true);
  });

  it('sync returns updated status', async () => {
    mockSetActiveGroups.mockImplementation((groups: Set<string>) => groups);
    const result = await handleTool('manage_tools', { action: 'sync' }, {} as any);
    const data = JSON.parse((result!.content as any)[0].text);
    expect(data.success).toBe(true);
  });

  it('reconnect returns placeholder for Phase 4', async () => {
    const result = await handleTool('manage_tools', { action: 'reconnect' }, {} as any);
    const data = JSON.parse((result!.content as any)[0].text);
    expect(data.success).toBe(true);
  });
});
