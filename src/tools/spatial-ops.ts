import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { requireProjectPath } from '../helpers.js';
import { executeGdscript } from '../gdscript-executor.js';
import { normalizeNodePath, gdEscape, validatePositiveInt, SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, parseGdscriptResult } from './shared.js';

const TOOL_NAMES = ['spatial_info'] as const;

function validateVector3(v: { x: number; y: number; z: number }, name: string): void {
  if (typeof v.x !== 'number' || typeof v.y !== 'number' || typeof v.z !== 'number'
    || !Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) {
    throw new Error(`${name} must have finite x, y, z number values`);
  }
}

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'spatial_info',
      description:
        '获取 Node3D 空间信息：get_node_info（transform/AABB/visible）、get_bounds（子树合并 AABB）、find_in_aabb（AABB 范围内查找节点）。' +
        NON_PERSIST,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          action: {
            type: 'string',
            enum: ['get_node_info', 'get_bounds', 'find_in_aabb'],
            description: '操作类型',
          },
          node_path: { type: 'string', description: 'Node3D 节点路径（get_node_info 必填）' },
          root_path: { type: 'string', description: '搜索根节点路径（get_bounds，默认场景根）' },
          include_children: { type: 'boolean', description: '包含子节点（get_node_info，默认 false）' },
          type_filter: { type: 'string', description: '按节点类型过滤，如 MeshInstance3D' },
          max_results: { type: 'number', description: '结果数量限制（默认 50）' },
          aabb_min: {
            type: 'object',
            description: 'AABB 最小角 {x,y,z}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
          },
          aabb_size: {
            type: 'object',
            description: 'AABB 尺寸 {x,y,z}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
          },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'action'],
      },
    },
  ];
}

function genGetNodeInfo(nodePath: string, includeChildren: boolean, typeFilter: string, maxResults: number): string {
  const filterCheck = typeFilter
    ? `if "${gdEscape(typeFilter)}" != "" and not _c.is_class("${gdEscape(typeFilter)}"):
\t\t\t\tcontinue`
    : '';
  return `${SCENE_TREE_HEADER}
func _get_info(n: Node3D) -> Dictionary:
\tvar d: Dictionary = {}
\td["path"] = str(n.get_path()).trim_prefix("/root/")
\td["type"] = n.get_class()
\td["global_position"] = [n.global_position.x, n.global_position.y, n.global_position.z]
\td["global_rotation"] = [n.global_rotation.x, n.global_rotation.y, n.global_rotation.z]
\tvar _gs: Vector3 = n.global_transform.basis.get_scale()
\td["global_scale"] = [_gs.x, _gs.y, _gs.z]
\td["visible"] = n.visible
\tif n is VisualInstance3D:
\t\tvar a: AABB = n.get_aabb()
\t\td["local_aabb"] = {"position": [a.position.x, a.position.y, a.position.z], "size": [a.size.x, a.size.y, a.size.z]}
\t\tvar ga: AABB = n.get_global_aabb()
\t\td["global_aabb"] = {"position": [ga.position.x, ga.position.y, ga.position.z], "size": [ga.size.x, ga.size.y, ga.size.z]}
\treturn d

func _initialize():
\t_mcp_load_main_scene()
\tvar _node: Node3D = _mcp_get_node("${gdEscape(nodePath)}")
\tif _node == null or not (_node is Node3D):
\t\t_mcp_output("error", "Node3D not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar _results: Array = []
\tif "${gdEscape(typeFilter)}" == "" or _node.is_class("${gdEscape(typeFilter)}"):
\t\t_results.append(_get_info(_node))
\tif ${includeChildren ? 'true' : 'false'}:
\t\tvar _stack: Array = []
\t\tfor _c in _node.get_children():
\t\t\tif _c is Node3D:
\t\t\t\t_stack.append(_c)
\t\twhile _stack.size() > 0 and _results.size() < ${maxResults}:
\t\t\tvar _c: Node3D = _stack.pop_back()
${filterCheck}
\t\t\t_results.append(_get_info(_c))
\t\t\tfor _gc in _c.get_children():
\t\t\t\tif _gc is Node3D:
\t\t\t\t\t_stack.append(_gc)
\t_mcp_output("nodes", _results)
\t_mcp_output("count", _results.size())
\t_mcp_done()
`;
}

