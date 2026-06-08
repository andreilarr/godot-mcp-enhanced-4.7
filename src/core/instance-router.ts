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
      this.selectedId = this.deps.instances[0].id;
      return this.selectedId;
    }
    return null;
  }

  /** Select instance by id. Throws if not found. */
  async selectInstance(id: string): Promise<void> {
    const inst = this.deps.instances.find(i => i.id === id);
    if (!inst) throw new Error(`Instance not found: ${id}`);

    // Wait for all in-flight requests to complete
    while (this.inflightCount > 0) {
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

  /** Update the available instances list (e.g. after rediscovery). */
  updateInstances(instances: InstanceInfo[]): void {
    this.deps.instances = instances;
    // If selected instance is gone, clear selection
    if (this.selectedId && !instances.find(i => i.id === this.selectedId)) {
      this.selectedId = null;
    }
  }
}
