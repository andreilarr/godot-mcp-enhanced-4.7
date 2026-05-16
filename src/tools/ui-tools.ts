import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { validatePath, resolveWithinRoot, normalizeUserProjectPath } from '../helpers.js';
import { executeGdscript } from '../gdscript-executor.js';
import { normalizeNodePath, gdEscape } from './shared.js';
import { SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, parseGdscriptResult } from './shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

export const TOOL_NAMES = [
  'ui_create_control',
  'ui_set_layout',
  'ui_get_layout',
  'ui_anchor_preset',
] as const;

const CONTROL_TYPES = [
  'Button', 'Label', 'Panel', 'LineEdit', 'TextEdit', 'RichTextLabel',
  'LinkButton', 'HSlider', 'VSlider', 'CheckBox', 'CheckButton',
  'OptionButton', 'SpinBox', 'ProgressBar', 'TextureRect',
  'ColorPickerButton', 'TabContainer', 'Tree', 'ItemList',
  'MarginContainer', 'HBoxContainer', 'VBoxContainer', 'GridContainer',
  'CenterContainer', 'ScrollContainer', 'PanelContainer',
  'HSplitContainer', 'VSplitContainer', 'NinePatchRect',
] as const;

const ANCHOR_PRESETS: Record<string, number> = {
  top_left: 0,
  top_right: 1,
  bottom_left: 2,
  bottom_right: 3,
  center_left: 4,
  center_top: 5,
  center_right: 6,
  center_bottom: 7,
  center: 8,
  left_wide: 9,
  top_wide: 10,
  right_wide: 11,
  bottom_wide: 12,
  vcenter_wide: 13,
  hcenter_wide: 14,
  full_rect: 15,
};

const ERROR_CODES = {
  INVALID_CONTROL_TYPE: 'INVALID_CONTROL_TYPE',
  INVALID_ANCHOR_PRESET: 'INVALID_ANCHOR_PRESET',
  INVALID_PARAMS: 'INVALID_PARAMS',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
} as const;

// ─── Helpers ───────────────────────────────────────────────────────────────

function serializePropertyValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return `"${gdEscape(value)}"`;
  throw new Error(`Unsupported property type: ${typeof value}`);
}

function genPropertyLines(properties: Record<string, unknown>): string {
  let lines = '';
  for (const [key, value] of Object.entries(properties)) {
    lines += `\n\tnode.set("${gdEscape(key)}", ${serializePropertyValue(value)})`;
  }
  return lines;
}

// ─── GDScript Generators ───────────────────────────────────────────────────

export function genUiCreateControlScript(
  scenePath: string,
  nodeType: string,
  nodeName: string,
  parentPath: string,
  properties?: Record<string, unknown>,
): string {
  const propLines = properties && Object.keys(properties).length > 0
    ? genPropertyLines(properties)
    : '';

  return `${SCENE_TREE_HEADER}
func _initialize():
\tif not _mcp_load_scene("${gdEscape(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar parent = _mcp_get_scene_node("${gdEscape(parentPath)}")
\tif parent == null:
\t\t_mcp_output("error", "Parent node not found: ${gdEscape(parentPath)}")
\t\t_mcp_done()
\t\treturn
\tvar node = ${nodeType}.new()
\tnode.name = "${gdEscape(nodeName)}"${propLines}
\tparent.add_child(node)
\tnode.owner = parent.owner if parent.owner != null else parent
\t_mcp_output("created", {"type": "${gdEscape(nodeType)}", "name": "${gdEscape(nodeName)}", "path": str(node.get_path()) if node.is_inside_tree() else "${gdEscape(nodeName)}"})
\t_mcp_done()
`;
}

