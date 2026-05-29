// src/core/ReadOnlyGuard.ts
import { isReadOnly, isKnownTool } from './tool-registry.js';

export interface GuardResult {
  blocked: boolean;
  errorCode?: number;
  message?: string;
}

export class ReadOnlyGuard {
  constructor(private readonly enabled: boolean) {}

  check(toolName: string): GuardResult {
    if (!this.enabled) return { blocked: false };
    // I-08: deny-by-default — unknown tools are blocked in readOnly mode
    if (!isKnownTool(toolName)) {
      return {
        blocked: true,
        errorCode: -32001,
        message: `Operation blocked: unknown tool "${toolName}" denied in read-only mode`,
      };
    }
    if (isReadOnly(toolName)) return { blocked: false };

    return {
      blocked: true,
      errorCode: -32001,
      message: 'Operation blocked: read-only mode enabled (GODOT_MCP_READ_ONLY=true)',
    };
  }
}
