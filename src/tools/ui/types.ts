// UI tool constants, types, and shared helpers.

import { gdEscape, valueToGd } from '../shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

export const ACTIONS = [
  'ui_create_control',
  'ui_set_layout',
  'ui_get_layout',
  'ui_anchor_preset',
  'ui_set_theme',
  'ui_container_add',
  'ui_draw_recipe',
  'ui_build_layout',
  'theme_create',
  'theme_set_property',
] as const;

export const CONTROL_TYPES = [
  'Button', 'Label', 'Panel', 'LineEdit', 'TextEdit', 'RichTextLabel',
  'LinkButton', 'HSlider', 'VSlider', 'CheckBox', 'CheckButton',
  'OptionButton', 'SpinBox', 'ProgressBar', 'TextureRect',
  'ColorPickerButton', 'TabContainer', 'Tree', 'ItemList',
  'MarginContainer', 'HBoxContainer', 'VBoxContainer', 'GridContainer',
  'CenterContainer', 'ScrollContainer', 'PanelContainer',
  'HSplitContainer', 'VSplitContainer', 'NinePatchRect',
] as const;

export const ANCHOR_PRESETS: Record<string, number> = {
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

export const ERROR_CODES = {
  INVALID_CONTROL_TYPE: 'INVALID_CONTROL_TYPE',
  INVALID_ANCHOR_PRESET: 'INVALID_ANCHOR_PRESET',
  INVALID_PARAMS: 'INVALID_PARAMS',
  INVALID_DRAW_OP: 'INVALID_DRAW_OP',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
  THEME_NOT_FOUND: 'THEME_NOT_FOUND',
  INVALID_THEME_PROPERTY: 'INVALID_THEME_PROPERTY',
  INVALID_THEME_ITEM_TYPE: 'INVALID_THEME_ITEM_TYPE',
} as const;

export const DRAW_OP_KINDS = ['rect', 'circle', 'line', 'arc', 'polygon', 'polyline', 'string'] as const;

// ─── Types ──────────────────────────────────────────────────────────────────

export type DrawOp = { kind: string; [key: string]: unknown };

export interface FlexLayout {
  direction: 'row' | 'column' | 'row-reverse' | 'column-reverse' | 'grid';
  justify?: 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly';
  align?: 'stretch' | 'flex-start' | 'center' | 'flex-end';
  wrap?: 'nowrap' | 'wrap';
  gap?: number;
  row_gap?: number;
  padding?: number | [number, number, number, number];
  columns?: number;
}

export interface FlexChild {
  grow?: number;
  shrink?: number;
  align_self?: 'auto' | 'flex-start' | 'center' | 'flex-end' | 'stretch';
  min_width?: number;
  min_height?: number;
  max_width?: number;
  max_height?: number;
}

export type UiNodeSpec = {
  type: string;
  name: string;
  properties?: Record<string, unknown>;
  anchor_preset?: string;
  layout?: FlexLayout;
  flex?: FlexChild;
  children?: UiNodeSpec[];
};

// ─── Helpers ───────────────────────────────────────────────────────────────

export function genPropertyLines(properties: Record<string, unknown>): string {
  let lines = '';
  for (const [key, value] of Object.entries(properties)) {
    lines += `\n\tnode.set("${gdEscape(key)}", ${valueToGd(value)})`;
  }
  return lines;
}

/** Convert a color value ([r,g,b] or [r,g,b,a]) to a GDScript Color() expression. */
export function colorToGd(c: unknown): string {
  if (Array.isArray(c) && (c.length === 3 || c.length === 4)) {
    return valueToGd(c.length === 3 ? [c[0], c[1], c[2], 1] : c) as string;
  }
  return valueToGd(c ?? [1, 1, 1, 1]);
}
