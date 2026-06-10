// src/tools/manage-tools.ts — manage_tools meta-tool (Task 4)
//
// Always-available tool for dynamically managing tool group activation.
// Belongs to the protected 'core' group and cannot be deactivated.

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import {
  TOOL_GROUPS,
  setActiveGroups,
  getActiveGroups,
  notifyToolsChanged,
  LEGACY_TOOL_MAP,
} from '../core/tool-registry.js';
import { opsSuccess, opsError } from './shared.js';

type ManageAction = 'list_groups' | 'activate' | 'deactivate' | 'sync' | 'reconnect' | 'migrate';

/** Optional callback fired when groups change (set by GodotServer). */
let _onGroupsChanged: (() => void) | null = null;

/** Set notification callback (called by GodotServer). */
export function setOnGroupsChanged(fn: (() => void) | null): void {
  _onGroupsChanged = fn;
}

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'manage_tools',
      description:
        '动态管理工具组的启用/停用状态。始终可用，不可被禁用。' +
        '支持 list_groups（列出所有组）、activate（启用组）、deactivate（停用组）、sync（同步连接状态）、reconnect（手动重连）。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['list_groups', 'activate', 'deactivate', 'sync', 'reconnect', 'migrate'],
            description: '操作类型',
          },
          groups: {
            type: 'array',
            items: { type: 'string' },
            description: '目标组名数组（activate/deactivate 时使用）',
          },
        },
        required: ['action'],
      },
    },
  ];
}

export async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult | null> {
  if (toolName !== 'manage_tools') return null;

  const action = args.action as ManageAction;

  switch (action) {
    case 'list_groups': return handleListGroups();
    case 'activate': return handleActivate(args);
    case 'deactivate': return handleDeactivate(args);
    case 'sync': return handleSync();
    case 'reconnect': return handleReconnect();
    case 'migrate': return handleMigrate();
    default:
      return textResult(JSON.stringify(opsError('INVALID_ACTION', `Unknown action: ${action}`)));
  }
}

function handleListGroups(): ToolResult {
  const active = getActiveGroups();
  const groups = Object.entries(TOOL_GROUPS).map(([name, def]) => ({
    name,
    description: def.description,
    active: active.has(name),
    protected: def.protected ?? false,
    requires: def.requires,
    toolCount: def.tools.length,
  }));
  return textResult(JSON.stringify(opsSuccess({ groups })));
}

function handleActivate(args: Record<string, unknown>): ToolResult {
  const targetGroups = (args.groups as string[]) ?? [];
  if (targetGroups.length === 0) {
    return textResult(JSON.stringify(opsError('MISSING_GROUPS', 'groups array is required for activate')));
  }
  const current = getActiveGroups();
  const updated = new Set(current);
  for (const g of targetGroups) {
    if (TOOL_GROUPS[g]) updated.add(g);
  }
  setActiveGroups(updated);
  _onGroupsChanged?.();
  notifyToolsChanged();
  return textResult(JSON.stringify(opsSuccess({
    activated: targetGroups,
    activeGroups: [...updated],
  })));
}

function handleDeactivate(args: Record<string, unknown>): ToolResult {
  const targetGroups = (args.groups as string[]) ?? [];
  if (targetGroups.length === 0) {
    return textResult(JSON.stringify(opsError('MISSING_GROUPS', 'groups array is required for deactivate')));
  }
  // Reject attempts to deactivate protected groups
  const protectedNames = targetGroups.filter(g => TOOL_GROUPS[g]?.protected);
  if (protectedNames.length > 0) {
    return textResult(JSON.stringify(opsError(
      'PROTECTED_GROUP',
      `Cannot deactivate protected groups: ${protectedNames.join(', ')}`,
    )));
  }
  const current = getActiveGroups();
  const updated = new Set(current);
  for (const g of targetGroups) updated.delete(g);
  setActiveGroups(updated);
  _onGroupsChanged?.();
  notifyToolsChanged();
  return textResult(JSON.stringify(opsSuccess({
    deactivated: targetGroups,
    activeGroups: [...updated],
  })));
}

function handleSync(): ToolResult {
  return textResult(JSON.stringify(opsError('NOT_IMPLEMENTED', 'Connection-aware sync is not yet implemented. Active groups are always in sync.')));
}

function handleReconnect(): ToolResult {
  return textResult(JSON.stringify(opsError('NOT_IMPLEMENTED', 'Auto-reconnect is not yet implemented. Check that the game/editor is running.')));
}

export const TOOL_META = {
  manage_tools: { readonly: true, long_running: false },
};

function handleMigrate(): ToolResult {
  const mapping: Record<string, { tool: string; action: string }> = {};
  const renamed: Record<string, string> = {};
  const removed: string[] = [];
  const unchanged = ['confirm_and_execute', 'godot_advanced_tool', 'manage_tools', 'godot_list_instances', 'godot_select_instance'];

  for (const [oldName, target] of Object.entries(LEGACY_TOOL_MAP)) {
    mapping[oldName] = target;
    removed.push(oldName);
    if (oldName.includes('_')) {
      renamed[oldName] = `${target.tool}(action="${target.action}")`;
    }
  }

  return textResult(JSON.stringify(opsSuccess({
    version: '0.18.0',
    description: '旧工具名到新 (tool, action) 的迁移映射',
    mapping,
    renamed,
    removed,
    unchanged,
  })));
}