export function genUiSetLayoutScript(
  scenePath: string,
  nodePath: string,
  anchors?: { left?: number; right?: number; top?: number; bottom?: number },
  offsets?: { left?: number; right?: number; top?: number; bottom?: number },
  minSize?: { x?: number; y?: number },
  customMinSize?: { x?: number; y?: number },
  growDirection?: string,
): string {
  let lines = '';

  if (anchors) {
    if (anchors.left !== undefined) lines += `\n\tnode.anchor_left = ${anchors.left}`;
    if (anchors.right !== undefined) lines += `\n\tnode.anchor_right = ${anchors.right}`;
    if (anchors.top !== undefined) lines += `\n\tnode.anchor_top = ${anchors.top}`;
    if (anchors.bottom !== undefined) lines += `\n\tnode.anchor_bottom = ${anchors.bottom}`;
  }
  if (offsets) {
    if (offsets.left !== undefined) lines += `\n\tnode.offset_left = ${offsets.left}`;
    if (offsets.right !== undefined) lines += `\n\tnode.offset_right = ${offsets.right}`;
    if (offsets.top !== undefined) lines += `\n\tnode.offset_top = ${offsets.top}`;
    if (offsets.bottom !== undefined) lines += `\n\tnode.offset_bottom = ${offsets.bottom}`;
  }
  if (minSize) {
    if (minSize.x !== undefined) lines += `\n\tnode.custom_minimum_size = Vector2(${minSize.x}, node.custom_minimum_size.y)`;
    if (minSize.y !== undefined) lines += `\n\tnode.custom_minimum_size = Vector2(node.custom_minimum_size.x, ${minSize.y})`;
  }
  if (customMinSize) {
    lines += `\n\tnode.custom_minimum_size = Vector2(${customMinSize.x ?? 'node.custom_minimum_size.x'}, ${customMinSize.y ?? 'node.custom_minimum_size.y'})`;
  }
  if (growDirection) {
    const dirMap: Record<string, string> = {
      both: 'Control.GROW_DIRECTION_BOTH',
      up: 'Control.GROW_DIRECTION_UP',
      down: 'Control.GROW_DIRECTION_DOWN',
      left: 'Control.GROW_DIRECTION_LEFT',
      right: 'Control.GROW_DIRECTION_RIGHT',
    };
    const gdDir = dirMap[growDirection.toLowerCase()];
    if (gdDir) {
      lines += `\n\tnode.grow_horizontal = ${gdDir}`;
      lines += `\n\tnode.grow_vertical = ${gdDir}`;
    }
  }

  return `${SCENE_TREE_HEADER}
func _initialize():
\tif not _mcp_load_scene("${gdEscape(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar node = _mcp_get_scene_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not node is Control:
\t\t_mcp_output("error", "Node is not a Control: " + node.get_class())
\t\t_mcp_done()
\t\treturn${lines}
\t_mcp_output("layout_set", {"node": "${gdEscape(nodePath)}"})
\t_mcp_done()
`;
}

export function genUiGetLayoutScript(
  scenePath: string,
  nodePath: string,
): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\tif not _mcp_load_scene("${gdEscape(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar node = _mcp_get_scene_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not node is Control:
\t\t_mcp_output("error", "Node is not a Control: " + node.get_class())
\t\t_mcp_done()
\t\treturn
\tvar info = {
\t\t"anchor_left": node.anchor_left,
\t\t"anchor_right": node.anchor_right,
\t\t"anchor_top": node.anchor_top,
\t\t"anchor_bottom": node.anchor_bottom,
\t\t"offset_left": node.offset_left,
\t\t"offset_right": node.offset_right,
\t\t"offset_top": node.offset_top,
\t\t"offset_bottom": node.offset_bottom,
\t\t"global_position": {"x": node.global_position.x, "y": node.global_position.y},
\t\t"size": {"x": node.size.x, "y": node.size.y}
\t}
\t_mcp_output("layout", info)
\t_mcp_done()
`;
}

export function genUiAnchorPresetScript(
  scenePath: string,
  nodePath: string,
  presetValue: number,
  presetName: string,
): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\tif not _mcp_load_scene("${gdEscape(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar node = _mcp_get_scene_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not node is Control:
\t\t_mcp_output("error", "Node is not a Control: " + node.get_class())
\t\t_mcp_done()
\t\treturn
\tnode.set_anchors_preset(${presetValue})
\t_mcp_output("preset_applied", {"node": "${gdEscape(nodePath)}", "preset": "${gdEscape(presetName)}", "value": ${presetValue}})
\t_mcp_done()
`;
}

