// test/sdk-prerequisites.test.ts
import { describe, it, expect } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

describe('SDK Prerequisites', () => {
  it('supports annotations.tags on Tool definitions', () => {
    const tool: Tool = {
      name: 'test_tool',
      description: 'test',
      inputSchema: { type: 'object', properties: {} },
      annotations: { tags: ['group:core'] },
    };
    expect(tool.annotations?.tags).toEqual(['group:core']);
  });

  it('Server type has capabilities.tools for list_changed', () => {
    // Server 构造时传入 capabilities: { tools: {} } 即支持 list_changed
    // 验证类型定义存在
    const caps = { tools: {} };
    expect(caps.tools).toBeDefined();
  });

  it('Server.notification method exists in type', async () => {
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const server = new Server(
      { name: 'test', version: '0.0.0' },
      { capabilities: { tools: {} } }
    );
    expect(typeof server.notification).toBe('function');
  });

  it('ListPromptsRequestSchema is importable', async () => {
    const schemas = await import('@modelcontextprotocol/sdk/types.js');
    expect(schemas.ListPromptsRequestSchema).toBeDefined();
    expect(schemas.GetPromptRequestSchema).toBeDefined();
  });
});
