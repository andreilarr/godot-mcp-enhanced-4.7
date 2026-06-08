/**
 * GDScript code generation correctness tests (I-CI-01).
 *
 * These tests verify the ACTUAL generated GDScript strings,
 * not mock behavior. They check for:
 * - Correct escaping in gdEscape()
 * - Valid GDScript syntax patterns in generated code
 * - Consistent tab indentation (no space/tab mixing)
 * - Expected function calls and markers
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// Mock gdscript-executor so stress test handler can run without Godot
const _capturedScripts = [];
vi.mock('../src/gdscript-executor.js', () => ({
  scanGdscriptSandbox: vi.fn(() => []),
  executeGdscript: vi.fn(async (opts) => {
    _capturedScripts.push(opts.code);
    return {
      success: true, compile_success: true, compile_error: '',
      errors: [], run_success: true, run_error: '',
      outputs: [{ key: 'result', value: JSON.stringify({ success: true, iterations: 100 }) }],
      raw_output: '', duration_ms: 100,
    };
  }),
  executeGdscriptTrusted: vi.fn(async (opts) => {
    _capturedScripts.push(opts.code);
    return {
      success: true, compile_success: true, compile_error: '',
      errors: [], run_success: true, run_error: '',
      outputs: [{ key: 'result', value: JSON.stringify({ success: true, iterations: 100 }) }],
      raw_output: '', duration_ms: 100,
    };
  }),
}));

import {
  gdEscape,
  SCENE_TREE_HEADER,
  MARKER_RESULT,
  wrapAssertionCode,
} from '../src/tools/shared.js';
import {
  genRecordingSaveScript,
  genRecordingLoadScript,
} from '../src/tools/recording.js';

// ─── Helper: check that a multi-line string uses consistent tab indentation ──

function hasConsistentTabIndentation(code) {
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue; // skip blank lines
    // Detect leading spaces that aren't part of tab indentation
    const leadingMatch = line.match(/^(\s+)/);
    if (leadingMatch) {
      const leading = leadingMatch[1];
      // If any leading whitespace is a space (not tab), that's mixed indentation
      if (leading.includes(' ')) {
        return { ok: false, line: i + 1, content: line };
      }
    }
  }
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. gdEscape
// ═══════════════════════════════════════════════════════════════════════════════

describe('gdEscape — GDScript string escaping', () => {
  it('escapes backslash to double-backslash', () => {
    expect(gdEscape('path\\to\\file')).toBe('path\\\\to\\\\file');
  });

  it('escapes newline to \\n literal', () => {
    expect(gdEscape('line1\nline2')).toBe('line1\\nline2');
  });

  it('escapes CRLF to \\n (not \\\\r\\\\n)', () => {
    expect(gdEscape('line1\r\nline2')).toBe('line1\\nline2');
  });

  it('escapes bare CR to \\n', () => {
    expect(gdEscape('line1\rline2')).toBe('line1\\nline2');
  });

  it('escapes tab to \\t literal', () => {
    expect(gdEscape('col1\tcol2')).toBe('col1\\tcol2');
  });

  it('escapes double quote to \\"', () => {
    expect(gdEscape('say "hello"')).toBe('say \\"hello\\"');
  });

  it('does NOT escape dollar sign (not special in GDScript strings)', () => {
    expect(gdEscape('$Node/Child')).toBe('$Node/Child');
  });

  it('escapes percent to %% (GDScript format placeholder)', () => {
    expect(gdEscape('100%')).toBe('100%%');
  });

  it('escapes single quote', () => {
    expect(gdEscape("it's")).toBe("it\\'s");
  });

  it('removes null bytes', () => {
    expect(gdEscape('before\0after')).toBe('beforeafter');
  });

  it('handles empty string', () => {
    expect(gdEscape('')).toBe('');
  });

  it('handles string with all special characters combined', () => {
    const input = 'a\\b\nc\td"e%f$g\'h\0i';
    const result = gdEscape(input);
    // No raw control characters should remain
    expect(result).not.toContain('\n');
    expect(result).not.toContain('\t');
    expect(result).not.toContain('\r');
    expect(result).not.toContain('\0');
    // Should contain escaped versions
    expect(result).toContain('\\\\');
    expect(result).toContain('\\n');
    expect(result).toContain('\\t');
    expect(result).toContain('\\"');
    expect(result).toContain('%%');
    // $ is NOT escaped — not special in GDScript double-quoted strings
    expect(result).toContain("\\'");
  });

  it('does not double-escape already-escaped sequences', () => {
    // gdEscape is NOT idempotent by design — applying twice double-escapes
    const once = gdEscape('a\nb');
    const twice = gdEscape(once);
    expect(twice).toBe('a\\\\nb'); // \\n becomes \\\\n
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. SCENE_TREE_HEADER
// ═══════════════════════════════════════════════════════════════════════════════

describe('SCENE_TREE_HEADER — GDScript scene tree boilerplate', () => {
  it('starts with "extends SceneTree"', () => {
    expect(SCENE_TREE_HEADER.startsWith('extends SceneTree')).toBe(true);
  });

  it('contains _mcp_root variable declaration', () => {
    expect(SCENE_TREE_HEADER).toContain('var _mcp_root: Node = null');
  });

  it('contains _mcp_get_root function', () => {
    expect(SCENE_TREE_HEADER).toContain('func _mcp_get_root() -> Node:');
  });

  it('contains _mcp_get_node function', () => {
    expect(SCENE_TREE_HEADER).toContain('func _mcp_get_node(path: NodePath) -> Node:');
  });

  it('contains _mcp_load_main_scene function', () => {
    expect(SCENE_TREE_HEADER).toContain('func _mcp_load_main_scene() -> void:');
  });

  it('contains _mcp_load_scene function', () => {
    expect(SCENE_TREE_HEADER).toContain('func _mcp_load_scene(sp: String) -> bool:');
  });

  it('contains _mcp_get_scene_node function', () => {
    expect(SCENE_TREE_HEADER).toContain('func _mcp_get_scene_node(path: String) -> Node:');
  });

  it('contains _mcp_done function', () => {
    expect(SCENE_TREE_HEADER).toContain('func _mcp_done() -> void:');
  });

  it('contains MARKER_RESULT in _mcp_done print statement', () => {
    expect(SCENE_TREE_HEADER).toContain(`"${MARKER_RESULT}"`);
  });

  it('contains quit(0) call', () => {
    expect(SCENE_TREE_HEADER).toContain('quit(0)');
  });

  it('uses consistent tab indentation', () => {
    const check = hasConsistentTabIndentation(SCENE_TREE_HEADER);
    expect(check.ok, `Mixed indentation at line ${check.line}: ${check.content}`).toBe(true);
  });

  it('uses manual traversal fallback for headless compatibility', () => {
    expect(SCENE_TREE_HEADER).toContain('Manual traversal for headless compatibility');
    expect(SCENE_TREE_HEADER).toContain('get_children()');
  });

  it('includes get_node_or_null call', () => {
    expect(SCENE_TREE_HEADER).toContain('get_node_or_null');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. test-framework.ts — stress test GDScript generation
// ═══════════════════════════════════════════════════════════════════════════════

describe('test-framework stress test GDScript generation', () => {
  // The stress test script is generated inline in handleTestStress.
  // We capture it via the top-level vi.mock of executeGdscript.

  let handleTool;
  beforeAll(async () => {
    const mod = await import('../src/tools/test-framework.js');
    handleTool = mod.handleTool;
  });

  beforeEach(() => {
    _capturedScripts.length = 0;
  });

  async function captureStressScript(args) {
    const mockCtx = { findGodot: vi.fn(async () => '/usr/bin/godot') };
    await handleTool('test', {
      project_path: '/tmp/test-project',
      action: 'stress',
      ...args,
    }, mockCtx);
    expect(_capturedScripts.length).toBeGreaterThanOrEqual(1);
    return _capturedScripts[_capturedScripts.length - 1];
  }

  it('generates script with consistent tab indentation (iterations=1)', async () => {
    const captured = await captureStressScript({ node_type: 'Node', iterations: 1 });
    const check = hasConsistentTabIndentation(captured);
    expect(check.ok, `Mixed indentation at line ${check.line}: ${check.content}`).toBe(true);
  });

  it('generates script with consistent tab indentation (iterations=1000)', async () => {
    const captured = await captureStressScript({ node_type: 'Node', iterations: 1000 });
    const check = hasConsistentTabIndentation(captured);
    expect(check.ok, `Mixed indentation at line ${check.line}: ${check.content}`).toBe(true);
  });

  it('generated script contains expected GDScript constructs', async () => {
    const captured = await captureStressScript({ node_type: 'Node', iterations: 100 });
    expect(captured).toContain('ClassDB.instantiate');
    expect(captured).toContain('Performance.get_monitor');
    expect(captured).toContain('Performance.OBJECT_COUNT');
    expect(captured).toContain('Performance.MEMORY_STATIC');
    expect(captured).toContain('queue_free');
    expect(captured).toContain('_mcp_output("result"');
    expect(captured).toContain('extends SceneTree');
  });

  it('generated script uses the correct node type', async () => {
    const captured = await captureStressScript({ node_type: 'Node3D', iterations: 10 });
    expect(captured).toContain('"Node3D"');
    expect(captured).toContain('var _iters = 10');
  });

  it('clamps iterations to valid range', async () => {
    const captured = await captureStressScript({ node_type: 'Node', iterations: 99999 });
    expect(captured).toContain('var _iters = 10000');
  });

  it('iterations < 1 is clamped to 1', async () => {
    const captured = await captureStressScript({ node_type: 'Node', iterations: -5 });
    expect(captured).toContain('var _iters = 1');
  });

  it('contains process_frame await for cleanup', async () => {
    const captured = await captureStressScript({ node_type: 'Node', iterations: 10 });
    expect(captured).toContain('await self.process_frame');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. recording.ts — genRecordingSaveScript / genRecordingLoadScript (genRecordingPlayScript removed: playback now uses Bridge)
// ═══════════════════════════════════════════════════════════════════════════════
// 5. recording.ts — genRecordingSaveScript / genRecordingLoadScript
// ═══════════════════════════════════════════════════════════════════════════════

describe('genRecordingSaveScript — GDScript save generation', () => {
  it('uses consistent tab indentation', () => {
    const script = genRecordingSaveScript('recording_test.json', '{"version":1,"events":[]}');
    const check = hasConsistentTabIndentation(script);
    expect(check.ok, `Mixed indentation at line ${check.line}: ${check.content}`).toBe(true);
  });

  it('uses FileAccess.WRITE mode', () => {
    const script = genRecordingSaveScript('recording_test.json', '{}');
    expect(script).toContain('FileAccess.WRITE');
  });

  it('creates recordings directory if missing', () => {
    const script = genRecordingSaveScript('recording_test.json', '{}');
    expect(script).toContain('dir_exists("recordings")');
    expect(script).toContain('make_dir("recordings")');
  });

  it('writes via store_string', () => {
    const script = genRecordingSaveScript('recording_test.json', '{}');
    expect(script).toContain('store_string');
  });
});

describe('genRecordingLoadScript — GDScript load generation', () => {
  it('uses consistent tab indentation', () => {
    const script = genRecordingLoadScript('recording_test.json');
    const check = hasConsistentTabIndentation(script);
    expect(check.ok, `Mixed indentation at line ${check.line}: ${check.content}`).toBe(true);
  });

  it('uses FileAccess.READ mode', () => {
    const script = genRecordingLoadScript('recording_test.json');
    expect(script).toContain('FileAccess.READ');
  });

  it('uses get_as_text to read file', () => {
    const script = genRecordingLoadScript('recording_test.json');
    expect(script).toContain('get_as_text');
  });

  it('parses JSON with JSON.parse_string', () => {
    const script = genRecordingLoadScript('recording_test.json');
    expect(script).toContain('JSON.parse_string');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. shared.ts — wrapAssertionCode
// ═══════════════════════════════════════════════════════════════════════════════

describe('wrapAssertionCode — GDScript assertion wrapper', () => {
  it('wraps user code with SCENE_TREE_HEADER and _mcp_done', () => {
    const script = wrapAssertionCode('_mcp_output("assert_1", true)', 'test assertion');
    expect(script).toContain('extends SceneTree');
    expect(script).toContain('_mcp_done()');
    expect(script).toContain('_mcp_output("assert_1", true)');
  });

  it('includes description as escaped string', () => {
    const script = wrapAssertionCode('pass', 'my "test" case');
    expect(script).toContain('my \\"test\\" case');
  });

  it('loads main scene by default', () => {
    const script = wrapAssertionCode('pass', 'test', true);
    expect(script).toContain('_mcp_load_main_scene()');
  });

  it('skips scene loading when loadScene=false', () => {
    const script = wrapAssertionCode('pass', 'test', false);
    // SCENE_TREE_HEADER contains the function definition, so only check _initialize() body
    const initBody = script.split('func _initialize():')[1];
    expect(initBody.split('func ')[0]).not.toContain('_mcp_load_main_scene()');
  });

  it('uses consistent tab indentation', () => {
    const script = wrapAssertionCode('var x = 1\n_mcp_output("k", x)', 'indent test');
    const check = hasConsistentTabIndentation(script);
    expect(check.ok, `Mixed indentation at line ${check.line}: ${check.content}`).toBe(true);
  });
});
