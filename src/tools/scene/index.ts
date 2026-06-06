// Scene tool entry point: definitions, handler, and meta.

import { join, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../../types.js';
import { textResult, errorResult } from '../../types.js';
import { requireProjectPath, resolveWithinRoot, normalizeUserProjectPath, ensureDir, parseMcpScriptOutput } from '../../helpers.js';
import { parseTscn, parseTscnSummary } from '../../tscn-parser.js';
import { executeGdscript } from '../../gdscript-executor.js';
import { normalizeNodePath, gdEscape, toSnakeCase, SCENE_TREE_HEADER, opsErrorResult, parseGdscriptResult, sanitizeResPath } from '../shared.js';
import { addNode } from '../../tscn-editor.js';
import { acquireShortRunningSlot, releaseShortRunningSlot } from '../../core/process-state.js';
import { spawnGodot } from '../spawn-helper.js';
import { ACTIONS, requireScenePath, gdScriptSetLine, TRY_SET_HELPER, writeAtomic, BLOCKED_PROPS } from './helpers.js';
import { handleInstanceScene, handleSetInstanceProperty, handleDetachInstance } from './scene-instance.js';
import { mergeTscn, checkSceneHealth } from './scene-merge.js';

export { mergeTscn, checkSceneHealth };

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'scene',
      description: '场景操作。读取/创建: read_scene, create_scene, quick_scene。节点: add_node, batch_add_nodes, edit_node, remove_node。保存/资源: save_scene, load_sprite。查询: query_scene_tree, inspect_node。实例: instance_scene, set_instance_property, detach_instance。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: '操作类型',
          },
          scene_path: { type: 'string', description: '场景路径（read_scene 用绝对路径，其余用相对项目路径）' },
          summary_only: { type: 'boolean', description: 'read_scene: 返回摘要而非完整 JSON' },
          root_node_type: { type: 'string', description: 'create_scene/quick_scene: 根节点类型（默认 Node2D）' },
          root_node_name: { type: 'string', description: 'quick_scene: 根节点名称（默认从文件名推导 PascalCase）' },
          script_path: { type: 'string', description: 'quick_scene: 脚本路径（可选）' },
          script_content: { type: 'string', description: 'quick_scene: 脚本内容（脚本不存在时自动创建）' },
          node_type: { type: 'string', description: 'add_node: 节点类型（如 Sprite2D, Camera2D）' },
          node_name: { type: 'string', description: 'add_node: 节点名称' },
          parent_node_path: { type: 'string', description: 'add_node/instance_scene: 父节点路径（默认 root）' },
          properties: { type: 'object', description: 'add_node/edit_node/instance_scene: 属性对象' },
          new_path: { type: 'string', description: 'save_scene: 新保存路径（可选）/ merge_scene: theirs 场景路径（必需）' },
          texture_path: { type: 'string', description: 'load_sprite: 纹理路径（如 res://assets/player.png）' },
          node_path: { type: 'string', description: 'inspect_node/edit_node/remove_node/load_sprite/detach_instance/set_instance_property: 节点路径' },
          max_depth: { type: 'number', description: 'query_scene_tree/inspect_node: 最大遍历深度' },
          include_signals: { type: 'boolean', description: 'inspect_node: 包含信号连接（默认 true）' },
          include_properties: { type: 'boolean', description: 'inspect_node: 包含属性值（默认 true）' },
          nodes: {
            type: 'array',
            description: 'batch_add_nodes: 节点定义数组',
            items: {
              type: 'object',
              properties: {
                node_type: { type: 'string', description: '节点类型' },
                node_name: { type: 'string', description: '节点名称' },
                parent_node_path: { type: 'string', description: '父路径（默认 root）' },
                properties: { type: 'object', description: '属性' },
              },
              required: ['node_type', 'node_name'],
            },
          },
          instance_path: { type: 'string', description: 'instance_scene: 要实例化的场景文件（res://scenes/player.tscn）' },
          property: { type: 'string', description: 'set_instance_property: 属性名' },
          value: { description: 'set_instance_property: 属性值（string/number/bool/null/array）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'action'],
      },
    },
  ];
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

