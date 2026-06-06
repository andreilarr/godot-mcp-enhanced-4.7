// src/core/tool-registry.ts

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult, ToolContext } from '../types.js';

// ─── Tool metadata ──────────────────────────────────────────────────────────

export interface ToolMeta {
  name: string;
  readonly: boolean;
  long_running: boolean;
}

// ─── Tool module interface ───────────────────────────────────────────────────

export interface ToolModule {
  TOOL_META?: Record<string, { readonly: boolean; long_running: boolean }>;
  getToolDefinitions(): Tool[];
  handleTool(toolName: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null>;
}

// ─── Internal state ─────────────────────────────────────────────────────────

const metaRegistry = new Map<string, ToolMeta>();
const moduleRegistry = new Map<string, ToolModule>();
const modules: ToolModule[] = [];

// ─── Module registration ────────────────────────────────────────────────────

/** Register a tool module. Called once per module at import time. */
export function registerModule(mod: ToolModule): void {
  if (modules.includes(mod)) return; // idempotent
  modules.push(mod);
  const meta = mod.TOOL_META;
  if (meta) {
    for (const [name, m] of Object.entries(meta)) {
      const entry: ToolMeta = { name, ...m };
      metaRegistry.set(name, entry);
      moduleRegistry.set(name, mod);
    }
  } else {
    // A-10: Auto-register default TOOL_META from getToolDefinitions() when
    // the module doesn't provide one. This eliminates the manual sync burden
    // (tool name written 3 times: definitions, TOOL_META, handleTool).
    // Default: readonly=false, long_running=false.
    const toolNames = mod.getToolDefinitions().map(t => t.name);
    for (const name of toolNames) {
      const entry: ToolMeta = { name, readonly: false, long_running: false };
      metaRegistry.set(name, entry);
      moduleRegistry.set(name, mod);
    }
  }
}

// ─── Inline tool registration ────────────────────────────────────────────────

/** Register an inline tool's metadata (for tools not in a ToolModule). */
export function registerInlineTool(name: string, meta: Omit<ToolMeta, 'name'>): void {
  metaRegistry.set(name, { name, ...meta });
}

// ─── Query functions ─────────────────────────────────────────────────────────

/** Check whether a tool name is registered in the meta registry. */
export function isKnownTool(name: string): boolean {
  return metaRegistry.has(name);
}

export function isReadOnly(name: string): boolean {
  return metaRegistry.get(name)?.readonly ?? false;
}

export function isLongRunning(name: string): boolean {
  return metaRegistry.get(name)?.long_running ?? false;
}

export function getReadOnlyTools(): string[] {
  return [...metaRegistry.entries()].filter(([, m]) => m.readonly).map(([n]) => n);
}

export function getWriteTools(): string[] {
  return [...metaRegistry.entries()].filter(([, m]) => !m.readonly).map(([n]) => n);
}

export function getAllToolNames(): string[] {
  return [...metaRegistry.keys()];
}

export function getToolMeta(name: string): ToolMeta | undefined {
  return metaRegistry.get(name);
}

export function getModuleForTool(name: string): ToolModule | undefined {
  return moduleRegistry.get(name);
}

export function getAllToolDefinitions(): Tool[] {
  return modules.flatMap(m => m.getToolDefinitions());
}

export function getModules(): readonly ToolModule[] {
  return modules;
}

// ─── Legacy API (backward compat) ───────────────────────────────────────────

/** Register tools from flat array (legacy, used by tests). */
export function registerTools(tools: ToolMeta[]): void {
  for (const t of tools) {
    metaRegistry.set(t.name, t);
  }
}

/** Clear all registered tools and modules (test-only). */
export function clearRegistry(): void {
  metaRegistry.clear();
  moduleRegistry.clear();
  modules.length = 0;
}

// ─── Tool groups ─────────────────────────────────────────────────────────────

/** 16 tool groups for fine-grained profile configuration. */
export const TOOL_GROUPS: Record<string, string[]> = {
  core:       ['project', 'scene', 'script', 'runtime', 'validation', 'confirm_and_execute'],
  editor:     ['editor'],
  bridge:     ['game'],
  animation:  ['animation', 'animtree', 'animation_track'],
  audio:      ['audio'],
  visual:     ['material', 'screenshot', 'particles'],
  physics:    ['physics', 'node_create_3d'],
  navigation: ['nav'],
  ui:         ['ui'],
  tilemap:    ['tilemap', 'scene_commit'],
  signal:     ['signal'],
  profiler:   ['profiler', 'workflow'],
  test:       ['test', 'verify_delivery'],
  code:       ['docs', 'templates', 'batch', 'game_design'],
  ik:         ['ik'],
  recording:  ['recording'],
};

/** 5 preset profiles. Each maps to an array of group names. */
export const PROFILES: Record<string, string[]> = {
  full:        Object.keys(TOOL_GROUPS),
  // BREAKING CHANGE: lite now uses group-based expansion (matches current LITE_TOOLS content)
  lite:        ['core', 'bridge', 'animation', 'audio', 'signal', 'visual', 'code', 'test', 'profiler'],
  minimal:     ['core'],
  bridge_dev:  ['core', 'bridge', 'profiler', 'test', 'recording'],
  '3d_dev':    ['core', 'animation', 'visual', 'physics', 'navigation', 'ik'],  // physics includes node_create_3d
};

/** Expand an array of group names to a deduplicated set of tool names. */
export function expandGroups(groups: string[]): Set<string> {
  const tools = new Set<string>();
  for (const g of groups) {
    const groupTools = TOOL_GROUPS[g];
    if (groupTools) {
      for (const t of groupTools) tools.add(t);
    }
  }
  return tools;
}

/** Resolve a profile name (or comma-separated group list) to a Set of tool names. */
export function resolveProfile(profile: string): Set<string> {
  // Check if it's a known profile name
  const profileGroups = PROFILES[profile];
  if (profileGroups) {
    return expandGroups(profileGroups);
  }
  // Treat as comma-separated group names
  const groups = profile.split(',').map(g => g.trim()).filter(Boolean);
  return expandGroups(groups);
}

// ─── Mode filters ────────────────────────────────────────────────────────────

// LITE/MINIMAL mode tool sets — now derived from PROFILES to avoid manual drift.
// BREAKING CHANGE: LITE_TOOLS expanded to include visual (material,screenshot,particles)
// and code (docs,templates,batch,game_design) groups. Previously these were listed
// individually as 'material', 'docs', 'screenshot' etc.
export const LITE_TOOLS: Set<string> = resolveProfile('lite');

export const MINIMAL_TOOLS: Set<string> = resolveProfile('minimal');
