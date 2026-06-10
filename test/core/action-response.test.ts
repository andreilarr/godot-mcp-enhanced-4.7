import { describe, it, expect } from 'vitest';
import type { ActionResult } from '../../src/core/action-response.js';
import { wrapResult, toToolResult, actionError } from '../../src/core/action-response.js';
import { ErrorCodes } from '../../src/core/error-codes.js';

describe('action-response', () => {
  describe('wrapResult', () => {
    it('将旧式 ToolResult (成功) 包装为 ActionResult', () => {
      const toolResult = {
        content: [{ type: 'text' as const, text: '{"status":"ok","data":{}}' }],
      };
      const result = wrapResult('scene', 'read_scene', toolResult);
      expect(result.tool).toBe('scene');
      expect(result.action).toBe('read_scene');
      expect(result.status).toBe('ok');
    });

    it('将旧式 ToolResult (错误) 包装为 ActionResult', () => {
      const toolResult = {
        isError: true,
        content: [{ type: 'text' as const, text: 'Something went wrong' }],
      };
      const result = wrapResult('scene', 'add_node', toolResult);
      expect(result.status).toBe('error');
      expect(result.error?.code).toBe(ErrorCodes.HANDLER_ERROR);
    });

    it('保留已有 ActionResult 的 tool/action', () => {
      const existing: ActionResult = {
        tool: 'old_tool',
        action: 'old_action',
        status: 'ok',
        data: { foo: 'bar' },
      };
      const result = wrapResult('new_tool', 'new_action', existing);
      expect(result.tool).toBe('new_tool');
      expect(result.action).toBe('new_action');
      expect(result.status).toBe('ok');
      expect(result.data).toEqual({ foo: 'bar' });
    });
  });

  describe('toToolResult', () => {
    it('将成功的 ActionResult 转为 MCP ToolResult', () => {
      const action: ActionResult = {
        tool: 'scene', action: 'read_scene', status: 'ok', data: { nodes: [] },
      };
      const result = toToolResult(action);
      expect(result.isError).toBeFalsy();
      expect(result.content[0].type).toBe('text');
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.tool).toBe('scene');
      expect(parsed.action).toBe('read_scene');
    });

    it('将错误的 ActionResult 转为 isError=true 的 ToolResult', () => {
      const action: ActionResult = {
        tool: 'scene', action: 'add_node', status: 'error',
        error: { code: 'MISSING_REQUIRED_PARAM', message: 'Missing node_type', missing_params: ['node_type'] },
      };
      const result = toToolResult(action);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.error.missing_params).toEqual(['node_type']);
    });
  });

  describe('actionError', () => {
    it('快速创建错误 ActionResult', () => {
      const result = actionError('scene', 'add_node', ErrorCodes.MISSING_REQUIRED_PARAM, 'Missing node_type', ['node_type']);
      expect(result.status).toBe('error');
      expect(result.tool).toBe('scene');
      expect(result.action).toBe('add_node');
      expect(result.error?.code).toBe(ErrorCodes.MISSING_REQUIRED_PARAM);
      expect(result.error?.missing_params).toEqual(['node_type']);
    });
  });
});