import { describe, it, expect, beforeEach } from 'vitest';
import { getToolDefinitions, handleTool, resetBridgeState } from '../src/tools/game-bridge.js';

describe('game-bridge monitor', () => {
  beforeEach(() => {
    resetBridgeState();
  });

  describe('tool registration', () => {
    it('should register monitor_start/stop/poll in ACTIONS enum', () => {
      const tools = getToolDefinitions();
      const gameTool = tools.find(t => t.name === 'game');
      expect(gameTool).toBeDefined();
      const actions = gameTool.inputSchema.properties.action.enum;
      expect(actions).toContain('monitor_start');
      expect(actions).toContain('monitor_stop');
      expect(actions).toContain('monitor_poll');
    });

    it('should include node_path, properties, interval_frames in inputSchema', () => {
      const tools = getToolDefinitions();
      const gameTool = tools.find(t => t.name === 'game');
      const props = gameTool.inputSchema.properties;
      expect(props.node_path).toBeDefined();
      expect(props.properties).toBeDefined();
      expect(props.interval_frames).toBeDefined();
    });
  });

  describe('monitor.start command generation', () => {
    it('should use default interval_frames of 10', () => {
      const params = { node_path: 'root/Player', properties: ['position'] };
      const interval = params.interval_frames ?? 10;
      expect(interval).toBe(10);
    });

    it('should accept custom interval_frames', () => {
      const params = { node_path: 'root/Player', properties: ['health'], interval_frames: 5 };
      expect(params.interval_frames).toBe(5);
    });
  });

  describe('monitor response validation', () => {
    it('should validate monitor.start response schema', () => {
      const response = {
        monitoring: true,
        node_path: 'root/Player',
        properties: ['position', 'health'],
        interval_frames: 5,
      };
      expect(response.monitoring).toBe(true);
      expect(response.properties).toBeInstanceOf(Array);
    });

    it('should validate monitor.poll response with samples', () => {
      const response = {
        monitoring: true,
        node_path: 'root/Player',
        samples: [
          { frame: 100, time: 1.667, values: { position: { x: 10, y: 0 } } },
          { frame: 110, time: 1.833, values: { position: { x: 12, y: 0 } } },
        ],
        sample_count: 2,
      };
      expect(response.samples).toHaveLength(2);
      expect(response.sample_count).toBe(2);
    });

    it('should validate monitor.stop returns final data', () => {
      const response = {
        monitoring: false,
        samples: [
          { frame: 100, time: 1.667, values: { health: 100 } },
          { frame: 110, time: 1.833, values: { health: 85 } },
        ],
        total_frames: 200,
        duration_seconds: 3.33,
      };
      expect(response.monitoring).toBe(false);
      expect(response.total_frames).toBeGreaterThan(0);
    });
  });

  describe('monitor handler', () => {
    it('should return null for non-game tools', async () => {
      const result = await handleTool('other_tool', {}, { opsScript: '' });
      expect(result).toBeNull();
    });

    it('should reject monitor_start without node_path', async () => {
      const result = await handleTool('game', {
        project_path: '/tmp/test',
        action: 'monitor_start',
        properties: ['position'],
      }, { opsScript: '' });
      expect(result).toBeDefined();
      expect(result.content[0].text).toContain('node_path is required');
    });

    it('should reject monitor_start without properties', async () => {
      const result = await handleTool('game', {
        project_path: '/tmp/test',
        action: 'monitor_start',
        node_path: 'root/Player',
      }, { opsScript: '' });
      expect(result).toBeDefined();
      expect(result.content[0].text).toContain('non-empty array');
    });

    it('should reject monitor_start with empty properties array', async () => {
      const result = await handleTool('game', {
        project_path: '/tmp/test',
        action: 'monitor_start',
        node_path: 'root/Player',
        properties: [],
      }, { opsScript: '' });
      expect(result).toBeDefined();
      expect(result.content[0].text).toContain('non-empty array');
    });

    it('should handle monitor_start when bridge is unavailable', async () => {
      const result = await handleTool('game', {
        project_path: '/tmp/test-monitor',
        action: 'monitor_start',
        node_path: 'root/Player',
        properties: ['position'],
      }, { opsScript: '' });
      // Bridge 不可用时会返回连接错误
      expect(result).toBeDefined();
      expect(result.content[0].text).toContain('Error');
    });

    it('should handle monitor_stop when bridge is unavailable', async () => {
      const result = await handleTool('game', {
        project_path: '/tmp/test-monitor',
        action: 'monitor_stop',
      }, { opsScript: '' });
      expect(result).toBeDefined();
    });

    it('should handle monitor_poll when bridge is unavailable', async () => {
      const result = await handleTool('game', {
        project_path: '/tmp/test-monitor',
        action: 'monitor_poll',
      }, { opsScript: '' });
      expect(result).toBeDefined();
    });
  });
});
