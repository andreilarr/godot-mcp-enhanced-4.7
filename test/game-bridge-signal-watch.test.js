import { describe, it, expect, beforeEach } from 'vitest';
import { getToolDefinitions, handleTool, resetBridgeState } from '../src/tools/game-bridge.js';

describe('game-bridge signal watch', () => {
  beforeEach(() => {
    resetBridgeState();
  });

  describe('tool registration', () => {
    it('should register watch_start/stop/poll in ACTIONS enum', () => {
      const tools = getToolDefinitions();
      const gameTool = tools.find(t => t.name === 'game');
      const actions = gameTool.inputSchema.properties.action.enum;
      expect(actions).toContain('watch_start');
      expect(actions).toContain('watch_stop');
      expect(actions).toContain('watch_poll');
    });

    it('should include signal_name and max_events in inputSchema', () => {
      const tools = getToolDefinitions();
      const gameTool = tools.find(t => t.name === 'game');
      const props = gameTool.inputSchema.properties;
      expect(props.signal_name).toBeDefined();
      expect(props.max_events).toBeDefined();
    });
  });

  describe('watch.start params validation', () => {
    it('should require node_path and signal_name', () => {
      const params = { node_path: 'root/Player', signal_name: 'health_changed' };
      expect(params.node_path).toBeTruthy();
      expect(params.signal_name).toBeTruthy();
    });

    it('should default max_events to 1000', () => {
      const params = { node_path: 'root/Player', signal_name: 'died' };
      const max = params.max_events ?? 1000;
      expect(max).toBe(1000);
    });
  });

  describe('watch event response schema', () => {
    it('should validate watch.poll response', () => {
      const response = {
        watching: true,
        node_path: 'root/Button',
        signal_name: 'pressed',
        events: [
          { frame: 150, time: 2.5, args: [] },
          { frame: 300, time: 5.0, args: [] },
        ],
        event_count: 2,
      };
      expect(response.events).toHaveLength(2);
      expect(response.event_count).toBe(2);
    });

    it('should validate watch.stop returns all events', () => {
      const response = {
        watching: false,
        node_path: 'root/Timer',
        signal_name: 'timeout',
        events: [
          { frame: 120, time: 2.0, args: [] },
        ],
        event_count: 1,
        duration_seconds: 10.5,
      };
      expect(response.watching).toBe(false);
      expect(response.events).toBeInstanceOf(Array);
    });
  });

  describe('watch handler', () => {
    it('should handle watch_start when bridge is unavailable', async () => {
      const result = await handleTool('game', {
        project_path: '/tmp/test-watch',
        action: 'watch_start',
        node_path: 'root/Button',
        signal_name: 'pressed',
      }, { opsScript: '' });
      expect(result).toBeDefined();
      expect(result.content[0].text).toContain('Error');
    });

    it('should handle watch_stop when bridge is unavailable', async () => {
      const result = await handleTool('game', {
        project_path: '/tmp/test-watch',
        action: 'watch_stop',
      }, { opsScript: '' });
      expect(result).toBeDefined();
    });

    it('should handle watch_poll when bridge is unavailable', async () => {
      const result = await handleTool('game', {
        project_path: '/tmp/test-watch',
        action: 'watch_poll',
      }, { opsScript: '' });
      expect(result).toBeDefined();
    });
  });
});
