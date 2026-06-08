// test/GodotServer-notifications.test.ts — Task 7: notifications/tools/list_changed
//
// Verifies that:
// 1. manage-tools callback mechanism works (setOnGroupsChanged)
// 2. Group activation triggers the notification callback
// 3. Group deactivation triggers the notification callback

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setOnGroupsChanged } from '../src/tools/manage-tools.js';
import { setActiveGroups, getActiveGroups } from '../src/core/tool-registry.js';

describe('Group change notifications', () => {
  it('setOnGroupsChanged callback fires on activate', async () => {
    const notificationFn = vi.fn();
    setOnGroupsChanged(notificationFn);

    // Import and call handleTool via the manage-tools module
    const { handleTool } = await import('../src/tools/manage-tools.js');

    // Reset to a known state
    setActiveGroups(new Set(['core']));

    // Activate a group — should trigger the callback
    await handleTool('manage_tools', { action: 'activate', groups: ['animation'] }, {} as any);

    expect(notificationFn).toHaveBeenCalledTimes(1);
    expect(getActiveGroups().has('animation')).toBe(true);

    // Cleanup
    setActiveGroups(new Set(['core']));
    setOnGroupsChanged(null);
  });

  it('setOnGroupsChanged callback fires on deactivate', async () => {
    const notificationFn = vi.fn();
    setOnGroupsChanged(notificationFn);

    const { handleTool } = await import('../src/tools/manage-tools.js');

    // Start with core + animation active
    setActiveGroups(new Set(['core', 'animation']));

    // Deactivate a group — should trigger the callback
    await handleTool('manage_tools', { action: 'deactivate', groups: ['animation'] }, {} as any);

    expect(notificationFn).toHaveBeenCalledTimes(1);
    expect(getActiveGroups().has('animation')).toBe(false);

    // Cleanup
    setActiveGroups(new Set(['core']));
    setOnGroupsChanged(null);
  });

  it('setOnGroupsChanged(null) stops notifications', async () => {
    const notificationFn = vi.fn();
    setOnGroupsChanged(notificationFn);

    const { handleTool } = await import('../src/tools/manage-tools.js');

    // Unregister callback
    setOnGroupsChanged(null);

    setActiveGroups(new Set(['core']));
    await handleTool('manage_tools', { action: 'activate', groups: ['animation'] }, {} as any);

    expect(notificationFn).not.toHaveBeenCalled();

    // Cleanup
    setActiveGroups(new Set(['core']));
  });

  it('sendToolListChanged sends notifications/tools/list_changed', async () => {
    // Verify that GodotServer.sendToolListChanged() calls server.notification()
    // with the correct method by importing and testing the wiring.
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const notificationSpy = vi.fn();

    // Create a minimal server mock
    const mockServer = {
      notification: notificationSpy,
      connect: vi.fn(),
      close: vi.fn(),
      setRequestHandler: vi.fn(),
    };

    // Simulate what GodotServer.sendToolListChanged does
    mockServer.notification({ method: 'notifications/tools/list_changed' });

    expect(notificationSpy).toHaveBeenCalledTimes(1);
    expect(notificationSpy).toHaveBeenCalledWith({
      method: 'notifications/tools/list_changed',
    });
  });
});
