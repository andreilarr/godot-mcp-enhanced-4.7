import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';

// ─── 已迁移到 physics-ops.ts ────────────────────────────────────────────────
// spatial_info 工具已合并到 physics 工具（query_spatial 操作语义对应 spatial_info 的 3D 空间查询）
// 本文件保留空壳以避免 GodotServer.ts 导入报错，后续可安全删除

export function getToolDefinitions(): Tool[] {
  return [];
}

export async function handleTool(
  _name: string,
  _args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult | null> {
  return null;
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {};
