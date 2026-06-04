/** 统一导出所有客户端适配器 + ALL_ADAPTERS 列表 */
import type { ClientAdapter } from './types.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CursorAdapter } from './cursor.js';
import { OpenCodeAdapter } from './opencode.js';
import { CodexAdapter } from './codex.js';

export type { ClientAdapter } from './types.js';
export { ClaudeCodeAdapter, CursorAdapter, OpenCodeAdapter, CodexAdapter };

export const ALL_ADAPTERS: ClientAdapter[] = [
  new ClaudeCodeAdapter(),
  new CursorAdapter(),
  new OpenCodeAdapter(),
  new CodexAdapter(),
];
