// src/core/instance-manager.ts
/**
 * InstanceManager �?multi-instance discovery and registry management (Phase 2b)
 *
 * Discovers running Godot instances via:
 * 1. Machine-level registry: ~/.godot-mcp/instances/
 * 2. Project-level registry: {project}/.godot/mcp-instances/
 *
 * Each instance writes its own JSON file (no concurrent write contention).
 * Stale detection: lastSeen > staleTimeout �?stale status.
 */

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface InstanceInfo {
  id: string;
  projectPath: string;
  projectName: string;
  port: number;
  pid: number;
  lastSeen: string;       // ISO 8601
  godotVersion: string;
  capabilities: string[];  // e.g. ['registry-heartbeat']

  // Phase 2 新增（可选，旧插件不写此字段）
  status?: 'ready' | 'compiling' | 'unresponsive';
  registeredAt?: number;
}

export type InstanceStatus = 'alive' | 'stale' | 'unreachable';

/**
 * C-02 安全：类型守卫函数，验证 JSON 解析后的对象满足 InstanceInfo 必需字段。
 * 防止损坏/恶意 JSON 通过 as 强制转型后产生 undefined 行为。
 */
function isInstanceInfo(obj: unknown): obj is InstanceInfo {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.id === 'string' && o.id.length > 0 &&
    typeof o.projectPath === 'string' && o.projectPath.length > 0 &&
    typeof o.projectName === 'string' && o.projectName.length > 0 &&
    typeof o.port === 'number' && o.port >= 1 && o.port <= 65535 &&
    typeof o.pid === 'number' &&
    typeof o.lastSeen === 'string' && o.lastSeen.length > 0 &&
    typeof o.godotVersion === 'string' &&
    Array.isArray(o.capabilities) &&
    (o.capabilities as unknown[]).every(c => typeof c === 'string')
  );
}

export interface InstanceManagerOptions {
  /** Machine-level registry directory. Defaults to ~/.godot-mcp/instances/ */
  registryDir?: string;
  /** Project-level registry directory. Optional. */
  projectRegistryDir?: string;
  /** Stale timeout in ms. Defaults to 70000 (70s). */
  staleTimeoutMs?: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_STALE_TIMEOUT_MS = 70000; // 30s × 2 + 10s jitter margin
const DEFAULT_PORT_START = 9081;
const DEFAULT_PORT_END = 9090;

function getDefaultRegistryDir(): string {
  return join(homedir(), '.godot-mcp', 'instances');
}

function parsePortRange(): [number, number] {
  const env = process.env.GODOT_MCP_INSTANCE_PORT_RANGE;
  if (!env) return [DEFAULT_PORT_START, DEFAULT_PORT_END];
  const parts = env.split('-').map(Number);
  if (
    parts.length === 2 &&
    Number.isFinite(parts[0]) && Number.isFinite(parts[1]) &&
    parts[0]! >= 1 && parts[0]! <= 65535 &&
    parts[1]! >= 1 && parts[1]! <= 65535 &&
    parts[0]! < parts[1]!
  ) {
    return [parts[0]!, parts[1]!];
  }
  return [DEFAULT_PORT_START, DEFAULT_PORT_END];
}

// ─── InstanceManager ────────────────────────────────────────────────────────

export class InstanceManager {
  private readonly registryDir: string;
  private readonly projectRegistryDir?: string;
  private readonly staleTimeoutMs: number;
  private readonly _portRange: [number, number];
  private instances: Map<string, InstanceInfo> = new Map();

  constructor(opts: InstanceManagerOptions = {}) {
    this.registryDir = opts.registryDir ?? getDefaultRegistryDir();
    this.projectRegistryDir = opts.projectRegistryDir;
    this.staleTimeoutMs = opts.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
    this._portRange = parsePortRange();
  }

  /** Get configured port range. */
  get portRange(): [number, number] {
    return this._portRange;
  }

  /** Load instances from both registry levels. Machine-level first, then project-level overrides. */
  async loadFromRegistry(): Promise<InstanceInfo[]> {
    const merged = new Map<string, InstanceInfo>();

    // Machine-level first
    const machineInstances = await this.readRegistryDir(this.registryDir);
    for (const inst of machineInstances) {
      merged.set(inst.id, inst);
    }

    // Project-level overrides (project wins on duplicate id)
    if (this.projectRegistryDir) {
      const projectInstances = await this.readRegistryDir(this.projectRegistryDir);
      for (const inst of projectInstances) {
        merged.set(inst.id, inst);
      }
    }

    this.instances = merged;
    return [...merged.values()];
  }

  /** Get instance by id. */
  getInstance(id: string): InstanceInfo | undefined {
    return this.instances.get(id);
  }

  /** Get all loaded instances. */
  getAllInstances(): InstanceInfo[] {
    return [...this.instances.values()];
  }

  /** Determine status of an instance based on lastSeen timestamp. */
  getStatus(instance: InstanceInfo): InstanceStatus {
    // Phase 2: compiling overrides stale detection
    if (instance.status === 'compiling') {
      return 'alive';
    }
    if (instance.status === 'unresponsive') {
      return 'unreachable';
    }
    // Existing stale logic
    const lastSeen = new Date(instance.lastSeen).getTime();
    const elapsed = Date.now() - lastSeen;
    if (elapsed < this.staleTimeoutMs) return 'alive';
    return 'stale';
  }

  /** Read instance JSON files from a directory. Corrupt/invalid files are skipped. */
  private async readRegistryDir(dir: string): Promise<InstanceInfo[]> {
    const results: InstanceInfo[] = [];
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const content = await readFile(join(dir, file), 'utf-8');
          const parsed = JSON.parse(content);
          // C-02 安全：使用类型守卫验证所有必需字段
          if (!isInstanceInfo(parsed)) continue;
          // C-02 安全：路径遍历检查 — 原始路径含 .. 或 normalize 后仍含 .. 段
          if (parsed.projectPath.includes('..')) continue;
          results.push(parsed);
        } catch {
          // Skip corrupt/invalid files (ENOENT, SyntaxError, etc.)
        }
      }
    } catch {
      // Directory doesn't exist �?return empty
    }
    return results;
  }
}

/** Convenience: get machine-level registry directory path. */
export function getMachineRegistryDir(): string {
  return getDefaultRegistryDir();
}

/** Convenience: discover all instances. Creates a temporary manager and runs discovery. */
export async function discoverInstances(opts?: InstanceManagerOptions): Promise<InstanceInfo[]> {
  const manager = new InstanceManager(opts);
  return await manager.loadFromRegistry();
}
