// src/core/ReadOnlyGuard.ts
// A-07: deny-by-default — unknown tools are blocked in readOnly mode.
// Registration order safety: GodotServer constructor calls registerModule() for all tool
// modules BEFORE creating the ReadOnlyGuard instance, so all tools are registered by the
// time guard.check() is first called. This is enforced by the constructor sequence.
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
