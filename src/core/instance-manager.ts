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
}

export type InstanceStatus = 'alive' | 'stale' | 'unreachable';

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
          // Validate required fields
          if (parsed.id && parsed.port && parsed.projectPath) {
            results.push(parsed as InstanceInfo);
          }
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
