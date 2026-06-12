import { describe, it, expect, beforeEach } from 'vitest';
import {
  escapeRegExp,
  detectAutoloadUsage,
  parseAutoloadNames,
  _resetAutoloadCache,
  parseMcpMarkers,
  scanGdscriptSandbox,
} from '../src/gdscript-executor.js';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TMP = join(tmpdir(), 'autoload-test-' + process.pid);

beforeEach(() => {
  _resetAutoloadCache();
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

describe('escapeRegExp', () => {
  it('转义正则元字符', () => {
    expect(escapeRegExp('My-Singleton')).toBe('My-Singleton');
    expect(escapeRegExp('UI.Manager')).toBe('UI\\.Manager');
    expect(escapeRegExp('NormalName')).toBe('NormalName');
  });
});

describe('parseAutoloadNames', () => {
  it('解析 autoload 名称列表', () => {
    writeFileSync(join(TMP, 'project.godot'), [
      '[autoload]',
      'GameManager="*res://game_manager.gd"',
      'DataTables="*res://data_tables.gd"',
    ].join('\n'), 'utf-8');
    expect(parseAutoloadNames(TMP)).toEqual(['GameManager', 'DataTables']);
  });

  it('无 autoload 段返回空数组', () => {
    writeFileSync(join(TMP, 'project.godot'), '[application]\nconfig/name="Test"', 'utf-8');
    expect(parseAutoloadNames(TMP)).toEqual([]);
  });

  it('文件不存在返回空数组', () => {
    expect(parseAutoloadNames(join(tmpdir(), 'noexist-' + Date.now()))).toEqual([]);
  });

  it('缓存命中', () => {
    writeFileSync(join(TMP, 'project.godot'), '[autoload]\nX="*res://x.gd"', 'utf-8');
    const first = parseAutoloadNames(TMP);
    rmSync(join(TMP, 'project.godot'));
    expect(parseAutoloadNames(TMP)).toEqual(first);
  });
});

describe('detectAutoloadUsage', () => {
  it('检测 autoload 引用', () => {
    const code = 'GameManager.get_hp()\nDataTables.fetch()';
    const r = detectAutoloadUsage(code, ['GameManager', 'DataTables', 'Unused']);
    expect(r).toContain('GameManager');
    expect(r).toContain('DataTables');
    expect(r).not.toContain('Unused');
  });

  it('无匹配返回空数组', () => {
    expect(detectAutoloadUsage('var x = 1', ['GameManager'])).toEqual([]);
  });

  it('空代码返回空数组', () => {
    expect(detectAutoloadUsage('', ['GameManager'])).toEqual([]);
  });

  it('正则元字符名正确匹配', () => {
    expect(detectAutoloadUsage('My-Singleton.run()', ['My-Singleton'])).toContain('My-Singleton');
  });

  it('词边界：不匹配部分名', () => {
    expect(detectAutoloadUsage('MyGameManager.get()', ['GameManager'])).toEqual([]);
  });
});

describe('autoload auto-detection 集成', () => {
  it('空项目（无 autoload）不会误触发', () => {
    writeFileSync(join(TMP, 'project.godot'), '[application]\nconfig/name="Empty"', 'utf-8');
    const names = parseAutoloadNames(TMP);
    expect(names).toEqual([]);
    const detected = detectAutoloadUsage('var x = 1', names);
    expect(detected).toEqual([]);
  });

  it('autoload 名含下划线正确匹配', () => {
    const code = 'var x = My_Module.fetch()';
    const result = detectAutoloadUsage(code, ['My_Module']);
    expect(result).toContain('My_Module');
  });

  it('多个 autoload 部分引用只返回匹配的', () => {
    const code = 'GameManager.reset()';
    const result = detectAutoloadUsage(code, ['GameManager', 'DataTables', 'GameEvents']);
    expect(result).toEqual(['GameManager']);
  });
});

// === 原有测试继续 ===

const MARKER_RESULT = '___MCP_RESULT___';
const MARKER_ERROR = '___MCP_ERROR___';

describe('parseMcpMarkers', () => {
  it('parses result marker with outputs', () => {
    const raw = `Hello world
${MARKER_RESULT}{"success":true,"outputs":[{"key":"x","value":"42"}]}`;
    const { parsed, logLines } = parseMcpMarkers(raw);
    expect(parsed).toEqual({ success: true, outputs: [{ key: 'x', value: '42' }] });
    expect(logLines).toEqual(['Hello world']);
  });

  it('parses error marker', () => {
    const raw = `${MARKER_ERROR}{"success":false,"error":"compile failed"}`;
    const { parsed } = parseMcpMarkers(raw);
    expect(parsed).toEqual({ success: false, error: 'compile failed' });
  });

  it('returns null when no marker found', () => {
    const raw = 'Just some output\nNo markers here';
    const { parsed, logLines } = parseMcpMarkers(raw);
    expect(parsed).toBe(null);
    expect(logLines.length).toBe(2);
  });

  it('handles malformed JSON in marker', () => {
    const raw = `${MARKER_RESULT}{broken json}`;
    const { parsed } = parseMcpMarkers(raw);
    expect(parsed.success).toBe(false);
  });
});

describe('wrapSnippet code detection', () => {
  it('detects full class with extends', () => {
    const code = 'extends SceneTree\n\nfunc _initialize():\n\tprint("hi")';
    expect(/^\s*extends\s+/m.test(code)).toBeTruthy();
  });

  it('snippet without extends is not full class', () => {
    const code = 'var x = 1\nprint(x)';
    expect(/^\s*extends\s+/m.test(code)).toBeFalsy();
  });
});

describe('scanGdscriptSandbox', () => {
  afterEach(() => {
    delete process.env.GODOT_MCP_SANDBOX;
  });

  it('should detect OS.execute by default (sandbox on)', () => {
    delete process.env.GODOT_MCP_SANDBOX;
    const warnings = scanGdscriptSandbox('OS.execute("rm", ["-rf", "/"])');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('OS system command');
  });

  it('should skip scanning when explicitly disabled', () => {
    process.env.GODOT_MCP_SANDBOX = 'disabled';
    const warnings = scanGdscriptSandbox('OS.execute("rm", ["-rf", "/"])');
    expect(warnings).toEqual([]);
  });

  it('should not flag safe code', () => {
    delete process.env.GODOT_MCP_SANDBOX;
    const warnings = scanGdscriptSandbox('var x = 1 + 2');
    expect(warnings).toEqual([]);
  });

  it('should detect DirAccess.remove by default', () => {
    delete process.env.GODOT_MCP_SANDBOX;
    const warnings = scanGdscriptSandbox('DirAccess.remove("user://save.dat")');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('Directory removal');
  });

  it('should detect FileAccess.open WRITE mode by default (C-03: READ is allowed)', () => {
    delete process.env.GODOT_MCP_SANDBOX;
    const warnings = scanGdscriptSandbox('FileAccess.open("user://data.txt", FileAccess.WRITE)');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('File write access');
  });

  it('should allow FileAccess.open READ mode by default (C-03)', () => {
    delete process.env.GODOT_MCP_SANDBOX;
    const warnings = scanGdscriptSandbox('FileAccess.open("user://data.txt", FileAccess.READ)');
    expect(warnings.length).toBe(0);
  });

  it('should detect Engine.set_singleton by default', () => {
    delete process.env.GODOT_MCP_SANDBOX;
    const warnings = scanGdscriptSandbox('Engine.set_singleton("MySingleton", node)');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('Engine singleton modification');
  });

  it('should detect multiple dangerous patterns in one script', () => {
    delete process.env.GODOT_MCP_SANDBOX;
    const code = 'OS.execute("ls", [])\nDirAccess.remove_absolute("/tmp/test")';
    const warnings = scanGdscriptSandbox(code);
    expect(warnings.length).toBe(2);
  });

  it('should still scan when GODOT_MCP_SANDBOX is set to other values', () => {
    process.env.GODOT_MCP_SANDBOX = 'warn';
    const warnings = scanGdscriptSandbox('OS.execute("rm", ["-rf", "/"])');
    expect(warnings.length).toBeGreaterThan(0);
  });
});