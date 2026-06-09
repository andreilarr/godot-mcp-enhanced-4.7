// UI tool entry point: definitions, handler, and meta.

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../../types.js';
import { getErrorMessage } from '../../types.js';
import { requireProjectPath, resolveWithinRoot, normalizeUserProjectPath } from '../../helpers.js';
import { executeGdscriptTrusted } from '../../gdscript-executor.js';
import { normalizeNodePath, sanitizeResPath, opsErrorResult, parseGdscriptResult, NON_PERSIST } from '../shared.js';
import { ACTIONS, CONTROL_TYPES, ANCHOR_PRESETS, ERROR_CODES, DRAW_OP_KINDS } from './types.js';
import type { DrawOp, UiNodeSpec } from './types.js';
import { genUiCreateControlScript, genUiContainerAddScript, genUiAnchorPresetScript } from './ui-create.js';
import { genUiSetLayoutScript, genUiGetLayoutScript, genUiBuildLayoutScript } from './ui-layout.js';
import { genUiSetThemeScript, genThemeCreateScript, genThemeSetPropertyScript } from './ui-theme.js';
import { genUiDrawRecipeScript } from './ui-draw.js';

// ─── Tool Definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'ui',
      description: `UI 操作。节点: ui_create_control, ui_container_add, ui_build_layout。布局: ui_set_layout, ui_get_layout, ui_anchor_preset。主题: ui_set_theme, theme_create, theme_set_property。绘图: ui_draw_recipe。${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: '操作类型',
          },
          scene_path: { type: 'string', description: '场景路径（相对项目路径）。ui_set_theme/theme_set_property 可选' },
          node_path: { type: 'string', description: '节点路径（ui_set_layout/ui_get_layout/ui_anchor_preset/ui_set_theme/ui_container_add/ui_draw_recipe）' },
          node_type: {
            type: 'string',
            enum: [...CONTROL_TYPES],
            description: 'ui_create_control/ui_container_add: Control 子类类型',
          },
          node_name: { type: 'string', description: 'ui_create_control: 新节点名称' },
          parent_node_path: { type: 'string', description: 'ui_create_control: 父节点路径（默认 root）' },
          properties: {
            type: 'object',
            description: 'ui_create_control: 可选属性（支持 string/number/bool/null）',
            additionalProperties: true,
          },
          anchors: {
            type: 'object',
            description: 'ui_set_layout: 锚点 {left, right, top, bottom}，值 0-1',
            properties: {
              left: { type: 'number' },
              right: { type: 'number' },
              top: { type: 'number' },
              bottom: { type: 'number' },
            },
          },
          offsets: {
            type: 'object',
            description: 'ui_set_layout: 边距 {left, right, top, bottom}，像素值',
            properties: {
              left: { type: 'number' },
              right: { type: 'number' },
              top: { type: 'number' },
              bottom: { type: 'number' },
            },
          },
          min_size: {
            type: 'object',
            description: 'ui_set_layout: 最小尺寸 {x, y}',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
          },
          custom_minimum_size: {
            type: 'object',
            description: 'ui_set_layout: 自定义最小尺寸 {x, y}',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
          },
          grow_direction: {
            type: 'string',
            enum: ['both', 'up', 'down', 'left', 'right'],
            description: 'ui_set_layout: 增长方向',
          },
          preset: {
            type: 'string',
            enum: Object.keys(ANCHOR_PRESETS),
            description: 'ui_anchor_preset: 锚点预设名称',
          },
          theme_action: {
            type: 'string',
            enum: ['set_params', 'create', 'save', 'load'],
            description: 'ui_set_theme: 操作类型（set_params/create/save/load）',
          },
          theme_path: { type: 'string', description: 'ui_set_theme: Theme 资源路径（save/load 时必填）' },
          params: {
            type: 'object',
            description: 'ui_set_theme(set_params): 键值对（number/bool/string/array[4]→Color）',
            additionalProperties: true,
          },
          child_type: {
            type: 'string',
            enum: [...CONTROL_TYPES],
            description: 'ui_container_add: 子节点 Control 类型',
          },
          child_name: { type: 'string', description: 'ui_container_add: 子节点名称' },
          child_properties: {
            type: 'object',
            description: 'ui_container_add: 子节点属性（支持 string/number/bool/null）',
            additionalProperties: true,
          },
          theme_create_action: {
            type: 'string',
            enum: ['create', 'extract'],
            description: 'theme_create: 操作类型（create 创建空 Theme | extract 从节点提取）',
          },
          source_node_path: { type: 'string', description: 'theme_create(extract): 源节点路径' },
          save_path: { type: 'string', description: 'theme_create: 可选保存路径（res://themes/xxx.tres）' },
          theme_node_path: { type: 'string', description: 'theme_set_property: 拥有 Theme 的节点路径' },
          item_type: {
            type: 'string',
            enum: ['default_font', 'color', 'constant', 'stylebox'],
            description: 'theme_set_property: 属性类型',
          },
          prop_name: { type: 'string', description: 'theme_set_property: 属性名' },
          theme_type: { type: 'string', description: 'theme_set_property: Theme 类型名（可选）' },
          value: {
            description: 'theme_set_property: 属性值（default_font/stylebox 为资源路径，color 为 [r,g,b,a]，constant 为数字）',
          },
          ops: {
            type: 'array',
            description: 'ui_draw_recipe: 绘图操作数组（最多 200 个）',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: [...DRAW_OP_KINDS], description: '操作类型' },
                position: { type: 'array', items: { type: 'number' }, description: '[x, y]' },
                size: { type: 'array', items: { type: 'number' }, description: '[w, h]' },
                center: { type: 'array', items: { type: 'number' }, description: '[x, y] 圆心' },
                radius: { type: 'number', description: '半径' },
                from: { type: 'array', items: { type: 'number' }, description: '[x, y] 起点' },
                to: { type: 'array', items: { type: 'number' }, description: '[x, y] 终点' },
                start_angle: { type: 'number', description: '起始角度（弧度）' },
                end_angle: { type: 'number', description: '结束角度（弧度）' },
                points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: '[[x,y], ...]' },
                text: { type: 'string', description: '文本' },
                color: { type: 'array', items: { type: 'number' }, description: '[r,g,b] 或 [r,g,b,a]，0-1' },
                width: { type: 'number', description: '线宽' },
                filled: { type: 'boolean', description: '是否填充（默认 true）' },
                font_size: { type: 'number', description: '字号（默认 16）' },
              },
              required: ['kind'],
            },
          },
          parent_path: { type: 'string', description: 'ui_build_layout: 父节点路径' },
          tree: {
            type: 'object',
            description: 'ui_build_layout: UI 节点树（最大深度 10）',
            properties: {
              type: { type: 'string', enum: [...CONTROL_TYPES], description: 'Control 子类' },
              name: { type: 'string', description: '节点名称' },
              properties: { type: 'object', additionalProperties: true, description: '节点属性' },
              anchor_preset: { type: 'string', enum: Object.keys(ANCHOR_PRESETS), description: '锚点预设' },
              layout: {
                type: 'object',
                description: 'CSS Flexbox 布局描述（存在时覆盖 type 字段）',
                properties: {
                  direction: { type: 'string', enum: ['row', 'column', 'row-reverse', 'column-reverse', 'grid'], description: '主轴方向' },
                  justify: { type: 'string', enum: ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'], description: '主轴对齐' },
                  align: { type: 'string', enum: ['stretch', 'flex-start', 'center', 'flex-end'], description: '交叉轴对齐' },
                  wrap: { type: 'string', enum: ['nowrap', 'wrap'], description: '换行模式' },
                  gap: { type: 'number', description: '主轴间距' },
                  row_gap: { type: 'number', description: '换行时行间距（仅 wrap 模式）' },
                  columns: { type: 'number', description: 'Grid 列数（仅 grid 方向）' },
                  padding: {
                    description: '内边距：数字或 [上, 右, 下, 左]',
                    oneOf: [
                      { type: 'number' },
                      { type: 'array', items: { type: 'number' } },
                    ],
                  },
                },
                required: ['direction'],
              },
              flex: {
                type: 'object',
                description: '子节点 flex 控制',
                properties: {
                  grow: { type: 'number', description: '扩展比例（0=不扩展）' },
                  shrink: { type: 'number', description: '收缩比例（忽略，无 Godot 对应）' },
                  align_self: { type: 'string', enum: ['auto', 'flex-start', 'center', 'flex-end', 'stretch'], description: '单独对齐覆盖' },
                  min_width: { type: 'number', description: '最小宽度' },
                  min_height: { type: 'number', description: '最小高度' },
                  max_width: { type: 'number', description: '最大宽度（忽略，无 Godot 对应）' },
                  max_height: { type: 'number', description: '最大高度（忽略，无 Godot 对应）' },
                },
              },
              children: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '子节点' },
            },
            required: ['type', 'name'],
          },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

export async function handleTool(
  name: string, args: Record<string, unknown>, ctx: ToolContext
): Promise<ToolResult | null> {
  if (name !== 'ui') return null;

  const action = args.action as string;
  if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');

  try {
    const projectPath = requireProjectPath(args);
    const godot = await ctx.findGodot();
    const loadAutoloads = args.load_autoloads !== false;
    let script: string;

    switch (action) {
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
        const presetValue = ANCHOR_PRESETS[presetName]!;
        script = genUiAnchorPresetScript(scenePath, nodePath, presetValue, presetName);
        break;
      }
      case 'ui_set_theme': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodePath = normalizeNodePath(args.node_path as string);
        const themeAction = args.theme_action as string;
        if (!['set_params', 'create', 'save', 'load'].includes(themeAction)) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS,
            `Invalid theme_action "${themeAction}". Must be one of: set_params, create, save, load`);
        }
        const themePath = args.theme_path as string | undefined;
        if ((themeAction === 'save' || themeAction === 'load') && !themePath) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, `theme_path is required for ${themeAction} action`);
        }
        if (themePath) {
          try { sanitizeResPath(themePath, 'theme_path'); } catch {
            return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'theme_path contains path traversal');
          }
        }
        const params = args.params as Record<string, unknown> | undefined;
        script = genUiSetThemeScript(scenePath, nodePath, themeAction as 'set_params' | 'create' | 'save' | 'load', themePath, params);
        break;
      }
      case 'ui_container_add': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodePath = normalizeNodePath(args.node_path as string);
        const childType = args.child_type as string;
        if (!CONTROL_TYPES.includes(childType as typeof CONTROL_TYPES[number])) {
          return opsErrorResult(ERROR_CODES.INVALID_CONTROL_TYPE,
            `Invalid child_type "${childType}". Must be one of: ${CONTROL_TYPES.join(', ')}`);
        }
        const childName = args.child_name as string;
        if (!childName) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'child_name is required');
        }
        const childProperties = args.child_properties as Record<string, unknown> | undefined;
        script = genUiContainerAddScript(scenePath, nodePath, childType, childName, childProperties);
        break;
      }
      case 'theme_create': {
        const themeCreateAction = args.theme_create_action as string;
        if (!['create', 'extract'].includes(themeCreateAction)) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS,
            `Invalid theme_create_action "${themeCreateAction}". Must be one of: create, extract`);
        }
        const sourceNodePath = args.source_node_path as string | undefined;
        const savePath = args.save_path as string | undefined;
        if (savePath) {
          try { sanitizeResPath(savePath, 'save_path'); } catch {
            return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'save_path contains path traversal');
          }
        }
        if (themeCreateAction === 'extract' && !sourceNodePath) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'source_node_path is required for extract action');
        }
        const scenePath = args.scene_path as string | undefined;
        const resolvedScenePath = scenePath
          ? resolveWithinRoot(projectPath, normalizeUserProjectPath(scenePath))
          : '';
        if (!resolvedScenePath) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'scene_path is required for theme_create');
        }
        const normalizedSourcePath = sourceNodePath ? normalizeNodePath(sourceNodePath) : undefined;
        script = genThemeCreateScript(resolvedScenePath, themeCreateAction as 'create' | 'extract', normalizedSourcePath, savePath);
        break;
      }
      case 'theme_set_property': {
        const themeNodePath = normalizeNodePath(args.theme_node_path as string);
        const itemType = args.item_type as string;
        if (!['default_font', 'color', 'constant', 'stylebox'].includes(itemType)) {
          return opsErrorResult(ERROR_CODES.INVALID_THEME_ITEM_TYPE,
            `Invalid item_type "${itemType}". Must be one of: default_font, color, constant, stylebox`);
        }
        const propName = (args.prop_name || args.name) as string;
        if (!propName) {
          return opsErrorResult(ERROR_CODES.INVALID_THEME_PROPERTY, 'prop_name (or name) is required');
        }
        const value = args.value;
        if (value === undefined || value === null) {
          return opsErrorResult(ERROR_CODES.INVALID_THEME_PROPERTY, 'value is required');
        }
        const themeType = args.theme_type as string | undefined;
        const scenePathParam = args.scene_path as string | undefined;
        const resolvedScenePath = scenePathParam
          ? resolveWithinRoot(projectPath, normalizeUserProjectPath(scenePathParam))
          : undefined;
        script = genThemeSetPropertyScript(
          projectPath, themeNodePath,
          itemType as 'default_font' | 'color' | 'constant' | 'stylebox',
          propName, value, themeType, resolvedScenePath,
        );
        break;
      }
      case 'ui_draw_recipe': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodePath = normalizeNodePath(args.node_path as string);
        const ops = args.ops as DrawOp[];
        if (!Array.isArray(ops)) {
          return opsErrorResult(ERROR_CODES.INVALID_DRAW_OP, 'ops must be an array');
        }
        try {
          script = genUiDrawRecipeScript(scenePath, nodePath, ops);
        } catch (err) {
          const msg = getErrorMessage(err);
          if (msg.includes('Unknown draw op kind') || msg.includes('Maximum') || msg.includes('Color must be')) {
            return opsErrorResult(ERROR_CODES.INVALID_DRAW_OP, msg);
          }
          return opsErrorResult(ERROR_CODES.SCRIPT_EXEC_FAILED, msg);
        }
        break;
      }
      case 'ui_build_layout': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const parentPath = normalizeNodePath((args.parent_path as string) || 'root');
        const tree = args.tree as UiNodeSpec;
        if (!tree || typeof tree !== 'object') {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'tree is required and must be an object');
        }
        try {
          script = genUiBuildLayoutScript(scenePath, parentPath, tree);
        } catch (err) {
          const msg = getErrorMessage(err);
          if (msg.includes('INVALID_CONTROL_TYPE')) {
            return opsErrorResult(ERROR_CODES.INVALID_CONTROL_TYPE, msg);
          }
          if (msg.includes('INVALID_ANCHOR_PRESET')) {
            return opsErrorResult(ERROR_CODES.INVALID_ANCHOR_PRESET, msg);
          }
          if (msg.includes('name is required') || msg.includes('Maximum nesting')) {
            return opsErrorResult(ERROR_CODES.INVALID_PARAMS, msg);
          }
          return opsErrorResult(ERROR_CODES.SCRIPT_EXEC_FAILED, msg);
        }
        break;
      }
      default:
        return null;
    }

    const result = await executeGdscriptTrusted({
      godotPath: godot,
      projectPath,
      code: script,
      timeout: 30,
      loadAutoloads,
    });

    const errorMapper = (msg: string) => {
      if (msg.includes('not found')) return ERROR_CODES.NODE_NOT_FOUND;
      if (msg.includes('not a Control')) return ERROR_CODES.INVALID_PARAMS;
      if (msg.includes('no theme')) return ERROR_CODES.THEME_NOT_FOUND;
      if (msg.includes('not a Theme')) return ERROR_CODES.THEME_NOT_FOUND;
      return ERROR_CODES.SCRIPT_EXEC_FAILED;
    };

    return parseGdscriptResult(result, [], errorMapper);
  } catch (err) {
    const msg = getErrorMessage(err);
    if (msg.includes('NodePath')) return opsErrorResult('INVALID_PATH', msg);
    return opsErrorResult(ERROR_CODES.SCRIPT_EXEC_FAILED, msg);
  }
}

// ─── Tool Meta ──────────────────────────────────────────────────────────────

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  ui: { readonly: false, long_running: false },
};