export async function handleTool(
  name: string, args: Record<string, unknown>, ctx: ToolContext
): Promise<ToolResult | null> {
  if (name !== 'scene') return null;

  const action = args.action as string;
  if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');

  switch (action) {
    case 'read_scene': {
      const spErr = requireScenePath(args.scene_path);
      if (spErr) return spErr;
      const sp = resolveWithinRoot(requireProjectPath(args), normalizeUserProjectPath(args.scene_path as string));
      if (!existsSync(sp)) return textResult(`Scene file not found: ${sp}`);
      const content = readFileSync(sp, 'utf-8');
      if (args.summary_only) return textResult(parseTscnSummary(content));
      const parsed = parseTscn(content);
      const roots = parsed.nodes.filter(n => !n.parent);
      return textResult(JSON.stringify({ header: parsed.header, extResources: parsed.extResources, subResources: parsed.subResources, nodeTree: roots, connections: parsed.connections, totalNodes: parsed.nodes.length }, null, 2));
    }

    // P1 file-op shortcut for add_node: try pure text editing first,
    // fall through to spawnGodot if properties are unsupported.
    case 'add_node': {
      // Validate params
      const p = requireProjectPath(args);
      const sceneRelPath = normalizeUserProjectPath(args.scene_path as string);
      if (!/^[A-Za-z0-9_]+$/.test(String(args.node_type ?? ''))) {
        return textResult(`Error: node_type contains invalid characters: "${args.node_type}"`);
      }
      if (!String(args.node_name ?? '') || /[\]["/:\\]/.test(String(args.node_name))) {
        return textResult(`Error: node_name contains invalid characters: "${args.node_name}"`);
      }

      const absPath = resolveWithinRoot(p, sceneRelPath);
      if (!existsSync(absPath)) {
        return opsErrorResult('FILE_NOT_FOUND', `Scene file not found: ${sceneRelPath}`);
      }

      // Convert parent_node_path to .tscn parent format
      const rawParent = String(args.parent_node_path || 'root');
      let tscnParent: string;
      if (rawParent === 'root' || rawParent === '/root' || rawParent === '') {
        tscnParent = '.';
      } else {
        // Strip "root/" prefix if present, keep the rest as tscn parent path
        const stripped = rawParent.replace(/^\/?root\/?/, '');
        tscnParent = stripped || '.';
      }

      const tscnContent = readFileSync(absPath, 'utf-8');
      const result = addNode(tscnContent, {
        parent: tscnParent,
        name: String(args.node_name),
        type: String(args.node_type),
        properties: args.properties as Record<string, unknown> | undefined,
      });

      if (result.success && result.fallback) {
        // Unsupported properties — fall through to spawnGodot path below
        break;
      }

      if (!result.success) {
        return textResult(`Error: ${result.message}`);
      }

      // Write back the modified .tscn
      if (result.scene) {
        writeFileSync(absPath, result.scene, 'utf-8');
      }
      return textResult(result.message);
    }

    case 'create_scene':
    case 'add_node':
    case 'save_scene':
    case 'load_sprite': {
      if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
      const p = requireProjectPath(args);
      let godot: string;
      try { godot = await ctx.findGodot(); } catch (e) { releaseShortRunningSlot(); throw e; }

      const params: Record<string, unknown> = {};
      if (action === 'create_scene') {
        params.scene_path = normalizeUserProjectPath(args.scene_path as string);
        params.root_node_type = args.root_node_type || 'Node2D';
      } else if (action === 'add_node') {
        params.scene_path = normalizeUserProjectPath(args.scene_path as string);
        if (!/^[A-Za-z0-9_]+$/.test(String(args.node_type ?? ''))) { releaseShortRunningSlot(); return textResult(`Error: node_type contains invalid characters: "${args.node_type}"`); }
        if (!String(args.node_name ?? '') || /[\]["/:\\]/.test(String(args.node_name))) { releaseShortRunningSlot(); return textResult(`Error: node_name contains invalid characters: "${args.node_name}"`); }
        params.node_type = args.node_type; params.node_name = args.node_name;
        params.parent_node_path = args.parent_node_path || 'root';
        if (args.properties) params.properties = args.properties;
      } else if (action === 'save_scene') {
        params.scene_path = normalizeUserProjectPath(args.scene_path as string);
        if (args.new_path) { try { const np = normalizeUserProjectPath(String(args.new_path)); resolveWithinRoot(p, np); params.new_path = np; } catch { releaseShortRunningSlot(); return opsErrorResult('INVALID_PATH', 'new_path contains path traversal'); } }
      } else if (action === 'load_sprite') {
        params.scene_path = normalizeUserProjectPath(args.scene_path as string);
        const tp = String(args.texture_path);
        try { sanitizeResPath(tp, 'texture_path'); } catch { releaseShortRunningSlot(); return opsErrorResult('INVALID_PATH', 'texture_path contains path traversal'); }
        params.texture_path = tp; params.node_path = args.node_path || 'root';
      }

      const result = await spawnGodot(godot, ['--headless', '--path', p, '--script', ctx.opsScript, action, JSON.stringify(params)]);
      releaseShortRunningSlot();
      if (result.timedOut) return { content: [{ type: 'text', text: `${action} timed out.` }] };
      if (result.exitCode === -1 && result.stdout.startsWith('SPAWN_FAILED:')) return opsErrorResult('SPAWN_FAILED', `Failed to spawn Godot: ${result.stdout.replace('SPAWN_FAILED: ', '')}`);
      if (result.exitCode !== 0) return { content: [{ type: 'text', text: `${action} failed (exit code ${result.exitCode}):\n${result.stdout}${result.stderr ? '\n' + result.stderr : ''}` }] };
      return { content: [{ type: 'text', text: result.stdout.trim() || `${action} completed successfully.` }] };
    }

    case 'quick_scene': {
      const p = requireProjectPath(args);
      const sceneRelPath = normalizeUserProjectPath(args.scene_path as string);
      const scriptRelPath = args.script_path ? normalizeUserProjectPath(args.script_path as string) : undefined;
      const rootNodeType = (args.root_node_type as string) || 'Node2D';
      const scriptContent = args.script_content as string | undefined;
      if (!/^[A-Za-z0-9_]+$/.test(rootNodeType)) return textResult(`Error: root_node_type contains invalid characters: "${rootNodeType}"`);
      let rootNodeName = args.root_node_name as string;
      if (!rootNodeName) { const baseName = sceneRelPath.split('/').pop()!.replace(/\.tscn$/i, ''); rootNodeName = baseName ? baseName.split('_').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('') : 'Root'; }
      if (!rootNodeName || !/^[A-Za-z0-9_]+$/.test(rootNodeName)) return textResult(`Error: root_node_name must match /^[A-Za-z0-9_]+$/, got: "${rootNodeName}"`);
      const sceneAbsPath = resolveWithinRoot(p, sceneRelPath);
      if (existsSync(sceneAbsPath)) return textResult(`Error: Scene already exists: ${sceneRelPath}. Remove it first or use a different path.`);
      let tscnContent: string;
      if (scriptRelPath) { tscnContent = ['[gd_scene load_steps=2 format=3]', '', `[ext_resource type="Script" path="res://${scriptRelPath.replace(/\\/g, '/')}" id="1"]`, '', `[node name="${rootNodeName}" type="${rootNodeType}"]`, 'script = ExtResource("1")', ''].join('\n'); }
      else { tscnContent = ['[gd_scene format=3]', '', `[node name="${rootNodeName}" type="${rootNodeType}"]`, ''].join('\n'); }
      try { ensureDir(sceneAbsPath); writeFileSync(sceneAbsPath, tscnContent, 'utf-8'); } catch (e: unknown) { return textResult(`Error writing scene: ${(e as Error).message}`); }
      if (scriptRelPath && scriptContent) { const scriptAbsPath = resolveWithinRoot(p, scriptRelPath); if (!existsSync(scriptAbsPath)) { try { ensureDir(scriptAbsPath); writeFileSync(scriptAbsPath, scriptContent, 'utf-8'); } catch (e: unknown) { return textResult(`Scene created but script write failed: ${(e as Error).message}`); } } }
      const parts = [`Created scene: ${sceneRelPath}`, `Root: ${rootNodeName} [${rootNodeType}]`];
      if (scriptRelPath) parts.push(`Script: res://${scriptRelPath.replace(/\\/g, '/')}`);
      if (scriptRelPath && scriptContent) parts.push(`Script file created`);
      return textResult(parts.join('\n'));
    }

    case 'query_scene_tree': {
      if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
      const p = requireProjectPath(args);
      let godot: string; try { godot = await ctx.findGodot(); } catch (e) { releaseShortRunningSlot(); throw e; }
      const scriptsDir = dirname(ctx.opsScript); const treeScript = join(scriptsDir, 'query_scene_tree.gd');
      if (!existsSync(treeScript)) { releaseShortRunningSlot(); return textResult(`Error: query_scene_tree.gd not found at ${treeScript}`); }
      const params = { scene_path: normalizeUserProjectPath(args.scene_path as string), max_depth: (args.max_depth as number) || 5 };
      const result = await spawnGodot(godot, ['--headless', '--path', p, '--script', treeScript, JSON.stringify(params)]);
      releaseShortRunningSlot();
      if (result.timedOut) return textResult('query_scene_tree timed out after 60s');
      if (result.exitCode === -1 && result.stdout.startsWith('SPAWN_FAILED:')) return textResult(result.stdout);
      return textResult(JSON.stringify(parseMcpScriptOutput(result.stdout, result.exitCode ?? 0), null, 2));
    }

    case 'inspect_node': {
      if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
      const p = requireProjectPath(args);
      let godot: string; try { godot = await ctx.findGodot(); } catch (e) { releaseShortRunningSlot(); throw e; }
      const scriptsDir = dirname(ctx.opsScript); const inspectScript = join(scriptsDir, 'inspect_node.gd');
      if (!existsSync(inspectScript)) { releaseShortRunningSlot(); return textResult(`Error: inspect_node.gd not found at ${inspectScript}`); }
      const params = { scene_path: normalizeUserProjectPath(args.scene_path as string), node_path: args.node_path || 'root', max_depth: (args.max_depth as number) || 3, include_signals: args.include_signals !== false, include_properties: args.include_properties !== false };
      const result = await spawnGodot(godot, ['--headless', '--path', p, '--script', inspectScript, JSON.stringify(params)]);
      releaseShortRunningSlot();
      if (result.timedOut) return textResult('inspect_node timed out after 60s');
      if (result.exitCode === -1 && result.stdout.startsWith('SPAWN_FAILED:')) return textResult(result.stdout);
      return textResult(JSON.stringify(parseMcpScriptOutput(result.stdout, result.exitCode ?? 0), null, 2));
    }

    case 'batch_add_nodes': {
      if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
      const p = requireProjectPath(args);
      const scenePath = normalizeUserProjectPath(args.scene_path as string);
      const nodes = args.nodes as Array<{ node_type: string; node_name: string; parent_node_path?: string; properties?: Record<string, unknown> }>;
      if (!nodes || !Array.isArray(nodes) || nodes.length === 0) { releaseShortRunningSlot(); return opsErrorResult('INVALID_PARAMS', '"nodes" must be a non-empty array of node definitions.'); }
      if (nodes.length > 100) { releaseShortRunningSlot(); return textResult(`Error: Too many nodes (${nodes.length}). Maximum: 100`); }
      for (let i = 0; i < nodes.length; i++) { const n = nodes[i]!; if (!n.node_type || !/^[A-Za-z0-9_]+$/.test(String(n.node_type))) { releaseShortRunningSlot(); return textResult(`Error: nodes[${i}].node_type contains invalid characters: "${n.node_type}"`); } if (!n.node_name || /[\]["/:\\]/.test(String(n.node_name))) { releaseShortRunningSlot(); return textResult(`Error: nodes[${i}].node_name contains invalid characters: "${n.node_name}"`); } }
      let godot: string; try { godot = await ctx.findGodot(); } catch (e) { releaseShortRunningSlot(); throw e; }
      const result = await spawnGodot(godot, ['--headless', '--path', p, '--script', ctx.opsScript, 'batch_add_nodes', JSON.stringify({ scene_path: scenePath, nodes })]);
      releaseShortRunningSlot();
      if (result.timedOut) return errorResult('batch_add_nodes timed out after 60s.');
      if (result.exitCode === -1 && result.stdout.startsWith('SPAWN_FAILED:')) return errorResult(result.stdout);
      if (result.exitCode !== 0) return errorResult(`batch_add_nodes failed (exit code ${result.exitCode}):\n${result.stdout}`);
      return { content: [{ type: 'text', text: result.stdout.trim() || `batch_add_nodes completed: ${nodes.length} nodes added.` }] };
    }

    case 'edit_node': {
      const spErr = requireScenePath(args.scene_path); if (spErr) return spErr;
      if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
      try {
        const p = requireProjectPath(args); const scenePath = resolveWithinRoot(p, normalizeUserProjectPath(args.scene_path as string)); const nodePath = normalizeNodePath(args.node_path as string);
        const properties = args.properties as Record<string, unknown>;
        if (!properties || typeof properties !== 'object' || Object.keys(properties).length === 0) return opsErrorResult('INVALID_PARAMS', '"properties" must be a non-empty object.');
        let propLines = '';
        for (const [key, value] of Object.entries(properties)) {
          if (BLOCKED_PROPS.has(key)) continue; // C-SEC-06: block dangerous props (script, owner, name, etc.)
          const gdKey = toSnakeCase(key); if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(gdKey)) return textResult(`Error: Invalid property name: "${key}"`); propLines += `\n\t${gdScriptSetLine(gdKey, value)}`; }
        const script = `${SCENE_TREE_HEADER}\n${TRY_SET_HELPER}\nfunc _initialize():\n\tif not _mcp_load_scene("${gdEscape(scenePath)}"):\n\t\t_mcp_done()\n\t\treturn\n\tvar node = _mcp_get_scene_node("${gdEscape(nodePath)}")\n\tif node == null:\n\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")\n\t\t_mcp_done()\n\t\treturn${propLines}\n\t_mcp_output("edited", {"node": "${gdEscape(nodePath)}"})\n\t_mcp_done()\n`;
        const godot = await ctx.findGodot(); const loadAutoloads = args.load_autoloads !== false;
        return parseGdscriptResult(await executeGdscript({ godotPath: godot, projectPath: p, code: script, timeout: 30, loadAutoloads }), [], (msg) => msg.includes('not found') ? 'NODE_NOT_FOUND' : 'SCRIPT_EXEC_FAILED', { suggestion: 'Use query_scene_tree to list available nodes, or inspect_node to check a specific path.' });
      } finally { releaseShortRunningSlot(); }
    }

    case 'remove_node': {
      const spErr = requireScenePath(args.scene_path); if (spErr) return spErr;
      if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
      try {
        const p = requireProjectPath(args); const scenePath = resolveWithinRoot(p, normalizeUserProjectPath(args.scene_path as string)); const nodePath = normalizeNodePath(args.node_path as string);
        const script = `${SCENE_TREE_HEADER}\nfunc _initialize():\n\tif not _mcp_load_scene("${gdEscape(scenePath)}"):\n\t\t_mcp_done()\n\t\treturn\n\tvar node = _mcp_get_scene_node("${gdEscape(nodePath)}")\n\tif node == null:\n\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")\n\t\t_mcp_done()\n\t\treturn\n\tvar parent = node.get_parent()\n\tvar node_name = node.name\n\tif parent:\n\t\tvar child_owner = node.owner\n\t\tparent.remove_child(node)\n\t\tnode.queue_free()\n\t\t_mcp_output("removed", {"node": "${gdEscape(nodePath)}", "name": str(node_name)})\n\telse:\n\t\t_mcp_output("error", "Cannot remove root node")\n\t_mcp_done()\n`;
        const godot = await ctx.findGodot(); const loadAutoloads = args.load_autoloads !== false;
        return parseGdscriptResult(await executeGdscript({ godotPath: godot, projectPath: p, code: script, timeout: 30, loadAutoloads }), [], (msg) => msg.includes('not found') ? 'NODE_NOT_FOUND' : 'SCRIPT_EXEC_FAILED', { suggestion: 'Use query_scene_tree to list available nodes, or inspect_node to check a specific path.' });
      } finally { releaseShortRunningSlot(); }
    }

    case 'instance_scene': return handleInstanceScene(args, ctx);
    case 'set_instance_property': return handleSetInstanceProperty(args, ctx);
    case 'detach_instance': return handleDetachInstance(args);

    case 'health_check': {
      const p = requireProjectPath(args); const scenePath = args.scene_path as string;
      if (!scenePath || typeof scenePath !== 'string') return opsErrorResult('INVALID_PARAMS', 'scene_path is required for health_check', { suggestion: 'Provide the scene file path relative to project, e.g. "scenes/main.tscn"' });
      const fullPath = resolveWithinRoot(p, scenePath); if (!existsSync(fullPath)) return opsErrorResult('FILE_NOT_FOUND', `Scene not found: ${scenePath}`);
      const result = checkSceneHealth(readFileSync(fullPath, 'utf-8'), scenePath);
      return textResult(JSON.stringify({ scene: scenePath, healthy: result.issues.length === 0, issue_count: result.issues.length, issues: result.issues, nodes_checked: result.nodesChecked }, null, 2));
    }

    case 'merge_scene': {
      const p = requireProjectPath(args); const sceneA = args.scene_path as string; const sceneB = args.new_path as string;
      if (!sceneA || !sceneB) return opsErrorResult('INVALID_PARAMS', 'Both scene_path (ours) and new_path (theirs) are required', { suggestion: 'Provide two scene file paths: scene_path=ours.tscn new_path=theirs.tscn' });
      const fullPathA = resolveWithinRoot(p, sceneA); const fullPathB = resolveWithinRoot(p, sceneB);
      if (!existsSync(fullPathA)) return opsErrorResult('FILE_NOT_FOUND', `Scene A not found: ${sceneA}`);
      if (!existsSync(fullPathB)) return opsErrorResult('FILE_NOT_FOUND', `Scene B not found: ${sceneB}`);
      const MAX = 10 * 1024 * 1024; const statA = statSync(fullPathA); const statB = statSync(fullPathB);
      if (statA.size > MAX || statB.size > MAX) return opsErrorResult('FILE_TOO_LARGE', `Scene file exceeds 10MB merge limit (A: ${statA.size}B, B: ${statB.size}B)`);
      const ours = readFileSync(fullPathA, 'utf-8'); const theirs = readFileSync(fullPathB, 'utf-8');
      writeAtomic(fullPathA, mergeTscn(ours, theirs));
      return textResult(JSON.stringify({ merged_into: sceneA, source: sceneB, status: 'ok' }, null, 2));
    }

    default: return null;
  }
}


export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  scene: { readonly: false, long_running: true },
};
