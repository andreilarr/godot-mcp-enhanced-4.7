import { ErrorCodes } from './error-codes.js';
import type { ToolResult } from '../types.js';

/** 统一 Action 响应格式，包含 tool + action 用于调试追溯。 */
export interface ActionResult {
  tool: string;
  action: string;
  status: 'ok' | 'error';
  data?: unknown;
  error?: {
    code: string;
    message: string;
    missing_params?: string[];
  };
}

/** 判断对象是否已是 ActionResult 格式 */
function isActionResult(obj: unknown): obj is ActionResult {
  if (!obj || typeof obj !== 'object') return false;
  const r = obj as Record<string, unknown>;
  return typeof r.tool === 'string' && typeof r.action === 'string' && (r.status === 'ok' || r.status === 'error');
}

/** 从 ToolResult 的 content 中提取文本 */
function extractText(result: ToolResult): string {
  for (const c of result.content) {
    if (c.type === 'text' && typeof c.text === 'string') return c.text;
  }
  return '';
}

/** 包装任意返回值为 ActionResult */
export function wrapResult(tool: string, action: string, result: unknown): ActionResult {
  if (isActionResult(result)) {
    return { ...result, tool, action };
  }

  // 旧式 ToolResult
  if (result && typeof result === 'object' && 'content' in result) {
    const tr = result as ToolResult;
    const isError = tr.isError === true;
    return {
      tool, action,
      status: isError ? 'error' : 'ok',
      ...(isError
        ? { error: { code: ErrorCodes.HANDLER_ERROR, message: extractText(tr) } }
        : { data: extractText(tr) }),
    };
  }

  return { tool, action, status: 'ok', data: result };
}

/** 将 ActionResult 转回 MCP ToolResult */
export function toToolResult(result: ActionResult): ToolResult {
  const text = JSON.stringify(result, null, 2);
  return {
    isError: result.status === 'error',
    content: [{ type: 'text', text }],
  };
}

/** 快速创建错误 ActionResult */
export function actionError(
  tool: string, action: string, code: string, message: string, missingParams?: string[],
): ActionResult {
  return {
    tool, action, status: 'error',
    error: { code, message, ...(missingParams ? { missing_params: missingParams } : {}) },
  };
}