// Error handling and result construction utilities.

import type { ExecuteGdscriptResult } from '../../gdscript-executor.js';
import { textResult, errorResult } from '../../types.js';
import type { ToolResult } from '../../types.js';

/** Common error codes shared across tool modules. */
export const COMMON_ERROR_CODES = {
  INVALID_PARAMS: 'INVALID_PARAMS',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
  INVALID_TYPE: 'INVALID_TYPE',
  INVALID_VALUE: 'INVALID_VALUE',
} as const;

export const NON_PERSIST = '运行时操作，仅影响当前执行上下文。如需持久化，请编辑 .tscn 文件。';

export function opsSuccess(data: unknown, warnings: string[] = []) {
  return { success: true, data, warnings };
}

export function opsError(
  errorCode: string,
  message: string,
  opts?: { suggestion?: string },
) {
  return {
    success: false,
    error: message,
    error_code: errorCode,
    warnings: [] as string[],
    ...(opts?.suggestion ? { suggestion: opts.suggestion } : {}),
  };
}

export function opsErrorResult(
  errorCode: string,
  message: string,
  opts?: { suggestion?: string },
): ToolResult {
  return errorResult(JSON.stringify(opsError(errorCode, message, opts)));
}

export function parseGdscriptResult(
  result: ExecuteGdscriptResult,
  paramWarnings: string[] = [],
  errorMapper: (errorMsg: string) => string = () => 'SCRIPT_EXEC_FAILED',
  errorOpts?: { suggestion?: string },
): ToolResult {
  if (!result.compile_success) {
    return opsErrorResult('SCRIPT_EXEC_FAILED', result.compile_error, errorOpts);
  }
  if (!result.run_success) {
    return opsErrorResult('SCRIPT_EXEC_FAILED', result.run_error, errorOpts);
  }

  const data: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const entry of result.outputs) {
    if (entry.key === 'warning') {
      warnings.push(String(entry.value));
    } else if (entry.key === 'error') {
      const errCode = errorMapper(String(entry.value));
      return opsErrorResult(errCode, String(entry.value), errCode === 'NODE_NOT_FOUND' ? errorOpts : undefined);
    } else {
      try {
        data[entry.key] = JSON.parse(entry.value);
      } catch {
        warnings.push(`Output key "${entry.key}" is not valid JSON, stored as raw string`);
        data[entry.key] = entry.value;
      }
    }
  }

  return textResult(JSON.stringify(opsSuccess(data, [...paramWarnings, ...warnings])));
}
