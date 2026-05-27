import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { requireProjectPath } from '../helpers.js';
import { executeGdscript } from '../gdscript-executor.js';
import { normalizeNodePath, gdEscape, ensureNumber, SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, parseGdscriptResult } from './shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const TOOL_NAMES = [
  'animtree_create',
  'animtree_add_state',
  'animtree_add_transition',
  'animtree_set_blend',
  'animtree_play',
  'animtree_state_edit',
] as const;

export { TOOL_NAMES };

const TREE_ROOT_TYPES = [
  'AnimationNodeStateMachine',
  'AnimationNodeBlendTree',
  'AnimationNodeBlendSpace2D',
] as const;

const ERROR_CODES = {
  INVALID_PARAMS: 'INVALID_PARAMS',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
} as const;

// ─── Tool Definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'animtree_create',
      description:
        '创建 AnimationTree 节点并绑定 AnimationPlayer。支持选择根节点类型（状态机/混合树/混合空间）。' +
        NON_PERSIST,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          name: { type: 'string', description: 'AnimationTree 节点名称' },
          parent: { type: 'string', description: '父节点路径（默认 root）' },
          animation_player_path: { type: 'string', description: '场景中已有的 AnimationPlayer 的 NodePath' },
          tree_root_type: {
            type: 'string',
            enum: [...TREE_ROOT_TYPES],
            description: '根节点类型（默认 AnimationNodeStateMachine）',
          },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'name', 'animation_player_path'],
      },
    },
    {
      name: 'animtree_add_state',
      description:
        '向 AnimationTree 的状态机根节点添加一个状态（AnimationNodeAnimation）。' +
        NON_PERSIST,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: 'AnimationTree 节点路径' },
          state_name: { type: 'string', description: '状态名称' },
          animation: { type: 'string', description: '关联的 Animation 名称' },
          position: {
            type: 'object',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
            },
            description: '在状态机编辑器中的位置（可选）',
          },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path', 'state_name', 'animation'],
      },
    },
    {
      name: 'animtree_add_transition',
      description:
        '在状态机的两个状态之间添加转换（含条件）。' +
        NON_PERSIST,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: 'AnimationTree 节点路径' },
          from_state: { type: 'string', description: '源状态名称' },
          to_state: { type: 'string', description: '目标状态名称' },
          xfade_time: { type: 'number', description: '交叉淡入淡出时间（秒，默认 0.0）' },
          conditions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                value: { description: '条件值（number 或 boolean）' },
              },
              required: ['name', 'value'],
            },
            description: '转换条件列表',
          },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path', 'from_state', 'to_state'],
      },
    },
    {
      name: 'animtree_set_blend',
      description:
        '设置 AnimationTree 的混合参数（用于 BlendTree 或 BlendSpace）。' +
        NON_PERSIST,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: 'AnimationTree 节点路径' },
          parameter_name: { type: 'string', description: '参数名称' },
          value: { description: '参数值（float 用于 blends，{x,y} 用于 blend spaces）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path', 'parameter_name', 'value'],
      },
    },
    {
      name: 'animtree_play',
      description:
        '切换 AnimationTree 到指定状态（通过状态机 playback.travel）。' +
        NON_PERSIST,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: 'AnimationTree 节点路径' },
          state_name: { type: 'string', description: '目标状态名称' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path', 'state_name'],
      },
    },
    {
      name: 'animtree_state_edit',
      description:
        '编辑 AnimationTree 状态机中的状态属性：设置状态在编辑器中的位置，或设置混合参数。' +
        NON_PERSIST,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: 'AnimationTree 节点路径' },
          action: {
            type: 'string',
            enum: ['set_position', 'set_blend'],
            description: '操作类型：set_position 设置状态位置，set_blend 设置混合参数',
          },
          state_name: { type: 'string', description: '状态名称（set_position 时必填）' },
          position: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            description: '状态在编辑器中的位置（set_position 时必填）',
          },
          parameter_name: { type: 'string', description: '参数名称（set_blend 时必填）' },
          value: { description: '参数值（set_blend 时必填，number 或 {x,y}）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path', 'action'],
      },
    },
  ];
}

