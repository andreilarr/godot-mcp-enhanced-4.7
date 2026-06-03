/**
 * Themes — Dashboard 颜色主题常量集中管理。
 * 所有颜色定义在一处，方便全局调整。
 */

/** 日志级别颜色映射 */
export const LEVEL_COLORS: Record<string, string> = {
  debug: 'gray',
  info: 'white',
  warn: 'yellow',
  error: 'red',
};

/** 日志级别前缀文本 */
export const LEVEL_PREFIX: Record<string, string> = {
  debug: '[dbg]',
  info: '',
  warn: 'WARN',
  error: 'ERROR',
};

/** 模块颜色映射 */
export const MODULE_COLORS: Record<string, string> = {
  dispatcher: 'cyan',
  gdscript: 'green',
  runtime: 'blue',
  bridge: 'magenta',
  security: 'red',
  validation: 'yellow',
  auth: 'yellow',
  editor: 'cyan',
  helpers: 'gray',
  'godot-mcp': 'white',
  logger: 'gray',
};

/** 状态指示符 */
export const STATUS = {
  connected: '●',
  disconnected: '○',
  paused: '❚❚',
} as const;

/** sparkline 标签颜色 */
export const SPARKLINE_COLORS = {
  calls: 'green',
  errors: 'red',
  latency: 'cyan',
} as const;

/** 面板边框颜色 */
export const BORDER_COLOR = 'gray';

/** 快捷键栏颜色 */
export const KEYBIND_COLOR = 'gray';
