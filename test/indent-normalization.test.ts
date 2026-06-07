import { describe, it, expect } from 'vitest';
import { wrapSnippet, wrapSnippetAsNode } from '../src/gdscript-executor.js';

describe('Indentation normalization in wrapSnippet', () => {
  it('converts 4-space indented for-loop body to tabs', () => {
    const code = [
      'var sum = 0',
      'for i in range(1, 11):',
      '    sum += i',
      '_mcp_output("result", str(sum))',
      '_mcp_done()',
    ].join('\n');

    const result = wrapSnippet(code, 'TEST_');
    const initStart = result.indexOf('func _initialize():');
    const initBlock = result.slice(initStart);

    // Every line in _initialize should use only tabs for indentation
    const lines = initBlock.split('\n');
    for (const line of lines) {
      if (line.trim() === '' || line.startsWith('func ')) continue;
      // After stripping leading tabs, the first non-tab char should not be a space
      const afterTabs = line.replace(/^\t*/, '');
      expect(afterTabs[0]).not.toBe(' ');
    }
  });

  it('handles if/else with space indentation', () => {
    const code = [
      'if true:',
      '    _mcp_output("a", "1")',
      'else:',
      '    _mcp_output("b", "2")',
      '_mcp_done()',
    ].join('\n');

    const result = wrapSnippet(code, 'TEST_');
    // Check no leading-space-after-tab patterns in _initialize body
    const initStart = result.indexOf('func _initialize():');
    const initBlock = result.slice(initStart);
    for (const line of initBlock.split('\n')) {
      if (line.trim() === '' || line.startsWith('func ')) continue;
      const afterTabs = line.replace(/^\t*/, '');
      if (afterTabs.length > 0) {
        expect(afterTabs[0]).not.toBe(' ');
      }
    }
  });

  it('handles nested loops with consistent indentation', () => {
    const code = [
      'for i in range(3):',
      '    for j in range(3):',
      '        _mcp_output("cell", str(i) + "," + str(j))',
      '_mcp_done()',
    ].join('\n');

    const result = wrapSnippet(code, 'TEST_');
    const initStart = result.indexOf('func _initialize():');
    const initBlock = result.slice(initStart);

    // The inner _mcp_output should have 3 tabs (1 for init + 1 for outer for + 1 for inner for)
    const innerLine = initBlock.split('\n').find(l => l.includes('"cell"'));
    expect(innerLine).toBeDefined();
    const tabCount = innerLine!.match(/^\t*/)?.[0]!.length ?? 0;
    expect(tabCount).toBe(3);
  });

  it('handles 2-space indentation', () => {
    const code = [
      'for i in range(5):',
      '  _mcp_output("i", str(i))',
      '_mcp_done()',
    ].join('\n');

    const result = wrapSnippet(code, 'TEST_');
    const initStart = result.indexOf('func _initialize():');
    const initBlock = result.slice(initStart);

    const outputLine = initBlock.split('\n').find(l => l.includes('"i"'));
    expect(outputLine).toBeDefined();
    expect(outputLine!.startsWith('\t')).toBe(true);
    const afterTabs = outputLine!.replace(/^\t+/, '');
    expect(afterTabs.startsWith(' ')).toBe(false);
  });

  it('preserves tab-indented code unchanged', () => {
    const code = [
      'for i in range(5):',
      '\t_mcp_output("i", str(i))',
      '_mcp_done()',
    ].join('\n');

    const result = wrapSnippet(code, 'TEST_');
    const initStart = result.indexOf('func _initialize():');
    const initBlock = result.slice(initStart);

    const outputLine = initBlock.split('\n').find(l => l.includes('"i"'));
    expect(outputLine).toBeDefined();
    const tabCount = outputLine!.match(/^\t*/)?.[0]!.length ?? 0;
    expect(tabCount).toBe(2); // init + for body
  });
});

describe('Indentation normalization in wrapSnippetAsNode', () => {
  it('converts space indentation in Node mode', () => {
    const code = [
      'for i in range(3):',
      '    _mcp_output("i", str(i))',
      '_mcp_done()',
    ].join('\n');

    const result = wrapSnippetAsNode(code, 'TEST_');
    const initStart = result.indexOf('func _initialize');
    const initBlock = result.slice(initStart);

    const outputLine = initBlock.split('\n').find(l => l.includes('_mcp_output('));
    expect(outputLine).toBeDefined();
    expect(outputLine!.startsWith('\t')).toBe(true);
    const afterTabs = outputLine!.replace(/^\t+/, '');
    expect(afterTabs.startsWith(' ')).toBe(false);
  });
});

describe('Lambda body stays with declaration in classifyLines', () => {
  it('keeps lambda body in declarationLines, not statementLines', () => {
    const code = [
      'var _fn = func():',
      '\t_mcp_output("hi", "lambda")',
      '_fn.call()',
      '_mcp_done()',
    ].join('\n');

    const result = wrapSnippet(code, 'TEST_');

    // The lambda body should be in the class-level declarations,
    // not mixed into _initialize(). The script should parse cleanly.
    // Verify by checking that _fn.call() is in _initialize body
    // and the lambda _mcp_output is NOT in _initialize body.
    const initStart = result.indexOf('func _initialize():');
    const initBlock = result.slice(initStart);

    // _fn.call() should appear in _initialize body
    expect(initBlock).toContain('_fn.call()');
    // The lambda declaration should be at class level (before _initialize)
    const beforeInit = result.slice(0, initStart);
    expect(beforeInit).toContain('var _fn = func():');
    expect(beforeInit).toContain('_mcp_output("hi", "lambda")');
  });

  it('handles single-line lambda correctly (no body capture)', () => {
    const code = [
      'var _fn = func(): return 42',
      'var x = _fn.call()',
      '_mcp_output("x", str(x))',
      '_mcp_done()',
    ].join('\n');

    const result = wrapSnippet(code, 'TEST_');
    const initStart = result.indexOf('func _initialize():');
    const beforeInit = result.slice(0, initStart);

    // Single-line lambda should be a declaration but no body capture
    expect(beforeInit).toContain('var _fn = func(): return 42');
  });
});
