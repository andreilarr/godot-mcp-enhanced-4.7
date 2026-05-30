import { describe, it, expect } from 'vitest';
import { wrapSnippet, wrapSnippetAsNode } from '../src/gdscript-executor.js';

describe('GDScript helpers - baseline snapshots', () => {
  it('wrapSnippet("var x = 1") baseline', () => {
    const result = wrapSnippet('var x = 1');
    expect(result).toContain('extends SceneTree');
    expect(result).toContain('func _mcp_get_root');
    expect(result).toContain('func _mcp_get_node');
    expect(result).toContain('func _mcp_load_main_scene');
    expect(result).toContain('func _mcp_output');
    expect(result).toContain('var _mcp_outputs');
    expect(result).toContain('var x = 1');
    expect(result).toMatchSnapshot('wrapSnippet-var-x');
  });

  it('wrapSnippet with func declaration baseline', () => {
    const result = wrapSnippet('func my_func():\n\treturn 42\nvar result = my_func()');
    expect(result).toMatchSnapshot('wrapSnippet-func-decl');
  });

  it('wrapSnippetAsNode("var x = 1") baseline', () => {
    const result = wrapSnippetAsNode('var x = 1');
    expect(result).toContain('extends Node');
    expect(result).toContain('func _mcp_output');
    expect(result).toContain('var _mcp_outputs');
    expect(result).not.toContain('func _mcp_get_root');
    expect(result).not.toContain('func _mcp_get_node');
    expect(result).toMatchSnapshot('wrapSnippetAsNode-var-x');
  });
});
