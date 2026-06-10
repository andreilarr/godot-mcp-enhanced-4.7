// src/core/instance-router.ts
/**
 * InstanceRouter — request routing with switch lock (Phase 2b)
 *
 * Routes tool requests to the currently selected Godot instance.
 * Instance switching is atomic: in-flight requests complete before the switch.
 */

import type { InstanceInfo } from './instance-manager.js';
import type { ToolResult } from '../types.js';

export interface RouterDependencies {
  instances: InstanceInfo[];
  sendToInstance: (instance: InstanceInfo, toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;
  onInstanceChanged?: (instance: InstanceInfo | null) => void;
}

export class InstanceRouter {
  private deps: RouterDependencies;
  private selectedId: string | null = null;
  private inflightCount = 0;
  private inflightZero: Promise<void> = Promise.resolve();
  private inflightZeroResolve: (() => void) | null = null;

  constructor(deps: RouterDependencies) {
    this.deps = deps;
  }

  /** Get currently selected instance id. */
  getSelectedId(): string | null {
    return this.selectedId;
  }

  /** Get the currently selected InstanceInfo, or null. */
  getSelectedInstance(): InstanceInfo | null {
    if (!this.selectedId) return null;
    return this.deps.instances.find(i => i.id === this.selectedId) ?? null;
  }

  /**
   * Auto-select instance based on count:
   * - 0 instances → null
   * - 1 instance → auto-select
   * - 2+ instances → null (requires explicit selection)
   */
  autoSelect(): string | null {
    if (this.deps.instances.length === 1) {
      const inst = this.deps.instances[0];
      if (!inst) return null;
      this.selectedId = inst.id;
      return this.selectedId;
    }
    return null;
  }

  /** Select instance by id. Throws if not found. */
  async selectInstance(id: string): Promise<void> {
    const inst = this.deps.instances.find(i => i.id === id);
    if (!inst) throw new Error(`Instance not found: ${id}`);

    // Wait for all in-flight requests to complete (with timeout to prevent livelock)
    const deadline = Date.now() + 10_000; // 10s timeout
    while (this.inflightCount > 0) {
      if (Date.now() > deadline) {
        throw new Error(`selectInstance timed out: ${this.inflightCount} in-flight requests still pending after 10s`);
      }
      this.inflightZero = new Promise<void>(resolve => {
        this.inflightZeroResolve = resolve;
      });
      await this.inflightZero;
    }

    const prev = this.selectedId;
    this.selectedId = id;
    if (prev !== id) {
      this.deps.onInstanceChanged?.(inst);
    }
  }

  /** Select instance by project path. Returns selected id or null. */
  selectInstanceByProject(projectPath: string): string | null {
    const inst = this.deps.instances.find(i => i.projectPath === projectPath);
    if (!inst) return null;
    this.selectedId = inst.id;
    this.deps.onInstanceChanged?.(inst);
    return inst.id;
  }

  /** Route a tool request to the selected instance. Returns error string if no selection. */
  async route(toolName: string, args: Record<string, unknown>): Promise<ToolResult | string> {
    if (!this.selectedId) {
      return 'No instance selected. Use godot_select_instance first.';
    }
    const instance = this.deps.instances.find(i => i.id === this.selectedId);
    if (!instance) {
      this.selectedId = null;
      return 'Selected instance no longer available. Use godot_list_instances to discover.';
    }

    this.inflightCount++;
    try {
      return await this.deps.sendToInstance(instance, toolName, args);
    } finally {
      this.inflightCount--;
      if (this.inflightCount === 0 && this.inflightZeroResolve) {
        this.inflightZeroResolve();
        this.inflightZeroResolve = null;
      }
    }
  }

  /**
   * Resolve the best port for the selected instance using a priority chain:
   * 1. Original port still alive (same id + port in current instances)
   * 2. Same projectPath — pick most recent heartbeat
   * 3. Single instance available — use its port
   * 4. No match — null
   */
  async resolvePort(): Promise<number | null> {
    const selected = this.getSelectedInstance();
    if (!selected) return null;

    // 1. Original port still alive — use it
    const current = this.deps.instances.find(i => i.port === selected.port);
    if (current && current.id === selected.id) {
      return selected.port;
    }

    // 2. Same projectPath — pick most recent heartbeat
    const sameProject = this.deps.instances
      .filter(i => i.projectPath === selected.projectPath)
      .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));

    if (sameProject.length > 0) {
      return sameProject[0].port;
    }

    // 3. Single instance available
    if (this.deps.instances.length === 1) {
      return this.deps.instances[0].port;
    }

    // 4. No match
    return null;
  }

  /** Update the available instances list (e.g. after rediscovery). */
  updateInstances(instances: InstanceInfo[]): void {
    this.deps.instances = instances;
    // If selected instance is gone, clear selection
    if (this.selectedId && !instances.find(i => i.id === this.selectedId)) {
      this.selectedId = null;
    }
  }
}
