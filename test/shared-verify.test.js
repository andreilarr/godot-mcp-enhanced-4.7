import { expect } from 'vitest';

describe('shared verify utilities', () => {
  it('wrapAssertionCode is exported', async () => {
    const mod = await import('../src/tools/shared.js');
    expect(typeof mod.wrapAssertionCode).toBe('function');
  });

  it('wrapAssertionCode wraps GDScript assertion code', async () => {
    const mod = await import('../src/tools/shared.js');
    const code = mod.wrapAssertionCode(
      'var _v = 42\n_mcp_output("count", str(_v))',
      'test assertion'
    );
    expect(code.includes('extends SceneTree')).toBeTruthy();
    expect(code.includes('_mcp_output')).toBeTruthy();
    expect(code.includes('var _v = 42')).toBeTruthy();
    expect(code.includes('_mcp_done')).toBeTruthy();
  });

  it('wrapAssertionCode preserves dollar signs in description', async () => {
    const mod = await import('../src/tools/shared.js');
    const code = mod.wrapAssertionCode('_mcp_output("t", "v")', 'test $var');
    // $ is NOT escaped — it has no special meaning in GDScript string literals
    const descLine = code.split('\n').find(l => l.includes('_desc'));
    expect(descLine).toBeTruthy();
    expect(descLine.includes('$var')).toBeTruthy();
  });
});
