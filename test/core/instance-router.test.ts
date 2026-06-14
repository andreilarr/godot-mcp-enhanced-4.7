import { describe, it, expect, vi } from 'vitest';
import {
  InstanceRouter,
  type RouterDependencies,
} from '../../src/core/instance-router.js';
import type { InstanceInfo } from '../../src/core/instance-manager.js';

function makeInstance(overrides: Partial<InstanceInfo> = {}): InstanceInfo {
  return {
    id: 'uuid-test',
    projectPath: 'D:/game',
    projectName: 'game',
    port: 9081,
    pid: 100,
    lastSeen: new Date().toISOString(),
    godotVersion: '4.4',
    capabilities: [],
    ...overrides,
  };
}

describe('InstanceRouter', () => {
  describe('selection strategy', () => {
    it('returns error when no instances available', async () => {
      const router = new InstanceRouter({ instances: [], sendToInstance: vi.fn() });
      const result = await router.route('game_query', { action: 'ping' });
      expect(result).toContain('No instance selected');
    });

    it('auto-selects single instance', () => {
      const inst = makeInstance();
      const router = new InstanceRouter({ instances: [inst], sendToInstance: vi.fn() });
      expect(router.autoSelect()).toBe('uuid-test');
      expect(router.getSelectedId()).toBe('uuid-test');
    });

    it('requires explicit selection for 2+ instances', () => {
      const inst1 = makeInstance({ id: 'uuid-1', port: 9081 });
      const inst2 = makeInstance({ id: 'uuid-2', port: 9082 });
      const router = new InstanceRouter({
        instances: [inst1, inst2],
        sendToInstance: vi.fn(),
      });
      expect(router.autoSelect()).toBeNull();
    });

    it('selects instance by id', async () => {
      const inst = makeInstance();
      const router = new InstanceRouter({ instances: [inst], sendToInstance: vi.fn() });
      await router.selectInstance('uuid-test');
      expect(router.getSelectedId()).toBe('uuid-test');
    });

    it('selects instance by project_path', () => {
      const inst = makeInstance();
      const router = new InstanceRouter({ instances: [inst], sendToInstance: vi.fn() });
      router.selectInstanceByProject('D:/game');
      expect(router.getSelectedId()).toBe('uuid-test');
    });

    it('rejects unknown instance id', async () => {
      const inst = makeInstance();
      const router = new InstanceRouter({ instances: [inst], sendToInstance: vi.fn() });
      await expect(router.selectInstance('nonexistent')).rejects.toThrow('Instance not found');
    });
  });

  describe('routing', () => {
    it('routes request to selected instance', async () => {
      const inst = makeInstance();
      const mockSend = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
      const router = new InstanceRouter({ instances: [inst], sendToInstance: mockSend });
      await router.selectInstance('uuid-test');

      await router.route('game_query', { action: 'ping' });
      expect(mockSend).toHaveBeenCalledWith(inst, 'game_query', { action: 'ping' });
    });

    it('returns error when no instance selected', async () => {
      const inst1 = makeInstance({ id: 'uuid-1' });
      const inst2 = makeInstance({ id: 'uuid-2' });
      const router = new InstanceRouter({
        instances: [inst1, inst2],
        sendToInstance: vi.fn(),
      });
      const result = await router.route('game_query', { action: 'ping' });
      expect(result).toContain('No instance selected');
    });
  });

  describe('switch lock', () => {
    it('queues requests during instance switch', async () => {
      const inst1 = makeInstance({ id: 'uuid-1', port: 9081 });
      const inst2 = makeInstance({ id: 'uuid-2', port: 9082 });
      let resolveSend: () => void;
      const mockSend = vi.fn().mockImplementation(() => new Promise<void>(r => { resolveSend = r; }));

      const router = new InstanceRouter({ instances: [inst1, inst2], sendToInstance: mockSend });
      await router.selectInstance('uuid-1');

      // Start a request (will hang until we resolve)
      const reqPromise = router.route('game_query', { action: 'ping' });

      // Switch instance while request is in-flight
      const switchPromise = router.selectInstance('uuid-2');

      // Resolve the in-flight request
      resolveSend!();

      await reqPromise;
      await switchPromise;

      expect(router.getSelectedId()).toBe('uuid-2');
    });

    it('does not lose lock for concurrent requests during switch', async () => {
      const inst1 = makeInstance({ id: 'uuid-1', port: 9081 });
      const inst2 = makeInstance({ id: 'uuid-2', port: 9082 });
      let resolveSend1: () => void;
      let resolveSend2: () => void;
      const mockSend = vi.fn()
        .mockImplementationOnce(() => new Promise<void>(r => { resolveSend1 = r; }))
        .mockImplementationOnce(() => new Promise<void>(r => { resolveSend2 = r; }));

      const router = new InstanceRouter({ instances: [inst1, inst2], sendToInstance: mockSend });
      await router.selectInstance('uuid-1');

      const req1 = router.route('game_query', { action: 'ping' });
      const req2 = router.route('game_query', { action: 'get_tree' });

      const switchPromise = router.selectInstance('uuid-2');

      resolveSend1!();
      resolveSend2!();

      await Promise.all([req1, req2, switchPromise]);
      expect(router.getSelectedId()).toBe('uuid-2');
    });

    it('throws when target instance removed during switch (CR-4 TOCTOU)', async () => {
      // CR-4: selectInstance 在 await inflight drain 的窗口期间,updateInstances
      // 可能移除目标实例。修复后须重新校验并 throw,而非用过期 inst 触发
      // onInstanceChanged + 写入已失效的 selectedId。
      const inst1 = makeInstance({ id: 'uuid-1', port: 9081 });
      const inst2 = makeInstance({ id: 'uuid-2', port: 9082 });
      let resolveSend: () => void;
      const onInstanceChanged = vi.fn();
      const mockSend = vi.fn().mockImplementation(() => new Promise<void>(r => { resolveSend = r; }));

      const router = new InstanceRouter({
        instances: [inst1, inst2],
        sendToInstance: mockSend,
        onInstanceChanged,
      });
      await router.selectInstance('uuid-1');

      // Start an in-flight request (hangs)
      const reqPromise = router.route('game_query', { action: 'ping' });
      // Start switch to uuid-2 (hangs on inflight drain)
      const switchPromise = router.selectInstance('uuid-2');

      // During the await window, uuid-2 is removed
      router.updateInstances([inst1]);

      // Resolve in-flight → switch proceeds to post-await check
      resolveSend!();
      await reqPromise;

      await expect(switchPromise).rejects.toThrow(/removed during select|not found/i);
      // selectedId must be cleared (null) on TOCTOU — M-1: 精确断言而非 not.toBe
      expect(router.getSelectedId()).toBe(null);
      // onInstanceChanged must NOT fire with the stale uuid-2
      // (前置 selectInstance('uuid-1') 合法触发 uuid-1 首次选中通知,不算 TOCTOU)
      expect(onInstanceChanged).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'uuid-2' }));
    });

  });

  describe('resolvePort', () => {
    it('returns original port when still alive', async () => {
      const inst = makeInstance({ id: 'i1', port: 65001 });
      const router = new InstanceRouter({ instances: [inst], sendToInstance: vi.fn() });
      router.updateInstances([inst]);
      router.autoSelect();
      const port = await router.resolvePort();
      expect(port).toBe(65001);
    });

    it('returns null when no instances available', async () => {
      const router = new InstanceRouter({ instances: [], sendToInstance: vi.fn() });
      const port = await router.resolvePort();
      expect(port).toBeNull();
    });

    it('returns null when no instance is selected', async () => {
      const inst1 = makeInstance({ id: 'i1', port: 65001 });
      const inst2 = makeInstance({ id: 'i2', port: 65002 });
      const router = new InstanceRouter({ instances: [inst1, inst2], sendToInstance: vi.fn() });
      // 2+ instances → autoSelect returns null, no manual selection
      router.autoSelect();
      const port = await router.resolvePort();
      expect(port).toBeNull();
    });

    it('picks most recent heartbeat for same projectPath when original gone', async () => {
      const inst1 = makeInstance({
        id: 'i1',
        port: 65001,
        lastSeen: new Date(Date.now() - 60000).toISOString(),
      });
      const inst2 = makeInstance({
        id: 'i2',
        port: 65002,
        lastSeen: new Date().toISOString(),
      });
      const router = new InstanceRouter({ instances: [inst1, inst2], sendToInstance: vi.fn() });
      router.updateInstances([inst1, inst2]);
      // Select i1, then simulate i1 gone by updating with only i2
      await router.selectInstance('i1');
      router.updateInstances([inst2]);
      // Now selected id is cleared because i1 is gone, re-select via project
      router.selectInstanceByProject(inst1.projectPath!);
      const port = await router.resolvePort();
      expect(port).toBe(65002);
    });

    it('falls back to single instance when projectPath differs', async () => {
      const inst = makeInstance({ id: 'i1', port: 65001, projectPath: '/other-project' });
      const router = new InstanceRouter({ instances: [inst], sendToInstance: vi.fn() });
      router.updateInstances([inst]);
      router.autoSelect();
      const port = await router.resolvePort();
      expect(port).toBe(65001);
    });

    it('returns null when selected instance gone and multiple candidates exist with different projects', async () => {
      const inst1 = makeInstance({ id: 'i1', port: 65001, projectPath: '/proj-a' });
      const inst2 = makeInstance({ id: 'i2', port: 65002, projectPath: '/proj-b' });
      // Start with inst1 selected
      const router = new InstanceRouter({ instances: [inst1], sendToInstance: vi.fn() });
      router.updateInstances([inst1]);
      router.autoSelect();
      // Now inst1 is gone, only inst2 remains with different projectPath
      router.updateInstances([inst2]);
      // selectedId was cleared, so resolvePort returns null
      const port = await router.resolvePort();
      expect(port).toBeNull();
    });
  });
});
