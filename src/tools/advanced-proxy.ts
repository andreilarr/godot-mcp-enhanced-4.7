// src/tools/advanced-proxy.ts
/**
 * Advanced proxy — godot_advanced_tool + godot_list_dynamic_routes (Phase 3)
 *
 * Proxy tool that allows calling deactivated/advanced tools in slim mode,
 * and dynamic routing for tools that exist on the Godot side but aren't
 * registered on the MCP side.
 *
 * Belongs to the 'dynamic' group. Provides fuzzy matching suggestions for
 * invalid tool names, and structured dynamic routing for unknown godot_ tools.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult, getErrorMessage, type ToolCallDelegate } from '../types.js';
import { opsError } from './shared.js';
import {
  isToolAllowed,
  getAllToolNames,
  getActiveGroups,
} from '../core/tool-registry.js';
import { toolNameToRoute } from '../core/dynamic-routes.js';

// ─── Delegate (set by ToolDispatcher to enable re-dispatch) ─────────────────

let _delegate: ToolCallDelegate | null = null;
let _dynamicSender: ((route: string, args: Record<string, unknown>) => Promise<ToolResult>) | null = null;

export function setToolCallDelegate(fn: ToolCallDelegate | null): void {
  _delegate = fn;
}

/** Inject HTTP sender for dynamic routing. Called by GodotServer during init. */
export function setDynamicSender(fn: ((route: string, args: Record<string, unknown>) => Promise<ToolResult>) | null): void {
  _dynamicSender = fn;
}

// ─── Fuzzy matching ─────────────────────────────────────────────────────────

/** Levenshtein distance for fuzzy matching. */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m]![n]!;
}

/** Get up to N closest tool names by edit distance. */
function suggestTools(input: string, candidates: string[], maxResults = 3): string[] {
  const scored = candidates.map(name => ({ name, dist: levenshtein(input.toLowerCase(), name.toLowerCase()) }));
  scored.sort((a, b) => a.dist - b.dist);
  return scored.slice(0, maxResults).filter(s => s.dist <= Math.max(3, Math.floor(input.length / 2))).map(s => s.name);
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  // Build dynamic description listing currently deactivated tools
  const allNames = getAllToolNames();
  const deactivated = allNames.filter(name => !isToolAllowed(name) && name !== 'godot_advanced_tool');

  let desc = 'Proxy tool for calling advanced/deactivated Godot tools. ' +
    'Call with { tool_name: "<name>", arguments: {...} }.';

  if (deactivated.length > 0) {
    desc += `\n\nCurrently proxyable tools: ${deactivated.join(', ')}`;
  } else {
    desc += '\n\nAll tools are currently directly available — no proxy needed.';
  }

  return [
    {
      name: 'godot_advanced_tool',
      description: desc,
      inputSchema: {
        type: 'object' as const,
        properties: {
          tool_name: {
            type: 'string',
            description: '要调用的目标工具名',
          },
          arguments: {
            type: 'object',
            description: '传给目标工具的参数',
          },
        },
        required: ['tool_name'],
      },
    },
    {
      name: 'godot_list_dynamic_routes',
      description: '查询 Godot 端已注册但 MCP 侧未定义的工具。需要 Godot 实例连接。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          category: {
            type: 'string',
            description: '按类别过滤（可选）',
          },
        },
      },
    },
  ];
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult | null> {
  // Route: godot_list_dynamic_routes
  if (toolName === 'godot_list_dynamic_routes') {
    return handleListDynamicRoutes(args);
  }

  // Route: godot_advanced_tool
  if (toolName !== 'godot_advanced_tool') return null;

  const targetTool = args.tool_name as string | undefined;
  if (!targetTool || typeof targetTool !== 'string') {
    return textResult(JSON.stringify(opsError('MISSING_TOOL_NAME', 'tool_name is required')));
  }

  // Security gate: reject non-godot_ prefixed tools in dynamic path
  const hasGodotPrefix = targetTool.startsWith('godot_');

  // Reject if the tool is already directly available
  if (isToolAllowed(targetTool)) {
    return textResult(JSON.stringify(opsError('TOOL_ALREADY_AVAILABLE',
      `Tool "${targetTool}" is already directly available. Call it directly instead of through the proxy.`)));
  }

  // Check if tool exists in the registry
  const allNames = getAllToolNames();
  if (allNames.includes(targetTool)) {
    // Tool is known but deactivated — delegate the call
    return delegateCall(targetTool, args);
  }

  // ── Dynamic fallback: tool not in registry ─────────────────────────────────
  // Only allow dynamic routing for godot_-prefixed tools
  if (!hasGodotPrefix) {
    const suggestions = suggestTools(targetTool, allNames);
    return textResult(JSON.stringify({
      success: false,
      error_code: 'UNKNOWN_TOOL',
      message: `Unknown tool '${targetTool}'.`,
      suggestions,
    }));
  }

  // Check if 'dynamic' group is active
  const activeGroups = getActiveGroups();
  if (!activeGroups.has('dynamic')) {
    return textResult(JSON.stringify(opsError('DYNAMIC_GROUP_INACTIVE',
      `Dynamic routing is not enabled. The 'dynamic' tool group is not active in the current profile.`)));
  }

  // Derive route from tool name
  const route = toolNameToRoute(targetTool);
  if (!route) {
    return textResult(JSON.stringify(opsError('INVALID_DYNAMIC_TOOL_NAME',
      `Cannot derive route from '${targetTool}'. Tool name must follow 'godot_<category>_<action>' convention.`)));
  }

  // Execute the dynamic route via injected HTTP sender
  const toolArgs = (args.arguments as Record<string, unknown>) ?? {};
  if (!_dynamicSender) {
    return textResult(JSON.stringify(opsError('NO_DYNAMIC_SENDER',
      'Dynamic routing sender not configured. Multi-instance mode may not be enabled.')));
  }

  try {
    return await _dynamicSender(route, toolArgs);
  } catch (err) {
    return textResult(JSON.stringify(opsError('DYNAMIC_ROUTE_ERROR', getErrorMessage(err))));
  }
}