// ─── GDScript Generators ───────────────────────────────────────────────────

function genCreate(
  nodeName: string,
  parentPath: string,
  animPlayerPath: string,
  treeRootType: string,
): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _parent: Node = _mcp_get_node("${gdEscape(parentPath)}")
\tif _parent == null:
\t\t_mcp_output("error", "Parent node not found: ${gdEscape(parentPath)}")
\t\t_mcp_done()
\t\treturn
\tvar _tree = AnimationTree.new()
\t_tree.name = "${gdEscape(nodeName)}"
\t_tree.anim_player = NodePath("${gdEscape(animPlayerPath)}")
\tvar _root_node
\tmatch "${gdEscape(treeRootType)}":
\t\t"AnimationNodeStateMachine":
\t\t\t_root_node = AnimationNodeStateMachine.new()
\t\t"AnimationNodeBlendTree":
\t\t\t_root_node = AnimationNodeBlendTree.new()
\t\t"AnimationNodeBlendSpace2D":
\t\t\t_root_node = AnimationNodeBlendSpace2D.new()
\t\t_:
\t\t\t_root_node = AnimationNodeStateMachine.new()
\t_tree.tree_root = _root_node
\t_tree.active = true
\t_parent.add_child(_tree)
\t_mcp_output("created", {"name": "${gdEscape(nodeName)}", "parent": "${gdEscape(parentPath)}", "root_type": "${gdEscape(treeRootType)}"})
\t_mcp_done()
`;
}

function genAddState(
  nodePath: string,
  stateName: string,
  animation: string,
  posX?: number,
  posY?: number,
): string {
  const posLine = (posX !== undefined && posY !== undefined)
    ? `\n\t_sm.set_node_position("${gdEscape(stateName)}", Vector2(${posX}, ${posY}))`
    : '';
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _tree: AnimationTree = _mcp_get_node("${gdEscape(nodePath)}")
\tif _tree == null or not (_tree is AnimationTree):
\t\t_mcp_output("error", "AnimationTree not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar _sm: AnimationNodeStateMachine = _tree.tree_root
\tif _sm == null or not (_sm is AnimationNodeStateMachine):
\t\t_mcp_output("error", "Tree root is not a AnimationNodeStateMachine")
\t\t_mcp_done()
\t\treturn
\tvar _anim_node = AnimationNodeAnimation.new()
\t_anim_node.animation = "${gdEscape(animation)}"
\t_sm.add_node("${gdEscape(stateName)}", _anim_node)${posLine}
\t_mcp_output("added_state", {"state": "${gdEscape(stateName)}", "animation": "${gdEscape(animation)}"})
\t_mcp_done()
`;
}

