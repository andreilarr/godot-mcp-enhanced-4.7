import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_NAMES,
  getToolDefinitions,
  genUiCreateControlScript,
  genUiSetLayoutScript,
  genUiGetLayoutScript,
  genUiAnchorPresetScript,
} from '../build/tools/ui-tools.js';

// ─── TOOL_NAMES ─────────────────────────────────────────────────────────────

describe('TOOL_NAMES', () => {
  it('contains exactly 4 UI tool names', () => {
    assert.strictEqual(TOOL_NAMES.length, 4);
  });
  it('includes ui_create_control', () => {
    assert.ok(TOOL_NAMES.includes('ui_create_control'));
  });
  it('includes ui_set_layout', () => {
    assert.ok(TOOL_NAMES.includes('ui_set_layout'));
  });
  it('includes ui_get_layout', () => {
    assert.ok(TOOL_NAMES.includes('ui_get_layout'));
  });
  it('includes ui_anchor_preset', () => {
    assert.ok(TOOL_NAMES.includes('ui_anchor_preset'));
  });
});

// ─── genUiCreateControlScript ───────────────────────────────────────────────

describe('genUiCreateControlScript', () => {
  it('generates GDScript that creates a Control node', () => {
    const script = genUiCreateControlScript('/path/to/scene.tscn', 'Button', 'MyButton', '/root');
    assert.ok(script.includes('Button.new()'));
    assert.ok(script.includes('node.name = "MyButton"'));
    assert.ok(script.includes('parent.add_child(node)'));
    assert.ok(script.includes('_mcp_load_scene'));
    assert.ok(script.includes('_mcp_get_scene_node'));
    assert.ok(script.includes('_mcp_output("created"'));
  });

  it('includes property assignments when provided', () => {
    const props = { text: 'Click Me', disabled: true, size: 42 };
    const script = genUiCreateControlScript('/scene.tscn', 'Label', 'Lbl', '/root', props);
    assert.ok(script.includes('node.set("text", "Click Me")'));
    assert.ok(script.includes('node.set("disabled", true)'));
    assert.ok(script.includes('node.set("size", 42)'));
  });

  it('handles null property value', () => {
    const props = { icon: null };
    const script = genUiCreateControlScript('/scene.tscn', 'Button', 'Btn', '/root', props);
    assert.ok(script.includes('node.set("icon", null)'));
  });

  it('escapes special characters in strings', () => {
    const props = { text: 'Hello "World"' };
    const script = genUiCreateControlScript('/scene.tscn', 'Label', 'Lbl', '/root', props);
    assert.ok(script.includes('node.set("text", "Hello \\"World\\"")'));
  });

  it('uses provided parent path', () => {
    const script = genUiCreateControlScript('/scene.tscn', 'Panel', 'MyPanel', '/root/UI');
    assert.ok(script.includes('_mcp_get_scene_node("/root/UI")'));
  });
});

// ─── genUiSetLayoutScript ───────────────────────────────────────────────────

describe('genUiSetLayoutScript', () => {
  it('generates GDScript that checks Control type', () => {
    const script = genUiSetLayoutScript('/scene.tscn', '/root/UI/Panel');
    assert.ok(script.includes('if not node is Control:'));
    assert.ok(script.includes('_mcp_output("layout_set"'));
  });

  it('includes anchor settings', () => {
    const anchors = { left: 0, right: 1, top: 0, bottom: 1 };
    const script = genUiSetLayoutScript('/scene.tscn', '/root/Panel', anchors);
    assert.ok(script.includes('node.anchor_left = 0'));
    assert.ok(script.includes('node.anchor_right = 1'));
    assert.ok(script.includes('node.anchor_top = 0'));
    assert.ok(script.includes('node.anchor_bottom = 1'));
  });

  it('includes offset settings', () => {
    const offsets = { left: 10, right: -10, top: 5, bottom: -5 };
    const script = genUiSetLayoutScript('/scene.tscn', '/root/Panel', undefined, offsets);
    assert.ok(script.includes('node.offset_left = 10'));
    assert.ok(script.includes('node.offset_right = -10'));
    assert.ok(script.includes('node.offset_top = 5'));
    assert.ok(script.includes('node.offset_bottom = -5'));
  });

  it('includes min_size settings', () => {
    const minSize = { x: 100, y: 50 };
    const script = genUiSetLayoutScript('/scene.tscn', '/root/Panel', undefined, undefined, minSize);
    assert.ok(script.includes('custom_minimum_size'));
    assert.ok(script.includes('100'));
    assert.ok(script.includes('50'));
  });

  it('includes custom_minimum_size settings', () => {
    const customMinSize = { x: 200, y: 100 };
    const script = genUiSetLayoutScript('/scene.tscn', '/root/Panel', undefined, undefined, undefined, customMinSize);
    assert.ok(script.includes('node.custom_minimum_size = Vector2(200, 100)'));
  });

  it('includes grow_direction', () => {
    const script = genUiSetLayoutScript('/scene.tscn', '/root/Panel', undefined, undefined, undefined, undefined, 'both');
    assert.ok(script.includes('Control.GROW_DIRECTION_BOTH'));
  });

  it('generates minimal script with no optional params', () => {
    const script = genUiSetLayoutScript('/scene.tscn', '/root/Panel');
    assert.ok(script.includes('_mcp_load_scene'));
    assert.ok(script.includes('_mcp_get_scene_node("/root/Panel")'));
    assert.ok(script.includes('if not node is Control:'));
  });
});

