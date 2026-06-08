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
} from '../core/tool-registry.js';
import { opsSuccess, opsError } from './shared.js';

type ManageAction = 'list_groups' | 'activate' | 'deactivate' | 'sync' | 'reconnect';

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
            enum: ['list_groups', 'activate', 'deactivate', 'sync', 'reconnect'],
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
      annotations: { tags: ['group:core'] },
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
  return textResult(JSON.stringify(opsSuccess({
    deactivated: targetGroups,
    activeGroups: [...updated],
  })));
}

function handleSync(): ToolResult {
  const active = getActiveGroups();
  return textResult(JSON.stringify(opsSuccess({
    synced: true,
    activeGroups: [...active],
    note: 'Basic sync — Phase 4 will add connection-aware sync',
  })));
}

function handleReconnect(): ToolResult {
  return textResult(JSON.stringify(opsSuccess({
    reconnected: false,
    note: 'Reconnect will be implemented in Phase 4',
  })));
}

export const TOOL_META = {
  manage_tools: { readonly: true, long_running: false },
};
