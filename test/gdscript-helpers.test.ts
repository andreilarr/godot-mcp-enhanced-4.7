import { describe, it, expect } from 'vitest';
import { wrapSnippet, wrapSnippetAsNode } from '../src/gdscript-executor.js';
import {
  SCENE_TREE_HEADER,
  GD_MCP_GET_ROOT,
  GD_MCP_GET_NODE,
  GD_MCP_LOAD_MAIN_SCENE,
  GD_MCP_OUTPUT,
} from '../src/tools/shared.js';

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
    expect(result).toContain('func _mcp_get_root');
    expect(result).toContain('func _mcp_done');
    expect(result).toContain('_tree.root');
    expect(result).not.toContain('func _mcp_get_node');
    expect(result).toMatchSnapshot('wrapSnippetAsNode-var-x');
  });

  it('wrapSnippet uses self.root in _mcp_get_root (not Engine.get_main_loop)', () => {
    const result = wrapSnippet('var x = 1');
    expect(result).toContain('self.root');
    // Extract _mcp_get_root function body only — _mcp_done legitimately uses Engine.get_main_loop
    const getRootMatch = result.match(/func _mcp_get_root\(\)[\s\S]*?(?=\nfunc |\nclass_name |\Z)/);
    expect(getRootMatch).not.toBeNull();
    expect(getRootMatch![0]).not.toContain('Engine.get_main_loop');
  });

  it('wrapSnippetAsNode _mcp_done is null-safe for get_tree() (BUG-1 fix)', () => {
    const result = wrapSnippetAsNode('var x = 1');
    // _mcp_done should check get_tree() for null before calling quit()
    const doneMatch = result.match(/func _mcp_done\(\)[\s\S]*?(?=\nfunc |\nvar |\n$)/);
    expect(doneMatch).not.toBeNull();
    const doneBody = doneMatch![0];
    expect(doneBody).toContain('var _tree = get_tree()');
    expect(doneBody).toContain('if _tree != null:');
    expect(doneBody).toContain('_tree.quit(0)');
  });
});

describe('GD_MCP shared constants', () => {
  it('GD_MCP_GET_ROOT contains expected function signature', () => {
    expect(GD_MCP_GET_ROOT).toBeInstanceOf(Array);
    expect(GD_MCP_GET_ROOT[0]).toBe('func _mcp_get_root() -> Node:');
    expect(GD_MCP_GET_ROOT.join('\n')).toContain('self.root');
    expect(GD_MCP_GET_ROOT.join('\n')).not.toContain('Engine.get_main_loop');
  });

  it('GD_MCP_GET_NODE uses precise version (not simplified)', () => {
    expect(GD_MCP_GET_NODE).toBeInstanceOf(Array);
    expect(GD_MCP_GET_NODE[0]).toBe('func _mcp_get_node(path: NodePath) -> Node:');
    const joined = GD_MCP_GET_NODE.join('\n');
    // 精确版特征：单独检查 _part == "root" 且带 _node == _r 条件
    expect(joined).toContain('if _part == "root" and _node == _r:');
    // 简洁版特征不应存在
    expect(joined).not.toContain('or _part == "root"');
  });

  it('GD_MCP_LOAD_MAIN_SCENE contains ProjectSettings call', () => {
    expect(GD_MCP_LOAD_MAIN_SCENE).toBeInstanceOf(Array);
    expect(GD_MCP_LOAD_MAIN_SCENE[0]).toBe('func _mcp_load_main_scene() -> void:');
    expect(GD_MCP_LOAD_MAIN_SCENE.join('\n')).toContain('ProjectSettings.get_setting');
  });

  it('GD_MCP_OUTPUT contains append call', () => {
    expect(GD_MCP_OUTPUT).toBeInstanceOf(Array);
    expect(GD_MCP_OUTPUT.join('\n')).toContain('_mcp_outputs.append');
  });

  it('SCENE_TREE_HEADER uses self.root via _mcp_get_root', () => {
    expect(SCENE_TREE_HEADER).toContain('self.root');
    expect(SCENE_TREE_HEADER).not.toMatch(/\bif root != null:/);
  });
});

describe('SCENE_TREE_HEADER bugfix', () => {
  it('contains var _mcp_outputs declaration', () => {
    expect(SCENE_TREE_HEADER).toContain('var _mcp_outputs: Array = []');
  });

  it('contains func _mcp_output definition', () => {
    expect(SCENE_TREE_HEADER).toContain('func _mcp_output(key: String, value: Variant) -> void:');
    expect(SCENE_TREE_HEADER).toContain('_mcp_outputs.append');
  });

  it('_mcp_output exists and is unique', () => {
    const outputIdx = SCENE_TREE_HEADER.indexOf('func _mcp_output');
    const loadSceneIdx = SCENE_TREE_HEADER.indexOf('func _mcp_load_scene');
    expect(outputIdx).toBeGreaterThan(-1);
    expect(loadSceneIdx).toBeGreaterThan(-1);
    // _mcp_output 定义必须存在且唯一
    expect(SCENE_TREE_HEADER.match(/func _mcp_output/g)).toHaveLength(1);
  });
});

describe('BUG-2: var root naming conflict in wrapSnippet', () => {
  it('renames user var root to avoid SceneTree.root collision', () => {
    const result = wrapSnippet('var root = _mcp_get_root()\nprint(root.name)');
    // 不应在类级别出现裸 "var root ="
    expect(result).not.toMatch(/^var root\s*=/m);
    // 应重命名为 _mcp_user_root
    expect(result).toContain('var _mcp_user_root = _mcp_get_root()');
    // 引用也应更新
    expect(result).toContain('print(_mcp_user_root.name)');
    expect(result).toContain('extends SceneTree');
  });

  it('wrapSnippetAsNode does NOT rename var root (Node has no root prop)', () => {
    const result = wrapSnippetAsNode('var root = _mcp_get_root()\nprint(root.name)');
    expect(result).toContain('extends Node');
    // Node 没有 root 属性，var root 安全
    expect(result).toContain('var root = _mcp_get_root()');
  });

  it('does not rename non-conflicting variables like root_node', () => {
    const result = wrapSnippet('var my_data = 42\nvar root_node = _mcp_get_root()\nprint(str(my_data))');
    expect(result).toContain('var my_data = 42');
    expect(result).toContain('var root_node = _mcp_get_root()');
  });
});
