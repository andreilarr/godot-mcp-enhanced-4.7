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

  // ── Validation failure tests ──

  it('waitFor: 无效路径应返回 _error', () => {
    const result = parseE2eDsl('waitFor("abc")');
    expect(result?.method).toBe('_error');
    expect((result?.params as Record<string, unknown>)?.message).toContain('waitFor');
  });

  it('waitFor: 带连字符和点号的路径应通过', () => {
    const result = parseE2eDsl('waitFor("root/UI-Panel/node.v2")');
    expect(result?.method).toBe('wait_for_node');
  });

  it('click: 坐标越界应返回 _error', () => {
    const r1 = parseE2eDsl('click(-1, 100)');
    expect(r1?.method).toBe('_error');

    const r2 = parseE2eDsl('click(100, 10001)');
    expect(r2?.method).toBe('_error');
  });

  it('click: 边界值 0 和 10000 应通过', () => {
    const r1 = parseE2eDsl('click(0, 0)');
    expect(r1?.method).toBe('send_mouse_click');

    const r2 = parseE2eDsl('click(10000, 10000)');
    expect(r2?.method).toBe('send_mouse_click');
  });

  it('press: 非法键名应返回 _error', () => {
    const result = parseE2eDsl('press("Key<Script>")');
    expect(result?.method).toBe('_error');
  });

  it('press: 空键名应返回 _error', () => {
    const result = parseE2eDsl('press("")');
    expect(result?.method).toBe('_error');
  });

  it('typeText: 控制字符应返回 _error', () => {
    const result = parseE2eDsl('typeText("hello\x00world")');
    expect(result?.method).toBe('_error');
  });

  it('typeText: 空字符串应通过', () => {
    const result = parseE2eDsl('typeText("")');
    expect(result?.method).toBe('send_text');
    expect((result?.params as Record<string, unknown>)?.text).toBe('');
  });

  it('waitMs: 越界应返回 _error', () => {
    const r1 = parseE2eDsl('waitMs(999999)');
    expect(r1?.method).toBe('_error');

    const r2 = parseE2eDsl('waitMs(-1)');
    expect(r2).toBeNull(); // -1 doesn't match \d+ regex, so null
  });

  it('waitMs: 边界值 0 和 60000 应通过', () => {
    const r1 = parseE2eDsl('waitMs(0)');
    expect(r1?.method).toBe('_sleep');

    const r2 = parseE2eDsl('waitMs(60000)');
    expect(r2?.method).toBe('_sleep');
  });

  // ── Integration: _error in DSL context ──

  it('含 _error 的行不应被识别为合法 DSL', () => {
    const codeLines = ['waitFor("invalid")', 'click(100, 200)'];
    const cmds = codeLines.map(l => parseE2eDsl(l));
    const allDsl = codeLines.length > 0 && cmds.every(c => c !== null && c.method !== '_error');
    expect(allDsl).toBe(false);
    expect(cmds[0]?.method).toBe('_error');
    expect(cmds[1]?.method).toBe('send_mouse_click');
  });

  it('全合法 DSL 应被识别为 allDsl=true', () => {
    const codeLines = ['waitFor("root/Player")', 'click(100, 200)', 'waitMs(500)'];
    const cmds = codeLines.map(l => parseE2eDsl(l));
    const allDsl = codeLines.length > 0 && cmds.every(c => c !== null && c.method !== '_error');
    expect(allDsl).toBe(true);
  });

  it('混合合法与非法行：非法行返回 _error，合法行正常', () => {
    const lines = ['press("Key_W")', 'waitFor("no-root")', 'typeText("ok")'];
    const cmds = lines.map(l => parseE2eDsl(l));
    expect(cmds[0]?.method).toBe('send_key');
    expect(cmds[1]?.method).toBe('_error');
    expect(cmds[2]?.method).toBe('send_text');
  });
});
