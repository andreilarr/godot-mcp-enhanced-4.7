// src/core/middleware.ts
//
// Middleware pipeline executor and connection-check middleware factory.

import { getLogger } from './logger.js';
import { errorResult } from '../types.js';
import type { DispatchContext, Middleware, MiddlewareResult, ToolResult } from '../types.js';
import { isFeatureEnabled } from './feature-flags.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

// ─── Pipeline Executor ────────────────────────────────────────────────────────

/**
 * Execute a tool call through the middleware pipeline.
 *
 * 1. Run each mw.before(ctx) in order. First rejection stops the before-chain.
 * 2. If all before hooks pass, call executeTool(). If rejected, skip executeTool.
 * 3. Run ALL mw.after(ctx, result) hooks — even if before was rejected.
 *    Each after hook can modify result. After hooks that throw are caught silently.
 */
export async function executeMiddleware(
  middleware: Middleware[],
  ctx: DispatchContext,
  executeTool: () => Promise<ToolResult>,
): Promise<ToolResult> {
  let result: ToolResult = errorResult('No middleware result');
  let rejected = false;

  // ── Phase 1: Before hooks ───────────────────────────────────────────────────
  for (const mw of middleware) {
    try {
      const beforeResult: MiddlewareResult = await mw.before(ctx);
      if ('rejected' in beforeResult && beforeResult.rejected) {
        getLogger().info('middleware', `Rejected by "${mw.name}": tool=${ctx.toolName}`);
        result = beforeResult.error;
        rejected = true;
        break;
      }
    } catch (err) {
      getLogger().error('middleware', `Before hook "${mw.name}" threw: ${err}`);
      result = errorResult(`Middleware "${mw.name}" error: ${err instanceof Error ? err.message : String(err)}`);
      rejected = true;
      break;
    }
  }

  // ── Phase 2: Execute tool ──────────────────────────────────────────────────
  if (!rejected) {
    try {
      result = await executeTool();
    } catch (err) {
      // Log full exception (including stack trace) so crashes are diagnosable
      getLogger().error('middleware', `Tool execution threw: ${err instanceof Error ? err.stack : String(err)}`);
      result = errorResult(`Tool execution error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Phase 3: After hooks (always run) ──────────────────────────────────────
  for (const mw of middleware) {
    if (mw.after) {
      try {
        result = await mw.after(ctx, result);
      } catch {
        // After hooks must not crash the pipeline — silently catch
        getLogger().warn('middleware', `After hook "${mw.name}" threw, ignoring`);
      }
    }
  }

  return result!;
}

// ─── Connection Check Middleware Factory ───────────────────────────────────────

/**
 * Create a middleware that rejects online-only tools when disconnected.
 *
 * @param isConnected  - Function returning true if the connection is alive
 * @param isOfflineCapable - Function returning true if a tool can run without connection
 */
export function createConnectionCheckMiddleware(
  isConnected: () => boolean,
  isOfflineCapable: (toolName: string) => boolean,
): Middleware {
  return {
    name: 'connection-check',

    async before(ctx: DispatchContext): Promise<MiddlewareResult> {
      if (!isConnected() && !isOfflineCapable(ctx.toolName)) {
        return {
          rejected: true,
          error: errorResult(
            `DISCONNECTED: Tool "${ctx.toolName}" requires an active connection. ` +
            `Check that the game/editor is running and try again.`,
          ),
        };
      }
      return { passed: true };
    },
  };
}

// ─── Elicitation Middleware Factory ────────────────────────────────────────────

/**
 * Create an elicitation middleware.
 * Checks required params vs provided args. If missing and client supports
 * elicitation, asks the client. Otherwise returns MISSING_PARAM error.
 * Only prompts for primitive types (string/number/boolean/enum).
 */
export function createElicitationMiddleware(
  getToolDef: (name: string) => Tool | null,
  elicitFn: ((params: string[]) => Promise<Record<string, string> | null>) | null,
): Middleware {
  return {
    name: 'elicitation',

    before: async (ctx) => {
      if (!isFeatureEnabled('ELICITATION')) return { passed: true };

      const def = getToolDef(ctx.toolName);
      if (!def?.inputSchema) return { passed: true };


      // Shallow-copy args to avoid mutating caller's object
      const safeArgs = { ...ctx.args };
      ctx.args = safeArgs;
      const schema = def.inputSchema as {
          required?: string[];
          properties?: Record<string, { type?: string; [key: string]: unknown }>;
          [key: string]: unknown;
        };
      const required: string[] = schema.required ?? [];
      if (required.length === 0) return { passed: true };

      const missing = required.filter(name => {
        const val = safeArgs[name];
        return val === undefined || val === null || val === '';
      });
      if (missing.length === 0) return { passed: true };

      const props = schema.properties ?? {};
      // Note: enum-typed params (type:'string' + enum:[...]) are already covered by this
      // check since their base type is 'string'. However, oneOf/anyOf compound types are
      // NOT supported — elicitation skips them to avoid complex schema resolution.
      const primitiveMissing = missing.filter(name => {
        const prop = props[name];
        if (!prop) return false;
        const type = prop.type;
        return type === 'string' || type === 'number' || type === 'boolean';
      });
      if (primitiveMissing.length === 0) {
        // F-14: 到此处 missing.length > 0(第140行保证)但全是非 primitive(无 type/联合类型),
        // 无法 elicit 也不能绕过必需校验——直接报错(当前 common-schemas 字段都有 type,此分支不可达,防御性)
        return {
          rejected: true,
          error: {
            content: [{ type: 'text' as const, text: JSON.stringify({
              success: false,
              error: `Missing required parameter(s): ${missing.join(', ')}`,
              error_code: 'MISSING_PARAM',
              missing_params: missing,
            }) }],
          },
        };
      }

      if (elicitFn) {
        const elicited = await elicitFn(primitiveMissing);
        if (elicited) {
          for (const [key, val] of Object.entries(elicited)) {
            if (primitiveMissing.includes(key) && !(key in safeArgs)) safeArgs[key] = val;
          }
          return { passed: true };
        }
      }

      return {
        rejected: true,
        error: {
          content: [{ type: 'text' as const, text: JSON.stringify({
            success: false,
            error: `Missing required parameter(s): ${primitiveMissing.join(', ')}`,
            error_code: 'MISSING_PARAM',
            missing_params: primitiveMissing,
          }) }],
        },
      };
    },
  };
}
