import { expect } from 'vitest';
import {
  getToolDefinitions,
  TOOL_META,
  genSignalConnectScript,
  genSignalDisconnectScript,
  genSignalEmitScript,
  genSignalListScript,
} from '../src/tools/signal-ops.js';

// ─── getToolDefinitions ─────────────────────────────────────────────────────

describe('signal-ops getToolDefinitions', () => {
  it('returns 1 merged tool definition', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(1);
  });
  it('tool is named "signal"', () => {
    const defs = getToolDefinitions();
    expect(defs[0].name).toBe('signal');
  });
  it('action enum contains all 4 actions', () => {
    const defs = getToolDefinitions();
    const actionEnum = defs[0].inputSchema.properties.action.enum;
    expect(actionEnum).toContain('signal_connect');
    expect(actionEnum).toContain('signal_disconnect');
    expect(actionEnum).toContain('signal_emit');
    expect(actionEnum).toContain('signal_list');
  });
  it('definition has inputSchema with required fields', () => {
    const defs = getToolDefinitions();
    expect(defs[0].inputSchema).toBeTruthy();
    expect(defs[0].inputSchema.required).toContain('project_path');
    expect(defs[0].inputSchema.required).toContain('action');
  });
});

// ─── TOOL_META ──────────────────────────────────────────────────────────────

describe('signal-ops TOOL_META', () => {
  it('has exactly 1 entry for "signal"', () => {
    expect(Object.keys(TOOL_META).length).toBe(1);
    expect(TOOL_META.signal).toBeDefined();
  });
  it('signal is non-readonly and non-long-running', () => {
    expect(TOOL_META.signal.readonly).toBe(false);
    expect(TOOL_META.signal.long_running).toBe(false);
  });
});

// ─── genSignalConnectScript ─────────────────────────────────────────────────

describe('genSignalConnectScript', () => {
  it('generates GDScript with connect call', () => {
    const script = genSignalConnectScript('/root/Player', 'hit', '/root/UI', 'on_hit');
    expect(script.includes('source.connect("hit"')).toBeTruthy();
    expect(script.includes('Callable(target, "on_hit")')).toBeTruthy();
    expect(script.includes('_mcp_get_node')).toBeTruthy();
  });
  it('includes flags when provided', () => {
    const script = genSignalConnectScript('/root/A', 'sig', '/root/B', 'fn', 4);
    expect(script.includes('4)')).toBeTruthy();
  });
});

// ─── genSignalDisconnectScript ──────────────────────────────────────────────

describe('genSignalDisconnectScript', () => {
  it('generates GDScript with disconnect call', () => {
    const script = genSignalDisconnectScript('/root/Player', 'hit', '/root/UI', 'on_hit');
    expect(script.includes('source.disconnect("hit"')).toBeTruthy();
    expect(script.includes('Callable(target, "on_hit")')).toBeTruthy();
    expect(script.includes('_mcp_output("disconnected"')).toBeTruthy();
  });
});

// ─── genSignalEmitScript ───────────────────────────────────────────────────

describe('genSignalEmitScript', () => {
  it('generates GDScript with emit_signal call (no args)', () => {
    const script = genSignalEmitScript('/root/Player', 'died');
    expect(script.includes('source.emit_signal("died")')).toBeTruthy();
    expect(script.includes('_mcp_output("emitted"')).toBeTruthy();
  });
  it('serializes string args', () => {
    const script = genSignalEmitScript('/root/Player', 'msg', ['hello']);
    expect(script.includes('"hello"')).toBeTruthy();
  });
  it('serializes number args', () => {
    const script = genSignalEmitScript('/root/Player', 'damage', [42]);
    expect(script.includes('42')).toBeTruthy();
  });
  it('serializes boolean args', () => {
    const script = genSignalEmitScript('/root/Player', 'toggle', [true]);
    expect(script.includes('true')).toBeTruthy();
  });
  it('serializes null args', () => {
    const script = genSignalEmitScript('/root/Player', 'reset', [null]);
    expect(script.includes('null')).toBeTruthy();
  });
  it('throws on unsupported arg types', () => {
    expect(() => genSignalEmitScript('/root/A', 'sig', [{}])).toThrow(/basic types/);
  });
});

// ─── genSignalListScript ───────────────────────────────────────────────────

describe('genSignalListScript', () => {
  it('generates GDScript with get_signal_list call', () => {
    const script = genSignalListScript('/root/Player');
    expect(script.includes('node.get_signal_list()')).toBeTruthy();
    expect(script.includes('_mcp_output("signals"')).toBeTruthy();
    expect(script.includes('_mcp_get_node')).toBeTruthy();
  });
});