// ─── genUiGetLayoutScript ───────────────────────────────────────────────────

describe('genUiGetLayoutScript', () => {
  it('generates GDScript that reads layout properties', () => {
    const script = genUiGetLayoutScript('/scene.tscn', '/root/UI/Button');
    assert.ok(script.includes('node.anchor_left'));
    assert.ok(script.includes('node.anchor_right'));
    assert.ok(script.includes('node.anchor_top'));
    assert.ok(script.includes('node.anchor_bottom'));
    assert.ok(script.includes('node.offset_left'));
    assert.ok(script.includes('node.offset_right'));
    assert.ok(script.includes('node.offset_top'));
    assert.ok(script.includes('node.offset_bottom'));
    assert.ok(script.includes('node.global_position'));
    assert.ok(script.includes('node.size'));
    assert.ok(script.includes('_mcp_output("layout"'));
  });

  it('checks Control type', () => {
    const script = genUiGetLayoutScript('/scene.tscn', '/root/Button');
    assert.ok(script.includes('if not node is Control:'));
  });
});

// ─── genUiAnchorPresetScript ────────────────────────────────────────────────

describe('genUiAnchorPresetScript', () => {
  it('generates GDScript that calls set_anchors_preset', () => {
    const script = genUiAnchorPresetScript('/scene.tscn', '/root/Panel', 15, 'full_rect');
    assert.ok(script.includes('node.set_anchors_preset(15)'));
    assert.ok(script.includes('_mcp_output("preset_applied"'));
    assert.ok(script.includes('"preset": "full_rect"'));
    assert.ok(script.includes('"value": 15'));
  });

  it('checks Control type', () => {
    const script = genUiAnchorPresetScript('/scene.tscn', '/root/Label', 0, 'top_left');
    assert.ok(script.includes('if not node is Control:'));
  });

  it('uses correct preset value for top_left (0)', () => {
    const script = genUiAnchorPresetScript('/scene.tscn', '/root/Label', 0, 'top_left');
    assert.ok(script.includes('node.set_anchors_preset(0)'));
  });

  it('uses correct preset value for center (8)', () => {
    const script = genUiAnchorPresetScript('/scene.tscn', '/root/Label', 8, 'center');
    assert.ok(script.includes('node.set_anchors_preset(8)'));
  });
});

// ─── getToolDefinitions ─────────────────────────────────────────────────────

describe('getToolDefinitions', () => {
  it('returns 4 tool definitions', () => {
    const defs = getToolDefinitions();
    assert.strictEqual(defs.length, 4);
  });
  it('each definition has a name from TOOL_NAMES', () => {
    const defs = getToolDefinitions();
    const names = defs.map(d => d.name);
    for (const tn of TOOL_NAMES) {
      assert.ok(names.includes(tn), `missing tool definition for ${tn}`);
    }
  });
  it('each definition has inputSchema with required fields', () => {
    const defs = getToolDefinitions();
    for (const def of defs) {
      assert.ok(def.inputSchema, `${def.name} missing inputSchema`);
      assert.ok(def.inputSchema.required, `${def.name} missing required fields`);
    }
  });
  it('ui_create_control has node_type enum with all Control types', () => {
    const defs = getToolDefinitions();
    const createDef = defs.find(d => d.name === 'ui_create_control');
    assert.ok(createDef);
    const enumValues = createDef.inputSchema.properties.node_type.enum;
    assert.ok(enumValues);
    assert.strictEqual(enumValues.length, 29);
    assert.ok(enumValues.includes('Button'));
    assert.ok(enumValues.includes('Label'));
    assert.ok(enumValues.includes('NinePatchRect'));
  });
  it('ui_anchor_preset has preset enum with all 16 presets', () => {
    const defs = getToolDefinitions();
    const anchorDef = defs.find(d => d.name === 'ui_anchor_preset');
    assert.ok(anchorDef);
    const enumValues = anchorDef.inputSchema.properties.preset.enum;
    assert.ok(enumValues);
    assert.strictEqual(enumValues.length, 16);
    assert.ok(enumValues.includes('top_left'));
    assert.ok(enumValues.includes('full_rect'));
    assert.ok(enumValues.includes('center'));
  });
});
