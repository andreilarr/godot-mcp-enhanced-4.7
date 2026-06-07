// UI layout operations: ui_set_layout, ui_get_layout, ui_build_layout.

import { gdEscape, valueToGd, SCENE_TREE_HEADER } from '../shared.js';
import { CONTROL_TYPES, ANCHOR_PRESETS } from './types.js';
import type { FlexLayout, FlexChild, UiNodeSpec } from './types.js';

// ─── ui_set_layout ────────────────────────────────────────────────────────

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
    const dir = growDirection.toLowerCase();
    const dirMap: Record<string, string> = {
      both: 'Control.GROW_DIRECTION_BOTH',
      up: 'Control.GROW_DIRECTION_UP',
      down: 'Control.GROW_DIRECTION_DOWN',
      left: 'Control.GROW_DIRECTION_LEFT',
      right: 'Control.GROW_DIRECTION_RIGHT',
    };
    const gdDir = dirMap[dir];
    if (gdDir) {
      if (dir === 'left' || dir === 'right' || dir === 'both') {
        lines += `\n\tnode.grow_horizontal = ${gdDir}`;
      }
      if (dir === 'up' || dir === 'down' || dir === 'both') {
        lines += `\n\tnode.grow_vertical = ${gdDir}`;
      }
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

// ─── ui_get_layout ────────────────────────────────────────────────────────

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

// ─── ui_build_layout ──────────────────────────────────────────────────────

const MAX_NESTING_DEPTH = 10;

const VALID_DIRECTIONS = ['row', 'column', 'row-reverse', 'column-reverse', 'grid'] as const;
const VALID_JUSTIFY = ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'] as const;
const VALID_ALIGN = ['stretch', 'flex-start', 'center', 'flex-end'] as const;
const VALID_WRAP = ['nowrap', 'wrap'] as const;
const VALID_ALIGN_SELF = ['auto', 'flex-start', 'center', 'flex-end', 'stretch'] as const;

function validateUiNodeSpec(spec: UiNodeSpec, depth: number, warnings: string[] = []): void {
  if (depth > MAX_NESTING_DEPTH) {
    throw new Error(`Maximum nesting depth is ${MAX_NESTING_DEPTH}, exceeded at node "${spec.name}"`);
  }
  if (!spec.layout && !CONTROL_TYPES.includes(spec.type as typeof CONTROL_TYPES[number])) {
    throw new Error(`INVALID_CONTROL_TYPE: "${spec.type}" is not a whitelisted Control type`);
  }
  if (!spec.name) {
    throw new Error('name is required for each UiNodeSpec');
  }
  if (spec.anchor_preset && !(spec.anchor_preset in ANCHOR_PRESETS)) {
    throw new Error(`INVALID_ANCHOR_PRESET: "${spec.anchor_preset}"`);
  }
  if (spec.layout) {
    validateFlexLayout(spec.layout, warnings);
  }
  if (spec.flex) {
    validateFlexChild(spec.flex, warnings);
  }
  if (spec.children) {
    for (const child of spec.children) {
      validateUiNodeSpec(child, depth + 1, warnings);
    }
  }
}

function validateFlexLayout(layout: FlexLayout, warnings: string[]): void {
  if (!VALID_DIRECTIONS.includes(layout.direction)) {
    throw new Error(`INVALID_LAYOUT: direction must be one of: ${VALID_DIRECTIONS.join(', ')}, got "${layout.direction}"`);
  }
  if (layout.gap !== undefined && (typeof layout.gap !== 'number' || layout.gap < 0 || !Number.isFinite(layout.gap))) {
    throw new Error('INVALID_LAYOUT: gap must be a non-negative finite number');
  }
  if (layout.row_gap !== undefined && (typeof layout.row_gap !== 'number' || layout.row_gap < 0 || !Number.isFinite(layout.row_gap))) {
    throw new Error('INVALID_LAYOUT: row_gap must be a non-negative finite number');
  }
  if (layout.justify !== undefined && !VALID_JUSTIFY.includes(layout.justify)) {
    throw new Error(`INVALID_LAYOUT: justify must be one of: ${VALID_JUSTIFY.join(', ')}, got "${layout.justify}"`);
  }
  if (layout.align !== undefined && !VALID_ALIGN.includes(layout.align)) {
    throw new Error(`INVALID_LAYOUT: align must be one of: ${VALID_ALIGN.join(', ')}, got "${layout.align}"`);
  }
  if (layout.wrap !== undefined && !VALID_WRAP.includes(layout.wrap)) {
    throw new Error(`INVALID_LAYOUT: wrap must be one of: ${VALID_WRAP.join(', ')}, got "${layout.wrap}"`);
  }
  if (layout.padding !== undefined) {
    if (typeof layout.padding === 'number') {
      if (layout.padding < 0) throw new Error('INVALID_LAYOUT: padding must be non-negative');
    } else if (Array.isArray(layout.padding)) {
      if (layout.padding.length !== 4 || layout.padding.some(v => typeof v !== 'number' || v < 0)) {
        throw new Error('INVALID_LAYOUT: padding array must be [top, right, bottom, left] with non-negative numbers');
      }
    } else {
      throw new Error('INVALID_LAYOUT: padding must be a number or [top, right, bottom, left] array');
    }
  }
  if (layout.row_gap !== undefined && layout.wrap !== 'wrap') {
    warnings.push('layout.row_gap is ignored when wrap is not "wrap"');
  }
  if (layout.justify !== undefined && ['space-between', 'space-around', 'space-evenly'].includes(layout.justify)) {
    warnings.push(`layout.justify "${layout.justify}" is approximated (no exact Godot equivalent)`);
  }
}

function validateFlexChild(flex: FlexChild, warnings: string[]): void {
  if (flex.grow !== undefined && (typeof flex.grow !== 'number' || flex.grow < 0 || !Number.isFinite(flex.grow))) {
    throw new Error('INVALID_FLEX: grow must be a non-negative finite number');
  }
  // I-05: validate min_width/min_height to prevent Infinity/NaN/negative values in GDScript
  if (flex.min_width !== undefined && (typeof flex.min_width !== 'number' || flex.min_width < 0 || !Number.isFinite(flex.min_width))) {
    throw new Error('INVALID_FLEX: min_width must be a non-negative finite number');
  }
  if (flex.min_height !== undefined && (typeof flex.min_height !== 'number' || flex.min_height < 0 || !Number.isFinite(flex.min_height))) {
    throw new Error('INVALID_FLEX: min_height must be a non-negative finite number');
  }
  if (flex.align_self !== undefined && !VALID_ALIGN_SELF.includes(flex.align_self)) {
    throw new Error(`INVALID_FLEX: align_self must be one of: ${VALID_ALIGN_SELF.join(', ')}, got "${flex.align_self}"`);
  }
  if (flex.shrink !== undefined) {
    warnings.push('flex.shrink is ignored (no Godot equivalent)');
  }
  if (flex.max_width !== undefined) {
    warnings.push('flex.max_width is ignored (no Godot equivalent)');
  }
  if (flex.max_height !== undefined) {
    warnings.push('flex.max_height is ignored (no Godot equivalent)');
  }
}

function resolveFlexContainer(layout: FlexLayout): {
  containerType: string;
  isReverse: boolean;
  isWrap: boolean;
  isGrid: boolean;
} {
  if (layout.direction === 'grid') {
    return { containerType: 'GridContainer', isReverse: false, isWrap: false, isGrid: true };
  }
  const isReverse = layout.direction === 'row-reverse' || layout.direction === 'column-reverse';
  const isRow = layout.direction === 'row' || layout.direction === 'row-reverse';
  const isWrap = layout.wrap === 'wrap';

  let containerType: string;
  if (isWrap) {
    containerType = isRow ? 'HFlowContainer' : 'VFlowContainer';
  } else {
    containerType = isRow ? 'HBoxContainer' : 'VBoxContainer';
  }

  return { containerType, isReverse, isWrap, isGrid: false };
}

function genFlexContainerProps(layout: FlexLayout, indent: string, warnings: string[] = []): string {
  const { isWrap, isGrid } = resolveFlexContainer(layout);
  const isRow = layout.direction === 'row' || layout.direction === 'row-reverse';
  let lines = '';

  if (isGrid) {
    if (layout.columns !== undefined && layout.columns > 0) {
      lines += `\n${indent}node.columns = ${Math.floor(layout.columns)}`;
    }
    if (layout.gap !== undefined) {
      lines += `\n${indent}node.add_theme_constant_override("h_separation", ${layout.gap})`;
      const vSep = layout.row_gap ?? layout.gap;
      lines += `\n${indent}node.add_theme_constant_override("v_separation", ${vSep})`;
    }
    if (layout.padding !== undefined) {
      const p = typeof layout.padding === 'number'
        ? [layout.padding, layout.padding, layout.padding, layout.padding]
        : layout.padding;
      lines += `\n${indent}node.add_theme_constant_override("margin_top", ${p[0]})`;
      lines += `\n${indent}node.add_theme_constant_override("margin_right", ${p[1]})`;
      lines += `\n${indent}node.add_theme_constant_override("margin_bottom", ${p[2]})`;
      lines += `\n${indent}node.add_theme_constant_override("margin_left", ${p[3]})`;
    }
    return lines;
  }

  if (layout.justify) {
    if (isWrap) {
      warnings.push('layout.justify is ignored when wrap is "wrap" (FlowContainer has no alignment)');
    } else {
      const justifyMap: Record<string, number> = {
        'flex-start': 0,
        'center': 1,
        'flex-end': 2,
        'space-between': 0,
        'space-around': 1,
        'space-evenly': 1,
      };
      const alignment = justifyMap[layout.justify];
      if (alignment !== undefined) {
        lines += `\n${indent}node.alignment = ${alignment}`;
      }
    }
  }

  if (layout.gap !== undefined) {
    if (isWrap) {
      if (isRow) {
        lines += `\n${indent}node.add_theme_constant_override("h_separation", ${layout.gap})`;
        const vSep = layout.row_gap ?? layout.gap;
        lines += `\n${indent}node.add_theme_constant_override("v_separation", ${vSep})`;
      } else {
        const hSep = layout.row_gap ?? layout.gap;
        lines += `\n${indent}node.add_theme_constant_override("h_separation", ${hSep})`;
        lines += `\n${indent}node.add_theme_constant_override("v_separation", ${layout.gap})`;
      }
    } else {
      lines += `\n${indent}node.add_theme_constant_override("separation", ${layout.gap})`;
    }
  }

  if (layout.padding !== undefined && !isWrap) {
    const p = typeof layout.padding === 'number'
      ? [layout.padding, layout.padding, layout.padding, layout.padding]
      : layout.padding;
    lines += `\n${indent}node.add_theme_constant_override("margin_top", ${p[0]})`;
    lines += `\n${indent}node.add_theme_constant_override("margin_right", ${p[1]})`;
    lines += `\n${indent}node.add_theme_constant_override("margin_bottom", ${p[2]})`;
    lines += `\n${indent}node.add_theme_constant_override("margin_left", ${p[3]})`;
  }

  return lines;
}

function applyAlignSelf(align: string, isRow: boolean, indent: string, warnings?: string[]): string {
  if (align === 'stretch') {
    if (isRow) {
      return `\n${indent}node.size_flags_vertical = node.size_flags_vertical | Control.SIZE_EXPAND_FILL`;
    } else {
      return `\n${indent}node.size_flags_horizontal = node.size_flags_horizontal | Control.SIZE_EXPAND_FILL`;
    }
  } else if (align === 'center') {
    if (isRow) {
      return `\n${indent}node.size_flags_vertical = (node.size_flags_vertical & ~Control.SIZE_EXPAND & ~Control.SIZE_FILL) | Control.SIZE_SHRINK_CENTER`;
    } else {
      return `\n${indent}node.size_flags_horizontal = (node.size_flags_horizontal & ~Control.SIZE_EXPAND & ~Control.SIZE_FILL) | Control.SIZE_SHRINK_CENTER`;
    }
  } else if (align === 'flex-end') {
    warnings?.push('align/flex.align_self "flex-end" has no direct Container equivalent; consider adding a spacer child with SIZE_EXPAND before this node to push it to the end');
  }
  return '';
}

function genFlexChildLines(flex: FlexChild, isRow: boolean, indent: string, warnings?: string[]): string {
  let lines = '';

  if (flex.grow !== undefined && flex.grow > 0) {
    lines += `\n${indent}node.size_flags_stretch_ratio = ${flex.grow}`;
    if (isRow) {
      lines += `\n${indent}node.size_flags_horizontal = node.size_flags_horizontal | Control.SIZE_EXPAND`;
    } else {
      lines += `\n${indent}node.size_flags_vertical = node.size_flags_vertical | Control.SIZE_EXPAND`;
    }
  }

  if (flex.align_self && flex.align_self !== 'auto') {
    lines += applyAlignSelf(flex.align_self, isRow, indent, warnings);
  }

  if (flex.min_width !== undefined || flex.min_height !== undefined) {
    const w = flex.min_width ?? 'node.custom_minimum_size.x';
    const h = flex.min_height ?? 'node.custom_minimum_size.y';
    lines += `\n${indent}node.custom_minimum_size = Vector2(${w}, ${h})`;
  }

  return lines;
}

function uiNodeToGd(spec: UiNodeSpec, parentVar: string, ownerVar: string, indent: string, warnings: string[] = [], nextId: () => number = () => 0): string {
  if (spec.layout) {
    return uiNodeToGdWithLayout(spec, parentVar, ownerVar, indent, warnings, nextId);
  }
  const anchorLine = spec.anchor_preset
    ? `\n${indent}node.set_anchors_preset(${ANCHOR_PRESETS[spec.anchor_preset]})`
    : '';
  const propLines = spec.properties && Object.keys(spec.properties).length > 0
    ? '\n' + Object.entries(spec.properties).map(
        ([k, v]) => `${indent}node.set("${gdEscape(k)}", ${valueToGd(v)})`
      ).join('\n')
    : '';

  let lines = `${indent}node = ClassDB.instantiate("${gdEscape(spec.type)}")
${indent}if node == null:
${indent}\t_mcp_output("error", "Failed to instantiate: ${gdEscape(spec.type)}")
${indent}\t_mcp_done()
${indent}\treturn
${indent}node.name = "${gdEscape(spec.name)}"${anchorLine}${propLines}`;

  if (spec.children && spec.children.length > 0) {
    const savedIdx = nextId();
    const savedVar = `_saved_${savedIdx}`;
    lines += `\n${indent}var ${savedVar} = node`;
    for (const child of spec.children) {
      lines += '\n' + uiNodeToGd(child, savedVar, ownerVar, indent, warnings, nextId);
    }
    lines += `\n${indent}node = ${savedVar}`;
  }

  lines += `\n${indent}${parentVar}.add_child(node)
${indent}node.owner = ${ownerVar}`;

  return lines;
}

function uiNodeToGdWithLayout(spec: UiNodeSpec, parentVar: string, ownerVar: string, indent: string, warnings: string[], nextId: () => number): string {
  const layout = spec.layout!;
  const { containerType, isReverse, isWrap, isGrid } = resolveFlexContainer(layout);
  const isRow = layout.direction === 'row' || layout.direction === 'row-reverse';

  if (isGrid && layout.justify) warnings.push('layout.justify is ignored for grid direction');
  if (isGrid && layout.align) warnings.push('layout.align is ignored for grid direction');
  if (isGrid && layout.wrap) warnings.push('layout.wrap is ignored for grid direction');
  if (isGrid && (layout.columns === undefined || layout.columns <= 0)) warnings.push('Grid layout without columns: GridContainer defaults to 1 column');

  let lines = `${indent}node = ClassDB.instantiate("${gdEscape(containerType)}")
${indent}if node == null:
${indent}\t_mcp_output("error", "Failed to instantiate: ${gdEscape(containerType)}")
${indent}\t_mcp_done()
${indent}\treturn
${indent}node.name = "${gdEscape(spec.name)}"`;

  const preset = spec.anchor_preset ? ANCHOR_PRESETS[spec.anchor_preset] : 15;
  lines += `\n${indent}node.set_anchors_preset(${preset})`;

  if (spec.properties && Object.keys(spec.properties).length > 0) {
    lines += '\n' + Object.entries(spec.properties).map(
      ([k, v]) => `${indent}node.set("${gdEscape(k)}", ${valueToGd(v)})`
    ).join('\n');
  }

  lines += genFlexContainerProps(layout, indent, warnings);

  let marginWrapperVar: string | null = null;
  if (isWrap && layout.padding !== undefined) {
    const p = typeof layout.padding === 'number'
      ? [layout.padding, layout.padding, layout.padding, layout.padding]
      : layout.padding;
    const marginIdx = nextId();
    marginWrapperVar = `_margin_${marginIdx}`;
    const marginBlock = `${indent}var ${marginWrapperVar} = ClassDB.instantiate("MarginContainer")
${indent}${marginWrapperVar}.name = "${gdEscape(spec.name)}_margin"
${indent}${marginWrapperVar}.add_theme_constant_override("margin_top", ${p[0]})
${indent}${marginWrapperVar}.add_theme_constant_override("margin_right", ${p[1]})
${indent}${marginWrapperVar}.add_theme_constant_override("margin_bottom", ${p[2]})
${indent}${marginWrapperVar}.add_theme_constant_override("margin_left", ${p[3]})
${indent}${marginWrapperVar}.set_anchors_preset(${preset})`;
    lines = marginBlock + '\n' + lines;
  }

  const savedIdx = nextId();
  const savedVar = `_saved_${savedIdx}`;
  lines += `\n${indent}var ${savedVar} = node`;

  let children = spec.children ?? [];
  if (isReverse) {
    children = [...children].reverse();
  }

  for (const child of children) {
    lines += '\n' + uiNodeToGd(child, savedVar, ownerVar, indent, warnings, nextId);

    if (layout.align && (!child.flex || !child.flex.align_self || child.flex.align_self === 'auto')) {
      lines += applyAlignSelf(layout.align, isRow, indent, warnings);
    }

    if (child.flex) {
      lines += genFlexChildLines(child.flex, isRow, indent, warnings);
    }
  }

  lines += `\n${indent}node = ${savedVar}`;

  if (marginWrapperVar) {
    lines += `\n${indent}node = ${marginWrapperVar}`;
    lines += `\n${indent}${marginWrapperVar}.add_child(${savedVar})`;
    lines += `\n${indent}${savedVar}.owner = ${ownerVar}`;
    lines += `\n${indent}${parentVar}.add_child(node)`;
    lines += `\n${indent}node.owner = ${ownerVar}`;
  } else {
    lines += `\n${indent}${parentVar}.add_child(node)`;
    lines += `\n${indent}node.owner = ${ownerVar}`;
  }

  return lines;
}

export function genUiBuildLayoutScript(
  scenePath: string,
  parentPath: string,
  tree: UiNodeSpec,
): string {
  const warnings: string[] = [];
  validateUiNodeSpec(tree, 1, warnings);

  let _idCounter = 0;
  const nextId = () => _idCounter++;
  const buildBlock = uiNodeToGd(tree, 'parent', 'root', '\t', warnings, nextId);

  const warningLines = warnings.length > 0
    ? `\n\t_mcp_output("warnings", ${JSON.stringify(warnings.map(w => {
      const dot = w.indexOf('.');
      const field = dot > 0 ? w.substring(0, dot) : 'layout';
      return { field, message: w };
    }))})`
    : '';

  const rootType = tree.layout ? resolveFlexContainer(tree.layout).containerType : tree.type;

  return `${SCENE_TREE_HEADER}
func _initialize():
\tif not _mcp_load_scene("${gdEscape(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar root = _mcp_get_scene_node("${gdEscape(parentPath)}")
\tif root == null:
\t\t_mcp_output("error", "Parent not found: ${gdEscape(parentPath)}")
\t\t_mcp_done()
\t\treturn
\tvar parent = root
\tvar node: Node
${buildBlock}${warningLines}
\t_mcp_output("layout_built", {"parent": "${gdEscape(parentPath)}", "root_type": "${gdEscape(rootType)}", "root_name": "${gdEscape(tree.name)}"})
\t_mcp_done()
`;
}
