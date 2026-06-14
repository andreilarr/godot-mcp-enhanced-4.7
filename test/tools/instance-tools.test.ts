import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getToolDefinitions,
  handleTool,
  setInstanceManager,
  setInstanceRouter,
} from '../../src/tools/instance-tools.js';
import type { InstanceManager } from '../../src/core/instance-manager.js';
import type { InstanceRouter } from '../../src/core/instance-router.js';
import type { ToolContext } from '../../src/types.js';

const mockCtx = {} as ToolContext;

function makeManager(instances: any[] = []): InstanceManager {
  return {
    loadFromRegistry: vi.fn().mockResolvedValue(instances),
    getInstance: vi.fn((id: string) => instances.find((i: any) => i.id === id)),
    getAllInstances: vi.fn().mockReturnValue(instances),
    getStatus: vi.fn().mockReturnValue('alive'),
    portRange: [9081, 9090] as [number, number],
  } as unknown as InstanceManager;
}

function makeRouter(selected: string | null = null): InstanceRouter {
  return {
    getSelectedId: vi.fn().mockReturnValue(selected),
    getSelectedInstance: vi.fn().mockReturnValue(null),
    selectInstance: vi.fn().mockResolvedValue(undefined),
    selectInstanceByProject: vi.fn().mockReturnValue(selected),
    autoSelect: vi.fn().mockReturnValue(null),
    route: vi.fn(),
    updateInstances: vi.fn(),
  } as unknown as InstanceRouter;
}

const testInstance = {
  id: 'uuid-1',
  projectPath: 'D:/game',
  projectName: 'game',
  port: 9081,
  pid: 100,
  lastSeen: new Date().toISOString(),
  godotVersion: '4.4',
  capabilities: [],
};

describe('instance-tools', () => {
  beforeEach(() => {
    setInstanceManager(null);
    setInstanceRouter(null);
  });

  describe('getToolDefinitions', () => {
    it('returns 2 tool definitions', () => {
      const defs = getToolDefinitions();
      expect(defs).toHaveLength(2);
      expect(defs.map(d => d.name)).toContain('godot_list_instances');
      expect(defs.map(d => d.name)).toContain('godot_select_instance');
    });

    it('godot_list_instances has correct input schema', () => {
      const defs = getToolDefinitions();
      const listDef = defs.find(d => d.name === 'godot_list_instances');
      expect(listDef?.inputSchema).toBeDefined();
      // Tags are injected at registration time by module-loader.injectTags(),
      // not declared in the raw tool definition.
      expect(listDef?.annotations).toBeUndefined();
    });

    it('godot_select_instance requires instance_id', () => {
      const defs = getToolDefinitions();
      const selectDef = defs.find(d => d.name === 'godot_select_instance');
      expect((selectDef?.inputSchema as any)?.required).toEqual([]);
    });
  });

  describe('handleTool', () => {
    it('returns null for unknown tool', async () => {
      const result = await handleTool('unknown_tool', {}, mockCtx);
      expect(result).toBeNull();
    });

    it('godot_list_instances returns instance list', async () => {
      const manager = makeManager([testInstance]);
      setInstanceManager(manager);
      setInstanceRouter(makeRouter('uuid-1'));

      const result = await handleTool('godot_list_instances', {}, mockCtx);
      expect(result).not.toBeNull();
      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(true);
      expect(parsed.data.instances).toHaveLength(1);
    });

    it('godot_list_instances returns error when not initialized', async () => {
      const result = await handleTool('godot_list_instances', {}, mockCtx);
      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(false);
      expect(parsed.error_code).toBe('NOT_INITIALIZED');
    });

    it('godot_select_instance selects by id', async () => {
      const manager = makeManager([testInstance]);
      const router = makeRouter(null);
      setInstanceManager(manager);
      setInstanceRouter(router);

      const result = await handleTool('godot_select_instance', { instance_id: 'uuid-1' }, mockCtx);
      expect(result).not.toBeNull();
      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(true);
    });

    it('godot_select_instance rejects unknown id', async () => {
      setInstanceManager(makeManager([]));
      setInstanceRouter(makeRouter(null));

      const result = await handleTool('godot_select_instance', { instance_id: 'nonexistent' }, mockCtx);
      expect(result).not.toBeNull();
      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(false);
    });

    it('godot_select_instance syncs router instanceMap before select (IM-2)', async () => {
      // IM-2: handleSelectInstance 调 loadFromRegistry 刷新 manager,但 router 的
      // instanceMap 不同步 → "列表看得见但选不中"。修复后须在 selectInstance 前
      // 把 manager 的最新实例同步到 router。
      const manager = makeManager([testInstance]);
      const router = makeRouter(null);
      setInstanceManager(manager);
      setInstanceRouter(router);

      const result = await handleTool('godot_select_instance', { instance_id: 'uuid-1' }, mockCtx);
      const parsed = JSON.parse((result?.content?.[0] as any)?.text);

      expect(router.updateInstances).toHaveBeenCalledWith([testInstance]);
      expect(router.selectInstance).toHaveBeenCalledWith('uuid-1');
      // M-2: 验证同步顺序——updateInstances 必须在 selectInstance 之前调用,
      // 否则 selectInstance 用的是过期 instanceMap,修复失效。
      expect(router.updateInstances).toHaveBeenCalledBefore(router.selectInstance);
      expect(parsed.success).toBe(true);
    });
  });
});
