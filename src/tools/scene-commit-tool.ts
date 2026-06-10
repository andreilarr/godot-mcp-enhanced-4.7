// src/tools/scene-commit-tool.ts
// P2: MCP tool wrapper for scene_commit.

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { requireProjectPath, resolveWithinRoot, normalizeUserProjectPath } from '../helpers.js';
import { executeGdscript } from '../gdscript-executor.js';
import { generateCommitScript, type CommitOperation } from './scene-commit.js';
import { acquireShortRunningSlot, releaseShortRunningSlot } from '../core/process-state.js';
import { opsErrorResult } from './shared.js';

export function getToolDefinitions(): Tool[] {
  return [{
    name: 'scene_commit',
    description: '批量执行场景修改操作（tile_set/tile_fill/tile_erase/tile_clear/tileset_assign/node_property/node_add），合并为一次 Godot 进程调用。适合需要持久化的批量修改。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
        scene_path: { type: 'string', description: '目标场景路径（如 res://scenes/Level.tscn）' },
        operations: {
          type: 'array',
          description: '操作列表',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['tile_set', 'tile_fill', 'tile_erase', 'tile_clear', 'tileset_assign', 'node_property', 'node_add'] },
              node_path: { type: 'string', description: 'TileMap/TileMapLayer 节点路径（tile 操作必需）' },
              coords: { type: 'object', description: '图块坐标 {x, y}' },
              region: { type: 'object', description: '矩形区域 {x, y, w, h}' },
              source_id: { type: 'number', description: 'TileSet 源 ID' },
              atlas: { type: 'object', description: '图集坐标 {x, y}' },
              alternative_tile: { type: 'number', description: '替代图块索引（默认 0）' },
              tileset_path: { type: 'string', description: 'TileSet 资源路径（tileset_assign）' },
              path: { type: 'string', description: '节点路径（node_property）' },
              property: { type: 'string', description: '属性名' },
              value: { description: '属性值' },
              parent: { type: 'string', description: '父节点路径（node_add）' },
              name: { type: 'string', description: '节点名称（node_add）' },
              type: { type: 'string', description: '节点类型（node_add）' },
            },
            required: ['op'],
          },
        },
        save: { type: 'boolean', description: '是否保存到文件（默认 true）', default: true },
        stop_on_error: { type: 'boolean', description: '遇错是否停止（默认 true）', default: true },
      },
      required: ['scene_path', 'operations'],
    },
  }];
}

// ─── Core handler (shared by handleTool and scene module) ─────────────────

export async function handleCommitAction(
  args: Record<string, unknown>, ctx: ToolContext,
): Promise<ToolResult | null> {
  const p = requireProjectPath(args);
  const scenePath = normalizeUserProjectPath(args.scene_path as string);
  resolveWithinRoot(p, scenePath);
  const operations = args.operations as Array<Record<string, unknown>>;
  const save = args.save !== false;
  const stopOnError = args.stop_on_error !== false;

  if (!operations || !Array.isArray(operations) || operations.length === 0) {
    return opsErrorResult('INVALID_PARAMS', 'operations must be a non-empty array');
  }
  if (operations.length > 500) {
    return opsErrorResult('INVALID_PARAMS', `Too many operations (${operations.length}). Maximum: 500`);
  }

  // Generate GDScript
  const resPath = `res://${scenePath.replace(/\\/g, '/')}`;
  const script = generateCommitScript(
    resPath,
    operations as unknown as CommitOperation[],
    save,
    stopOnError,
  );

  // Execute via Godot process
  if (!acquireShortRunningSlot()) {
    return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
  }

  try {
    const godot = await ctx.findGodot();
    const result = await executeGdscript({
      godotPath: godot,
      projectPath: p,
      code: script,
      timeout: 120,
      loadAutoloads: false,
    });

    // Parse COMMIT_RESULT from output
    const commitResult = parseCommitResult(result.raw_output || result.run_error || '');
    return textResult(JSON.stringify(commitResult || {
      success: result.run_success,
      raw_output: result.raw_output,
      errors: result.errors,
    }, null, 2));
  } finally {
    releaseShortRunningSlot();
  }
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

export async function handleTool(
  name: string, args: Record<string, unknown>, ctx: ToolContext,
): Promise<ToolResult | null> {
  if (name !== 'scene_commit') return null;
  return handleCommitAction(args, ctx);
}

/** Parse COMMIT_RESULT JSON from GDScript output. */
export function parseCommitResult(output: string): Record<string, unknown> | null {
  const marker = 'COMMIT_RESULT: ';
  const idx = output.lastIndexOf(marker);
  if (idx === -1) return null;
  try {
    const after = output.slice(idx + marker.length);
    // Find the end of the JSON value — match balanced braces
    let depth = 0;
    let end = -1;
    for (let i = 0; i < after.length; i++) {
      if (after[i] === '{') depth++;
      else if (after[i] === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end === -1) return null;
    return JSON.parse(after.slice(0, end));
  } catch {
    return null;
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  scene_commit: { readonly: false, long_running: true },
};
