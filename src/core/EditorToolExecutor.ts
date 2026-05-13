// src/core/EditorToolExecutor.ts
import type { EditorConnection } from './EditorConnection.js';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export class EditorToolExecutor {
  constructor(private readonly conn: EditorConnection) {}

  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const result = await this.conn.request(toolName, args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  }
}