function genGetBounds(rootPath: string): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _root: Node3D = null
\tif "${gdEscape(rootPath)}" != "":
\t\tvar _n: Node = _mcp_get_node("${gdEscape(rootPath)}")
\t\tif _n == null or not (_n is Node3D):
\t\t\t_mcp_output("error", "Node3D not found")
\t\t\t_mcp_done()
\t\t\treturn
\t\t_root = _n as Node3D
\telse:
\t\tvar _r: Node = _mcp_get_root()
\t\tif _r != null:
\t\t\tfor _c in _r.get_children():
\t\t\t\tif _c is Node3D:
\t\t\t\t\t_root = _c as Node3D
\t\t\t\t\tbreak
\tif _root == null:
\t\t_mcp_output("error", "No Node3D found")
\t\t_mcp_done()
\t\treturn
\tvar _combined: AABB = AABB()
\tvar _count: int = 0
\tvar _first: bool = true
\tvar _stack: Array = [_root]
\twhile _stack.size() > 0:
\t\tvar _n: Node3D = _stack.pop_back()
\t\tif _n is VisualInstance3D:
\t\t\tvar _aabb: AABB = _n.get_global_aabb()
\t\t\tif _first:
\t\t\t\t_combined = _aabb
\t\t\t\t_first = false
\t\t\telse:
\t\t\t\t_combined = _combined.merge(_aabb)
\t\t\t_count += 1
\t\tfor _c in _n.get_children():
\t\t\tif _c is Node3D:
\t\t\t\t_stack.append(_c)
\tvar _result: Dictionary = {}
\t_result["root_path"] = str(_root.get_path()).trim_prefix("/root/")
\t_result["visual_node_count"] = _count
\tif _count > 0:
\t\t_result["combined_aabb"] = {
\t\t\t"position": [_combined.position.x, _combined.position.y, _combined.position.z],
\t\t\t"size": [_combined.size.x, _combined.size.y, _combined.size.z],
\t\t\t"end": [_combined.end.x, _combined.end.y, _combined.end.z]
\t\t}
\t_mcp_output("bounds", _result)
\t_mcp_done()
`;
}

function genFindInAabb(
  aabbMin: { x: number; y: number; z: number },
  aabbSize: { x: number; y: number; z: number },
  maxResults: number,
): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _aabb: AABB = AABB(Vector3(${aabbMin.x}, ${aabbMin.y}, ${aabbMin.z}), Vector3(${aabbSize.x}, ${aabbSize.y}, ${aabbSize.z}))
\tvar _root: Node = _mcp_get_root()
\tif _root == null:
\t\t_mcp_output("error", "Scene root not found")
\t\t_mcp_done()
\t\treturn
\tvar _results: Array = []
\tvar _stack: Array = [_root]
\twhile _stack.size() > 0 and _results.size() < ${maxResults}:
\t\tvar _n: Node = _stack.pop_back()
\t\tif _n is Node3D:
\t\t\tvar _n3d: Node3D = _n as Node3D
\t\t\tif _aabb.has_point(_n3d.global_position):
\t\t\t\t_results.append({
\t\t\t\t\t"path": str(_n3d.get_path()).trim_prefix("/root/"),
\t\t\t\t\t"type": _n3d.get_class(),
\t\t\t\t\t"position": [_n3d.global_position.x, _n3d.global_position.y, _n3d.global_position.z]
\t\t\t\t})
\t\tfor _c in _n.get_children():
\t\t\t_stack.append(_c)
\t_mcp_output("nodes", _results)
\t_mcp_output("count", _results.size())
\t_mcp_done()
`;
}

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  try {
    const projectPath = requireProjectPath(args);
    const action = args.action as string;
    const loadAutoloads = (args.load_autoloads as boolean) ?? true;
    const godotPath = await ctx.findGodot();
    let code: string;

    switch (action) {
      case 'get_node_info': {
        if (!args.node_path) return opsErrorResult('INVALID_PARAMS', 'node_path required for get_node_info');
        const nodePath = normalizeNodePath(args.node_path as string);
        const maxResults = args.max_results !== undefined
          ? validatePositiveInt(args.max_results, 'max_results', 1, 1000)
          : 50;
        code = genGetNodeInfo(
          nodePath,
          (args.include_children as boolean) ?? false,
          (args.type_filter as string) ?? '',
          maxResults,
        );
        break;
      }
      case 'get_bounds': {
        const rootPath = args.root_path ? normalizeNodePath(args.root_path as string) : '';
        code = genGetBounds(rootPath);
        break;
      }
      case 'find_in_aabb': {
        const aabbMin = args.aabb_min as { x: number; y: number; z: number } | undefined;
        const aabbSize = args.aabb_size as { x: number; y: number; z: number } | undefined;
        if (!aabbMin || !aabbSize) return opsErrorResult('INVALID_PARAMS', 'aabb_min and aabb_size required for find_in_aabb');
        validateVector3(aabbMin, 'aabb_min');
        validateVector3(aabbSize, 'aabb_size');
        const maxResults = args.max_results !== undefined
          ? validatePositiveInt(args.max_results, 'max_results', 1, 1000)
          : 100;
        code = genFindInAabb(aabbMin, aabbSize, maxResults);
        break;
      }
      default:
        return opsErrorResult('INVALID_ACTION', `Unknown action: ${action}`);
    }

    const result = await executeGdscript({
      godotPath,
      projectPath,
      code,
      timeout: 30,
      loadAutoloads,
    });

    return parseGdscriptResult(result);
  } catch (err) {
    return opsErrorResult('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  spatial_info: { readonly: true, long_running: false },
};
