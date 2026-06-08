// src/tools/advanced-proxy.ts
/**
 * Advanced proxy — godot_advanced_tool (Phase 3a)
 *
 * Proxy tool that allows calling deactivated/advanced tools in slim mode.
 * Belongs to the 'core' group (always visible, cannot be deactivated).
 * Provides fuzzy matching suggestions for invalid tool names.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult, getErrorMessage, type ToolCallDelegate } from '../types.js';
import { opsError } from './shared.js';
import {
  isToolAllowed,
  getAllToolNames,
} from '../core/tool-registry.js';

// ─── Delegate (set by ToolDispatcher to enable re-dispatch) ─────────────────

let _delegate: ToolCallDelegate | null = null;

export function setToolCallDelegate(fn: ToolCallDelegate | null): void {
  _delegate = fn;
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
  ];
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult | null> {
  if (toolName !== 'godot_advanced_tool') return null;

  const targetTool = args.tool_name as string | undefined;
  if (!targetTool || typeof targetTool !== 'string') {
    return textResult(JSON.stringify(opsError('MISSING_TOOL_NAME', 'tool_name is required')));
  }

  // Reject if the tool is already directly available
  if (isToolAllowed(targetTool)) {
    return textResult(JSON.stringify(opsError('TOOL_ALREADY_AVAILABLE',
      `Tool "${targetTool}" is already directly available. Call it directly instead of through the proxy.`)));
  }

  // Check if tool exists at all
  const allNames = getAllToolNames();
  if (!allNames.includes(targetTool)) {
    const suggestions = suggestTools(targetTool, allNames);
    return textResult(JSON.stringify({
      success: false,
      error_code: 'UNKNOWN_TOOL',
      message: `Unknown tool '${targetTool}'.`,
      suggestions,
    }));
  }

  // Delegate the call
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

export const TOOL_META = {
  // Proxy itself doesn't write — readonly=true so it works in read-only mode.
  // Target tool's readonly check happens inside handleCall's middleware chain.
  godot_advanced_tool: { readonly: true, long_running: true },
};
