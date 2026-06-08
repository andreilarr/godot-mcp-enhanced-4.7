import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  InstanceManager,
  type InstanceInfo,
  type InstanceStatus,
  discoverInstances,
  getMachineRegistryDir,
} from '../../src/core/instance-manager.js';

const TMP = join(tmpdir(), 'godot-mcp-test-instances');

// Helper: create a mock instance registry file
function writeInstanceFile(dir: string, info: InstanceInfo): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${info.id}.json`), JSON.stringify(info));
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('InstanceManager', () => {
  describe('types', () => {
    it('InstanceInfo has required fields', () => {
      const info: InstanceInfo = {
        id: 'uuid-test-1',
        projectPath: 'D:/projects/game',
        projectName: 'game',
        port: 9081,
        pid: 12345,
        lastSeen: new Date().toISOString(),
        godotVersion: '4.4',
        capabilities: ['registry-heartbeat'],
      };
      expect(info.id).toBe('uuid-test-1');
      expect(info.port).toBe(9081);
    });
  });

  describe('registry read/write', () => {
    it('reads instances from machine-level registry', async () => {
      const manager = new InstanceManager({ registryDir: TMP });
      writeInstanceFile(TMP, {
        id: 'uuid-1',
        projectPath: 'D:/game1',
        projectName: 'game1',
        port: 9081,
        pid: 100,
        lastSeen: new Date().toISOString(),
        godotVersion: '4.4',
        capabilities: [],
      });

      const instances = await manager.loadFromRegistry();
      expect(instances).toHaveLength(1);
      expect(instances[0].id).toBe('uuid-1');
    });

    it('reads instances from project-level registry', async () => {
      const projectDir = join(TMP, 'project');
      const manager = new InstanceManager({
        registryDir: TMP,
        projectRegistryDir: projectDir,
      });

      writeInstanceFile(projectDir, {
        id: 'uuid-proj-1',
        projectPath: 'D:/game1',
        projectName: 'game1',
        port: 9082,
        pid: 200,
        lastSeen: new Date().toISOString(),
        godotVersion: '4.4',
        capabilities: [],
      });

      const instances = await manager.loadFromRegistry();
      expect(instances).toHaveLength(1);
      expect(instances[0].id).toBe('uuid-proj-1');
    });

    it('merges machine + project registries, dedup by id', async () => {
      const projectDir = join(TMP, 'project');
      const manager = new InstanceManager({
        registryDir: TMP,
        projectRegistryDir: projectDir,
      });

      writeInstanceFile(TMP, {
        id: 'uuid-1',
        projectPath: 'D:/game1',
        projectName: 'game1',
        port: 9081,
        pid: 100,
        lastSeen: new Date().toISOString(),
        godotVersion: '4.4',
        capabilities: [],
      });
      writeInstanceFile(projectDir, {
        id: 'uuid-1', // same id, different data — project wins
        projectPath: 'D:/game1',
        projectName: 'game1',
        port: 9081,
        pid: 100,
        lastSeen: new Date().toISOString(),
        godotVersion: '4.5',
        capabilities: [],
      });
      writeInstanceFile(projectDir, {
        id: 'uuid-2',
        projectPath: 'D:/game2',
        projectName: 'game2',
        port: 9082,
        pid: 200,
        lastSeen: new Date().toISOString(),
        godotVersion: '4.4',
        capabilities: [],
      });

      const instances = await manager.loadFromRegistry();
      expect(instances).toHaveLength(2);
      const updated = instances.find(i => i.id === 'uuid-1');
      expect(updated?.godotVersion).toBe('4.5');
    });

    it('handles corrupt JSON files gracefully', async () => {
      mkdirSync(TMP, { recursive: true });
      writeFileSync(join(TMP, 'bad.json'), '{not valid json');
      writeFileSync(join(TMP, 'good.json'), JSON.stringify({
        id: 'uuid-good',
        projectPath: 'D:/game',
        projectName: 'game',
        port: 9081,
        pid: 100,
        lastSeen: new Date().toISOString(),
        godotVersion: '4.4',
        capabilities: [],
      }));

      const manager = new InstanceManager({ registryDir: TMP });
      const instances = await manager.loadFromRegistry();
      expect(instances).toHaveLength(1);
      expect(instances[0].id).toBe('uuid-good');
    });

    it('handles missing registry directory gracefully', async () => {
      const manager = new InstanceManager({ registryDir: join(TMP, 'nonexistent') });
      const instances = await manager.loadFromRegistry();
      expect(instances).toHaveLength(0);
    });
  });

  describe('zombie detection', () => {
    it('reports alive for recent instance', () => {
      const manager = new InstanceManager({ registryDir: TMP });
      const status = manager.getStatus({
        id: 'uuid-1',
        projectPath: 'D:/game',
        projectName: 'game',
        port: 9081,
        pid: 100,
        lastSeen: new Date().toISOString(),
        godotVersion: '4.4',
        capabilities: [],
      });
      expect(status).toBe('alive');
    });

    it('reports stale for old instance', () => {
      const manager = new InstanceManager({ registryDir: TMP });
      const oldDate = new Date(Date.now() - 80000).toISOString();
      const status = manager.getStatus({
        id: 'uuid-1',
        projectPath: 'D:/game',
        projectName: 'game',
        port: 9081,
        pid: 100,
        lastSeen: oldDate,
        godotVersion: '4.4',
        capabilities: [],
      });
      expect(status).toBe('stale');
    });
  });

  describe('port range', () => {
    it('default port range is 9081-9090', () => {
      const manager = new InstanceManager({ registryDir: TMP });
      expect(manager.portRange).toEqual([9081, 9090]);
    });

    it('custom port range from env var', () => {
      const original = process.env.GODOT_MCP_INSTANCE_PORT_RANGE;
      process.env.GODOT_MCP_INSTANCE_PORT_RANGE = '9000-9010';
      const manager = new InstanceManager({ registryDir: TMP });
      expect(manager.portRange).toEqual([9000, 9010]);
      if (original !== undefined) process.env.GODOT_MCP_INSTANCE_PORT_RANGE = original;
      else delete process.env.GODOT_MCP_INSTANCE_PORT_RANGE;
    });

    it('rejects port 0 from empty range segment', () => {
      const original = process.env.GODOT_MCP_INSTANCE_PORT_RANGE;
      process.env.GODOT_MCP_INSTANCE_PORT_RANGE = '-9090';
      const manager = new InstanceManager({ registryDir: TMP });
      expect(manager.portRange).toEqual([9081, 9090]);
      if (original !== undefined) process.env.GODOT_MCP_INSTANCE_PORT_RANGE = original;
      else delete process.env.GODOT_MCP_INSTANCE_PORT_RANGE;
    });

    it('rejects out-of-range ports', () => {
      const original = process.env.GODOT_MCP_INSTANCE_PORT_RANGE;
      process.env.GODOT_MCP_INSTANCE_PORT_RANGE = '0-70000';
      const manager = new InstanceManager({ registryDir: TMP });
      expect(manager.portRange).toEqual([9081, 9090]);
      if (original !== undefined) process.env.GODOT_MCP_INSTANCE_PORT_RANGE = original;
      else delete process.env.GODOT_MCP_INSTANCE_PORT_RANGE;
    });
  });

  describe('async loadFromRegistry', () => {
    it('loadFromRegistry returns asynchronously', async () => {
      const dir = join(tmpdir(), 'godot-mcp-test-async-' + Date.now());
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'inst1.json'), JSON.stringify({
        id: 'async-1', port: 9081, projectPath: 'D:/a', projectName: 'a', pid: 1,
        lastSeen: new Date().toISOString(), godotVersion: '4.4', capabilities: [],
      }));

      const mgr = new InstanceManager({ registryDir: dir });
      const result = await mgr.loadFromRegistry();
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('async-1');

      rmSync(dir, { recursive: true, force: true });
    });
  });

});