// ─── Delegate helper ────────────────────────────────────────────────────────

/** Delegate a call to the target tool via the registered delegate. */
async function delegateCall(targetTool: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (!_delegate) {
    return textResult(JSON.stringify(opsError('NO_DELEGATE', 'Proxy delegate not configured')));
  }

  const toolArgs = (args.arguments as Record<string, unknown>) ?? {};
  try {
    return await _delegate(targetTool, toolArgs);
  } catch (err) {
    return textResult(JSON.stringify(opsError('PROXY_ERROR', getErrorMessage(err))));
  }
}

// ─── godot_list_dynamic_routes handler ──────────────────────────────────────

/** Handle godot_list_dynamic_routes: list registered vs dynamic tools. */
function handleListDynamicRoutes(args: Record<string, unknown>): ToolResult {
  const allNames = getAllToolNames();
  const category = args.category as string | undefined;

  const registered = allNames.filter(name => {
    if (category && !name.includes(category)) return false;
    return true;
  });

  return textResult(JSON.stringify({
    success: true,
    total_registered: registered.length,
    registered,
    dynamic_routing_enabled: getActiveGroups().has('dynamic'),
    hint: 'Dynamic tools are discovered at runtime from the Godot instance. ' +
      'Use godot_advanced_tool with tool_name starting with "godot_" to call dynamic tools.',
  }));
}

export const TOOL_META = {
  // Proxy itself doesn't write — readonly=true so it works in read-only mode.
  // Target tool's readonly check happens inside handleCall's middleware chain.
  godot_advanced_tool: { readonly: true, long_running: true },
  godot_list_dynamic_routes: { readonly: true, long_running: false },
};