// ─── Tool Definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'ui_create_control',
      description: `Add a UI Control node to a scene. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          scene_path: { type: 'string', description: 'Scene path relative to project' },
          node_type: {
            type: 'string',
            enum: [...CONTROL_TYPES],
            description: 'Control 子类类型',
          },
          node_name: { type: 'string', description: '新节点名称' },
          parent_node_path: { type: 'string', description: '父节点路径（默认 root）' },
          properties: {
            type: 'object',
            description: '可选属性（支持 string/number/bool/null）',
            additionalProperties: true,
          },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'scene_path', 'node_type', 'node_name'],
      },
    },
    {
      name: 'ui_set_layout',
      description: `Set layout properties (anchors, offsets, min size) on a Control node. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          scene_path: { type: 'string', description: 'Scene path relative to project' },
          node_path: { type: 'string', description: 'Control 节点路径' },
          anchors: {
            type: 'object',
            description: '锚点 {left, right, top, bottom}，值 0-1',
            properties: {
              left: { type: 'number' },
              right: { type: 'number' },
              top: { type: 'number' },
              bottom: { type: 'number' },
            },
          },
          offsets: {
            type: 'object',
            description: '边距 {left, right, top, bottom}，像素值',
            properties: {
              left: { type: 'number' },
              right: { type: 'number' },
              top: { type: 'number' },
              bottom: { type: 'number' },
            },
          },
          min_size: {
            type: 'object',
            description: '最小尺寸 {x, y}',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
          },
          custom_minimum_size: {
            type: 'object',
            description: '自定义最小尺寸 {x, y}',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
          },
          grow_direction: {
            type: 'string',
            enum: ['both', 'up', 'down', 'left', 'right'],
            description: '增长方向',
          },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'scene_path', 'node_path'],
      },
    },
    {
      name: 'ui_get_layout',
      description: `Get layout info (anchors, offsets, position, size) of a Control node. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          scene_path: { type: 'string', description: 'Scene path relative to project' },
          node_path: { type: 'string', description: 'Control 节点路径' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'scene_path', 'node_path'],
      },
    },
    {
      name: 'ui_anchor_preset',
      description: `Apply an anchor preset to a Control node. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          scene_path: { type: 'string', description: 'Scene path relative to project' },
          node_path: { type: 'string', description: 'Control 节点路径' },
          preset: {
            type: 'string',
            enum: Object.keys(ANCHOR_PRESETS),
            description: '锚点预设名称',
          },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'scene_path', 'node_path', 'preset'],
      },
    },
  ];
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

export async function handleTool(
  name: string, args: Record<string, unknown>, ctx: ToolContext
): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  try {
    const projectPath = validatePath(args.project_path as string);
    const godot = await ctx.findGodot();
    const loadAutoloads = args.load_autoloads !== false;
    let script: string;

    switch (name) {
      case 'ui_create_control': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodeType = args.node_type as string;
        const nodeName = args.node_name as string;
        if (!CONTROL_TYPES.includes(nodeType as typeof CONTROL_TYPES[number])) {
          return opsErrorResult(ERROR_CODES.INVALID_CONTROL_TYPE,
            `Invalid node_type "${nodeType}". Must be one of: ${CONTROL_TYPES.join(', ')}`);
        }
        if (!nodeName) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'node_name is required');
        }
        const parentPath = normalizeNodePath((args.parent_node_path as string) || 'root');
        const properties = args.properties as Record<string, unknown> | undefined;
        script = genUiCreateControlScript(scenePath, nodeType, nodeName, parentPath, properties);
        break;
      }
      case 'ui_set_layout': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodePath = normalizeNodePath(args.node_path as string);
        const anchors = args.anchors as { left?: number; right?: number; top?: number; bottom?: number } | undefined;
        const offsets = args.offsets as { left?: number; right?: number; top?: number; bottom?: number } | undefined;
        const minSize = args.min_size as { x?: number; y?: number } | undefined;
        const customMinSize = args.custom_minimum_size as { x?: number; y?: number } | undefined;
        const growDirection = args.grow_direction as string | undefined;
        script = genUiSetLayoutScript(scenePath, nodePath, anchors, offsets, minSize, customMinSize, growDirection);
        break;
      }
      case 'ui_get_layout': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodePath = normalizeNodePath(args.node_path as string);
        script = genUiGetLayoutScript(scenePath, nodePath);
        break;
      }
      case 'ui_anchor_preset': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodePath = normalizeNodePath(args.node_path as string);
        const presetName = args.preset as string;
        if (!(presetName in ANCHOR_PRESETS)) {
          return opsErrorResult(ERROR_CODES.INVALID_ANCHOR_PRESET,
            `Invalid preset "${presetName}". Must be one of: ${Object.keys(ANCHOR_PRESETS).join(', ')}`);
        }
        const presetValue = ANCHOR_PRESETS[presetName];
        script = genUiAnchorPresetScript(scenePath, nodePath, presetValue, presetName);
        break;
      }
      default:
        return null;
    }

    const result = await executeGdscript({
      godotPath: godot,
      projectPath,
      code: script,
      timeout: 30,
      loadAutoloads,
    });

    const errorMapper = (msg: string) => {
      if (msg.includes('not found')) return ERROR_CODES.NODE_NOT_FOUND;
      if (msg.includes('not a Control')) return ERROR_CODES.INVALID_PARAMS;
      return ERROR_CODES.SCRIPT_EXEC_FAILED;
    };

    return parseGdscriptResult(result, [], errorMapper);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('NodePath')) return opsErrorResult('INVALID_PATH', msg);
    return opsErrorResult(ERROR_CODES.SCRIPT_EXEC_FAILED, msg);
  }
}

// ─── Tool Meta ──────────────────────────────────────────────────────────────

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  ui_create_control: { readonly: false, long_running: false },
  ui_set_layout: { readonly: false, long_running: false },
  ui_get_layout: { readonly: true, long_running: false },
  ui_anchor_preset: { readonly: false, long_running: false },
};
