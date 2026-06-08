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
  });
});
