import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeNodePath, gdEscape, validateVector3,
  TYPE_WHITELIST, ERROR_CODES,
  genSignalConnectScript, genSignalDisconnectScript, genSignalEmitScript, genSignalListScript
} from '../build/tools/godot-ops.js';

describe('normalizeNodePath', () => {
  it('prepends / if missing', () => {
    assert.strictEqual(normalizeNodePath('root/Player'), '/root/Player');
  });
  it('keeps /root/... unchanged', () => {
    assert.strictEqual(normalizeNodePath('/root/Player'), '/root/Player');
  });
  it('rejects empty string', () => {
    assert.throws(() => normalizeNodePath(''), { message: /empty/ });
  });
  it('rejects whitespace-only', () => {
    assert.throws(() => normalizeNodePath('   '), { message: /empty/ });
  });
  it('rejects res:// paths', () => {
    assert.throws(() => normalizeNodePath('res://scenes/main.tscn'), { message: /scene tree path/ });
  });
  it('trims whitespace', () => {
    assert.strictEqual(normalizeNodePath('  /root/Player  '), '/root/Player');
  });
});

describe('gdEscape', () => {
  it('escapes double quotes', () => {
    assert.strictEqual(gdEscape('say "hello"'), 'say \\"hello\\"');
  });
  it('escapes backslashes', () => {
    assert.strictEqual(gdEscape('path\\to\\file'), 'path\\\\to\\\\file');
  });
  it('escapes newlines', () => {
    assert.strictEqual(gdEscape('line1\nline2'), 'line1\\nline2');
  });
  it('escapes CRLF', () => {
    assert.strictEqual(gdEscape('a\r\nb'), 'a\\nb');
  });
  it('removes null bytes', () => {
    assert.strictEqual(gdEscape('a\0b'), 'ab');
  });
  it('preserves unicode', () => {
    assert.strictEqual(gdEscape('你好世界'), '你好世界');
  });
  it('handles empty string', () => {
    assert.strictEqual(gdEscape(''), '');
  });
});

describe('validateVector3', () => {
  it('accepts valid {x,y,z}', () => {
    assert.deepStrictEqual(validateVector3({ x: 1, y: 2, z: 3 }), { x: 1, y: 2, z: 3 });
  });
  it('accepts zero values', () => {
    assert.deepStrictEqual(validateVector3({ x: 0, y: 0, z: 0 }), { x: 0, y: 0, z: 0 });
  });
  it('accepts negative values', () => {
    assert.deepStrictEqual(validateVector3({ x: -1, y: -2.5, z: -3 }), { x: -1, y: -2.5, z: -3 });
  });
  it('rejects missing field', () => {
    assert.throws(() => validateVector3({ x: 1, y: 2 }), { message: /must be a number/ });
  });
  it('rejects non-number value', () => {
    assert.throws(() => validateVector3({ x: '1', y: 2, z: 3 }), { message: /number/ });
  });
  it('rejects null', () => {
    assert.throws(() => validateVector3(null), { message: /object/ });
  });
});

describe('TYPE_WHITELIST', () => {
  it('contains Node3D', () => { assert.ok(TYPE_WHITELIST.includes('Node3D')); });
  it('contains MeshInstance3D', () => { assert.ok(TYPE_WHITELIST.includes('MeshInstance3D')); });
  it('contains Camera3D', () => { assert.ok(TYPE_WHITELIST.includes('Camera3D')); });
  it('contains RigidBody3D', () => { assert.ok(TYPE_WHITELIST.includes('RigidBody3D')); });
  it('does NOT contain Node', () => { assert.ok(!TYPE_WHITELIST.includes('Node')); });
});

describe('ERROR_CODES', () => {
  it('has INVALID_PATH', () => { assert.ok('INVALID_PATH' in ERROR_CODES); });
  it('has NODE_NOT_FOUND', () => { assert.ok('NODE_NOT_FOUND' in ERROR_CODES); });
  it('has INVALID_VECTOR', () => { assert.ok('INVALID_VECTOR' in ERROR_CODES); });
  it('has INVALID_TYPE', () => { assert.ok('INVALID_TYPE' in ERROR_CODES); });
  it('has INVALID_SIGNAL', () => { assert.ok('INVALID_SIGNAL' in ERROR_CODES); });
  it('has SCRIPT_EXEC_FAILED', () => { assert.ok('SCRIPT_EXEC_FAILED' in ERROR_CODES); });
});

describe('genSignalConnectScript', () => {
  it('contains get_node and connect', () => {
    const script = genSignalConnectScript('/root/Player', 'health_changed', '/root/UI', 'on_health_changed');
    assert.ok(script.includes('get_node("/root/Player")'));
    assert.ok(script.includes('connect("health_changed"'));
    assert.ok(script.includes('Callable'));
    assert.ok(script.includes('get_node("/root/UI")'));
    assert.ok(script.includes('"on_health_changed"'));
  });
});

describe('genSignalDisconnectScript', () => {
  it('contains disconnect call', () => {
    const script = genSignalDisconnectScript('/root/Player', 'health_changed', '/root/UI', 'on_health_changed');
    assert.ok(script.includes('disconnect("health_changed"'));
    assert.ok(script.includes('Callable'));
  });
});

describe('genSignalEmitScript', () => {
  it('contains emit_signal without args', () => {
    const script = genSignalEmitScript('/root/Player', 'died');
    assert.ok(script.includes('emit_signal("died")'));
  });
  it('serializes number args', () => {
    const script = genSignalEmitScript('/root/Player', 'health_changed', [100, 50]);
    assert.ok(script.includes('emit_signal("health_changed", 100, 50)'));
  });
  it('serializes string args with quotes', () => {
    const script = genSignalEmitScript('/root/Player', 'msg', ['hello']);
    assert.ok(script.includes('"hello"'));
  });
  it('rejects object args', () => {
    assert.throws(() => genSignalEmitScript('/root/Player', 'msg', [{ foo: 1 }]), { message: /basic types/ });
  });
});

describe('genSignalListScript', () => {
  it('contains get_signal_list', () => {
    const script = genSignalListScript('/root/Player');
    assert.ok(script.includes('get_signal_list()'));
    assert.ok(script.includes('_mcp_output'));
  });
});
