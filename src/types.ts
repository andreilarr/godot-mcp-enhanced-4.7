import type { ChildProcess } from 'child_process';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// ─── Shared type definitions for tool handlers ─────────────────────────────

export type ToolResult = CallToolResult;

export interface ToolContext {
  opsScript: string;
  findGodot: () => Promise<string>;
  runningProcess: ChildProcess | null;
  setRunningProcess: (proc: ChildProcess | null) => void;
  outputBuffer: string[];
  setOutputBuffer: (buf: string[]) => void;
  processStartTime: number;
  setProcessStartTime: (t: number) => void;
  projectDir: string;
  setProjectDir: (d: string) => void;
  parseGodotConfig: (content: string) => Record<string, unknown>;
}

// Helper to create a text result
export function textResult(s: string): ToolResult {
  return { content: [{ type: 'text', text: s }] };
}

// Helper to create an error result (signals failure to MCP clients)
export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Safely extract a message string from an unknown thrown value. */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

// ─── Middleware types (competitive borrowing Phase 5) ──────────────────────────

export type ConnectionState = 'disconnected' | 'connected' | 'degraded' | 'reconnecting';

export interface DispatchContext {
  toolName: string;
  args: Record<string, unknown>;
  startTime: number;
  phase: 'before' | 'after';
}

export type MiddlewareResult =
  | { passed: true }
  | { rejected: true; error: ToolResult };

export interface Middleware {
  name: string;
  before(ctx: DispatchContext): Promise<MiddlewareResult>;
  after?(ctx: DispatchContext, result: ToolResult): Promise<ToolResult>;
}

/** Delegate for proxy tool to re-dispatch through the full middleware chain. */
export type ToolCallDelegate = (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;