function genAddTransition(
  nodePath: string,
  fromState: string,
  toState: string,
  xfadeTime: number,
  conditions: Array<{ name: string; value: number | boolean }>,
): string {
  const condLines = conditions.map(c => {
    const valStr = typeof c.value === 'boolean' ? (c.value ? 'true' : 'false') : String(c.value);
    return `\t_transition.add_condition("${gdEscape(c.name)}", ${valStr})`;
  }).join('\n');

  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _tree: AnimationTree = _mcp_get_node("${gdEscape(nodePath)}")
\tif _tree == null or not (_tree is AnimationTree):
\t\t_mcp_output("error", "AnimationTree not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar _sm: AnimationNodeStateMachine = _tree.tree_root
\tif _sm == null or not (_sm is AnimationNodeStateMachine):
\t\t_mcp_output("error", "Tree root is not a AnimationNodeStateMachine")
\t\t_mcp_done()
\t\treturn
\tvar _transition = AnimationNodeStateMachineTransition.new()
\t_transition.xfade_time = ${xfadeTime}
${condLines}
\t_sm.add_transition("${gdEscape(fromState)}", "${gdEscape(toState)}", _transition)
\t_mcp_output("added_transition", {"from": "${gdEscape(fromState)}", "to": "${gdEscape(toState)}", "xfade": ${xfadeTime}, "conditions": ${conditions.length}})
\t_mcp_done()
`;
}

function genSetBlend(
  nodePath: string,
  paramName: string,
  valueSrc: string,
): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _tree: AnimationTree = _mcp_get_node("${gdEscape(nodePath)}")
\tif _tree == null or not (_tree is AnimationTree):
\t\t_mcp_output("error", "AnimationTree not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\t_tree.set("${gdEscape(paramName)}", ${valueSrc})
\t_mcp_output("set_blend", {"parameter": "${gdEscape(paramName)}", "value": ${valueSrc}})
\t_mcp_done()
`;
}

function genPlay(
  nodePath: string,
  stateName: string,
): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _tree: AnimationTree = _mcp_get_node("${gdEscape(nodePath)}")
\tif _tree == null or not (_tree is AnimationTree):
\t\t_mcp_output("error", "AnimationTree not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar _playback = _tree["parameters/playback"]
\tif _playback == null:
\t\t_mcp_output("error", "Playback not available. Ensure tree_root is AnimationNodeStateMachine.")
\t\t_mcp_done()
\t\treturn
\t_playback.travel("${gdEscape(stateName)}")
\t_mcp_output("playing", {"state": "${gdEscape(stateName)}"})
\t_mcp_done()
`;
}

function genStateSetPosition(
  nodePath: string,
  stateName: string,
  posX: number,
  posY: number,
): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _tree: AnimationTree = _mcp_get_node("${gdEscape(nodePath)}")
\tif _tree == null or not (_tree is AnimationTree):
\t\t_mcp_output("error", "AnimationTree not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar _sm: AnimationNodeStateMachine = _tree.tree_root
\tif _sm == null or not (_sm is AnimationNodeStateMachine):
\t\t_mcp_output("error", "Tree root is not a AnimationNodeStateMachine")
\t\t_mcp_done()
\t\treturn
\tif not _sm.has_node("${gdEscape(stateName)}"):
\t\t_mcp_output("error", "State not found: ${gdEscape(stateName)}")
\t\t_mcp_done()
\t\treturn
\t_sm.set_node_position("${gdEscape(stateName)}", Vector2(${posX}, ${posY}))
\t_mcp_output("result", {"state": "${gdEscape(stateName)}", "position": {"x": ${posX}, "y": ${posY}}})
\t_mcp_done()
`;
}

function genStateSetBlend(
  nodePath: string,
  paramName: string,
  valueSrc: string,
): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _tree: AnimationTree = _mcp_get_node("${gdEscape(nodePath)}")
\tif _tree == null or not (_tree is AnimationTree):
\t\t_mcp_output("error", "AnimationTree not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\t_tree.set("${gdEscape(paramName)}", ${valueSrc})
\t_mcp_output("result", {"parameter": "${gdEscape(paramName)}", "value": ${valueSrc}})
\t_mcp_done()
`;
}

export {
  genStateSetPosition,
  genStateSetBlend,
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function animtreeErrorMapper(errorMsg: string): string {
  if (errorMsg.includes('not found')) return ERROR_CODES.NODE_NOT_FOUND;
  return ERROR_CODES.SCRIPT_EXEC_FAILED;
}

// ─── Tool Handler ──────────────────────────────────────────────────────────

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  try {
    const projectPath = requireProjectPath(args);
    const godotPath = await ctx.findGodot();

    let code: string;

    switch (name) {
      case 'animtree_create': {
        const nodeName = args.name as string;
        const animPlayerPath = args.animation_player_path as string;
        if (!nodeName || !animPlayerPath) {
          return opsErrorResult('INVALID_PARAMS', 'name and animation_player_path are required');
        }
        const parent = args.parent ? normalizeNodePath(args.parent as string) : '/root';
        const treeRootType = (args.tree_root_type as string) || 'AnimationNodeStateMachine';
        code = genCreate(nodeName, parent, animPlayerPath, treeRootType);
        break;
      }

      case 'animtree_add_state': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const stateName = args.state_name as string;
        const animation = args.animation as string;
        if (!stateName || !animation) {
          return opsErrorResult('INVALID_PARAMS', 'state_name and animation are required');
        }
        const pos = args.position as { x?: number; y?: number } | undefined;
        const posX = pos?.x !== undefined ? ensureNumber(pos.x, 'position.x') : undefined;
        const posY = pos?.y !== undefined ? ensureNumber(pos.y, 'position.y') : undefined;
        code = genAddState(nodePath, stateName, animation, posX, posY);
        break;
      }

      case 'animtree_add_transition': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const fromState = args.from_state as string;
        const toState = args.to_state as string;
        if (!fromState || !toState) {
          return opsErrorResult('INVALID_PARAMS', 'from_state and to_state are required');
        }
        const xfadeTime = args.xfade_time !== undefined ? ensureNumber(args.xfade_time, 'xfade_time') : 0.0;
        const rawConditions = (args.conditions as Array<{ name: string; value: number | boolean }>) ?? [];
        const conditions = rawConditions
          .filter(c => c.name && c.value !== undefined && c.value !== null)
          .map(c => ({
            name: String(c.name),
            value: typeof c.value === 'boolean' ? c.value : ensureNumber(c.value, 'condition value'),
          }));
        code = genAddTransition(nodePath, fromState, toState, xfadeTime, conditions);
        break;
      }

      case 'animtree_set_blend': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const paramName = args.parameter_name as string;
        const value = args.value;
        if (!paramName || value === undefined) {
          return opsErrorResult('INVALID_PARAMS', 'parameter_name and value are required');
        }
        let valueSrc: string;
        if (typeof value === 'number') {
          valueSrc = String(value);
        } else if (typeof value === 'object' && value !== null) {
          const v = value as { x?: number; y?: number };
          valueSrc = `Vector2(${ensureNumber(v.x, 'value.x')}, ${ensureNumber(v.y, 'value.y')})`;
        } else {
          return opsErrorResult('INVALID_PARAMS', 'value must be a number or {x, y} object');
        }
        code = genSetBlend(nodePath, paramName, valueSrc);
        break;
      }

      case 'animtree_play': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const stateName = args.state_name as string;
        if (!stateName) {
          return opsErrorResult('INVALID_PARAMS', 'state_name is required');
        }
        code = genPlay(nodePath, stateName);
        break;
      }

      case 'animtree_state_edit': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const action = args.action as string;
        if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');

        if (action === 'set_position') {
          const stateName = args.state_name as string;
          const pos = args.position as { x?: number; y?: number } | undefined;
          if (!stateName || !pos || pos.x === undefined || pos.y === undefined) {
            return opsErrorResult('INVALID_PARAMS', 'state_name and position {x, y} required for set_position');
          }
          code = genStateSetPosition(nodePath, stateName, ensureNumber(pos.x, 'position.x'), ensureNumber(pos.y, 'position.y'));
        } else if (action === 'set_blend') {
          const paramName = args.parameter_name as string;
          const value = args.value;
          if (!paramName || value === undefined) {
            return opsErrorResult('INVALID_PARAMS', 'parameter_name and value required for set_blend');
          }
          let valueSrc: string;
          if (typeof value === 'number') {
            valueSrc = String(value);
          } else if (typeof value === 'object' && value !== null) {
            const v = value as { x?: number; y?: number };
            valueSrc = `Vector2(${ensureNumber(v.x, 'value.x')}, ${ensureNumber(v.y, 'value.y')})`;
          } else {
            return opsErrorResult('INVALID_PARAMS', 'value must be a number or {x, y} object');
          }
          code = genStateSetBlend(nodePath, paramName, valueSrc);
        } else {
          return opsErrorResult('INVALID_PARAMS', 'action must be "set_position" or "set_blend"');
        }
        break;
      }

      default:
        return null;
    }

    const result = await executeGdscript({
      godotPath,
      projectPath,
      code,
      timeout: 30,
      loadAutoloads: args.load_autoloads !== false,
    });

    return parseGdscriptResult(result, [], animtreeErrorMapper);
  } catch (err) {
    return opsErrorResult('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  animtree_create: { readonly: false, long_running: false },
  animtree_add_state: { readonly: false, long_running: false },
  animtree_add_transition: { readonly: false, long_running: false },
  animtree_set_blend: { readonly: false, long_running: false },
  animtree_play: { readonly: false, long_running: false },
  animtree_state_edit: { readonly: false, long_running: false },
};
