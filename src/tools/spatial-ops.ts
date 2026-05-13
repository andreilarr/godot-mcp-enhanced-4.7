import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { validatePath } from '../helpers.js';
import { executeGdscript } from '../gdscript-executor.js';
import { normalizeNodePath, gdEscape } from './godot-ops.js';
import { SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, parseGdscriptResult } from './shared.js';

const TOOL_NAMES = ['spatial_info'] as const;

function validateVector3(v: { x: number; y: number; z: number }, name: string): void {
  if (typeof v.x !== 'number' || typeof v.y !== 'number' || typeof v.z !== 'number'
    || !Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) {
    throw new Error(`${name} must have finite x, y, z number values`);
  }
}

function validatePositiveInt(v: unknown, name: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}, got: ${JSON.stringify(v)}`);
  }
  return Math.round(n);
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
var _mcp_outputs: Array = []

func _get_info(n: Node3D) -> Dictionary:
	var d: Dictionary = {}
	d["path"] = str(n.get_path()).trim_prefix("/root/")
	d["type"] = n.get_class()
	d["global_position"] = [n.global_position.x, n.global_position.y, n.global_position.z]
	d["global_rotation"] = [n.global_rotation.x, n.global_rotation.y, n.global_rotation.z]
	d["global_scale"] = [n.global_scale.x, n.global_scale.y, n.global_scale.z]
	d["visible"] = n.visible
	if n is VisualInstance3D:
		var a: AABB = n.get_aabb()
		d["local_aabb"] = {"position": [a.position.x, a.position.y, a.position.z], "size": [a.size.x, a.size.y, a.size.z]}
		var ga: AABB = n.get_global_aabb()
		d["global_aabb"] = {"position": [ga.position.x, ga.position.y, ga.position.z], "size": [ga.size.x, ga.size.y, ga.size.z]}
	return d

func _initialize():
	_mcp_load_main_scene()
	var _node: Node3D = _mcp_get_node("${gdEscape(nodePath)}")
	if _node == null or not (_node is Node3D):
		_mcp_output("error", "Node3D not found: ${gdEscape(nodePath)}")
		_mcp_done()
		return
	var _results: Array = []
	if "${gdEscape(typeFilter)}" == "" or _node.is_class("${gdEscape(typeFilter)}"):
		_results.append(_get_info(_node))
	if ${includeChildren ? 'true' : 'false'}:
		var _stack: Array = []
		for _c in _node.get_children():
			if _c is Node3D:
				_stack.append(_c)
		while _stack.size() > 0 and _results.size() < ${maxResults}:
			var _c: Node3D = _stack.pop_back()
${filterCheck}
			_results.append(_get_info(_c))
			for _gc in _c.get_children():
				if _gc is Node3D:
					_stack.append(_gc)
	_mcp_output("nodes", _results)
	_mcp_output("count", _results.size())
	_mcp_done()
`;
}

function genGetBounds(rootPath: string): string {
  return `${SCENE_TREE_HEADER}
var _mcp_outputs: Array = []

func _initialize():
	_mcp_load_main_scene()
	var _root: Node3D = null
	if "${gdEscape(rootPath)}" != "":
		var _n: Node = _mcp_get_node("${gdEscape(rootPath)}")
		if _n == null or not (_n is Node3D):
			_mcp_output("error", "Node3D not found")
			_mcp_done()
			return
		_root = _n as Node3D
	else:
		var _r: Node = _mcp_get_root()
		if _r != null:
			for _c in _r.get_children():
				if _c is Node3D:
					_root = _c as Node3D
					break
	if _root == null:
		_mcp_output("error", "No Node3D found")
		_mcp_done()
		return
	var _combined: AABB = AABB()
	var _count: int = 0
	var _first: bool = true
	var _stack: Array = [_root]
	while _stack.size() > 0:
		var _n: Node3D = _stack.pop_back()
		if _n is VisualInstance3D:
			var _aabb: AABB = _n.get_global_aabb()
			if _first:
				_combined = _aabb
				_first = false
			else:
				_combined = _combined.merge(_aabb)
			_count += 1
		for _c in _n.get_children():
			if _c is Node3D:
				_stack.append(_c)
	var _result: Dictionary = {}
	_result["root_path"] = str(_root.get_path()).trim_prefix("/root/")
	_result["visual_node_count"] = _count
	if _count > 0:
		_result["combined_aabb"] = {
			"position": [_combined.position.x, _combined.position.y, _combined.position.z],
			"size": [_combined.size.x, _combined.size.y, _combined.size.z],
			"end": [_combined.end.x, _combined.end.y, _combined.end.z]
		}
	_mcp_output("bounds", _result)
	_mcp_done()
`;
}

function genFindInAabb(
  aabbMin: { x: number; y: number; z: number },
  aabbSize: { x: number; y: number; z: number },
  maxResults: number,
): string {
  return `${SCENE_TREE_HEADER}
var _mcp_outputs: Array = []

func _initialize():
	_mcp_load_main_scene()
	var _aabb: AABB = AABB(Vector3(${aabbMin.x}, ${aabbMin.y}, ${aabbMin.z}), Vector3(${aabbSize.x}, ${aabbSize.y}, ${aabbSize.z}))
	var _root: Node = _mcp_get_root()
	if _root == null:
		_mcp_output("error", "Scene root not found")
		_mcp_done()
		return
	var _results: Array = []
	var _stack: Array = [_root]
	while _stack.size() > 0 and _results.size() < ${maxResults}:
		var _n: Node = _stack.pop_back()
		if _n is Node3D:
			var _n3d: Node3D = _n as Node3D
			if _aabb.has_point(_n3d.global_position):
				_results.append({
					"path": str(_n3d.get_path()).trim_prefix("/root/"),
					"type": _n3d.get_class(),
					"position": [_n3d.global_position.x, _n3d.global_position.y, _n3d.global_position.z]
				})
		for _c in _n.get_children():
			_stack.append(_c)
	_mcp_output("nodes", _results)
	_mcp_output("count", _results.size())
	_mcp_done()
`;
}

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  try {
    const projectPath = validatePath(args.project_path as string);
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
