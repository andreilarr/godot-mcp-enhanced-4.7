import { describe, it, expect } from 'vitest';
import { parseE2eDsl } from '../../src/tools/workflow.js';

describe('parseE2eDsl', () => {
  it('应翻译 waitFor 调用', () => {
    const result = parseE2eDsl('waitFor("root/Player")');
    expect(result).toEqual({
      method: 'wait_for_node',
      params: { path: 'root/Player' },
    });
  });

  it('应翻译 click 调用', () => {
    const result = parseE2eDsl('click(320, 240)');
    expect(result).toEqual({
      method: 'send_mouse_click',
      params: { x: 320, y: 240, button: 'left', pressed: true },
    });
  });

  it('应翻译 press 调用', () => {
    const result = parseE2eDsl('press("Key_W")');
    expect(result).toEqual({
      method: 'send_key',
      params: { key: 'Key_W', pressed: true },
    });
  });

  it('应翻译 typeText 调用', () => {
    const result = parseE2eDsl('typeText("hello world")');
    expect(result).toEqual({
      method: 'send_text',
      params: { text: 'hello world' },
    });
  });

  it('应翻译 waitMs 调用', () => {
    const result = parseE2eDsl('waitMs(500)');
    expect(result).toEqual({
      method: '_sleep',
      params: { ms: 500 },
    });
  });

  it('对未知 DSL 应返回 null', () => {
    const result = parseE2eDsl('unknownCommand()');
    expect(result).toBeNull();
  });

  it('对空字符串应返回 null', () => {
    const result = parseE2eDsl('');
    expect(result).toBeNull();
  });
});
