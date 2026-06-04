/**
 * Themes — Dashboard ANSI 颜色主题常量集中管理。
 * 使用 ANSI 256 色索引，零依赖渲染。
 */

// ─── ANSI helpers ──────────────────────────────────────────────────────────────

const ESC = '\x1b[';

/** 设置 256 色前景色 */
export function fg(index: number): string {
  return `${ESC}38;5;${index}m`;
}

/** 设置 256 色背景色 */
export function bg(index: number): string {
  return `${ESC}48;5;${index}m`;
}

/** 加粗 */
export function bold(): string {
  return `${ESC}1m`;
}

/** 暗淡 */
export function dim(): string {
  return `${ESC}2m`;
}

/** 重置所有属性 */
export function reset(): string {
  return `${ESC}0m`;
}

/** 便利函数：给文本上色并自动 reset */
export function colorize(text: string, colorIndex: number): string {
  return `${fg(colorIndex)}${text}${reset()}`;
}

// ─── 颜色常量（ANSI 256 色索引）────────────────────────────────────────────────

/** 日志级别颜色映射 */
export const LEVEL_COLORS: Record<string, number> = {
  debug: 245,    // gray
  info:  252,    // bright white
  warn:  220,    // yellow
  error: 196,    // bright red
};

/** 日志级别前缀文本 */
export const LEVEL_PREFIX: Record<string, string> = {
  debug: '[dbg]',
  info: '',
  warn: 'WARN',
  error: 'ERROR',
};

/** 模块颜色映射 */
export const MODULE_COLORS: Record<string, number> = {
  dispatcher: 51,     // cyan
  gdscript:  82,      // green
  runtime:   69,      // blue
  bridge:    201,     // magenta
  security:  196,     // red
  validation: 220,    // yellow
  auth:      220,     // yellow
  editor:    51,      // cyan
  helpers:   245,     // gray
  'godot-mcp': 252,   // white
  logger:    245,     // gray
};

/** 状态指示符 */
export const STATUS = {
  connected: '●',
  disconnected: '○',
  paused: '❚❚',
} as const;

/** sparkline 标签颜色 */
export const SPARKLINE_COLORS = {
  calls: 82,    // green
  errors: 196,  // red
  latency: 51,  // cyan
} as const;

/** 面板边框颜色 */
export const BORDER_COLOR = 245;  // gray

/** 快捷键栏颜色 */
export const KEYBIND_COLOR = 245; // gray

/** 运行模式颜色 */
export const MODE_COLORS: Record<string, number> = {
  editor: 51,   // cyan
  bridge: 201,  // magenta
  headless: 82, // green
  unknown: 252, // white
};
