import { expect, vi, beforeEach, afterEach, describe } from 'vitest';
import { EditorToolExecutor } from '../src/core/EditorToolExecutor.js';
import { registerTools, clearRegistry } from '../src/core/tool-registry.js';
import { WebSocketServer } from 'ws';
import { EditorConnection } from '../src/core/EditorConnection.js';

describe('EditorToolExecutor existing tests (real WS)', () => {
  let wss;
  let port;

  beforeEach(() => {
    clearRegistry();
    registerTools([
      { name: 'add_node', readonly: false, long_running: false },
      { name: 'edit_node', readonly: false, long_running: false },
      { name: 'query_scene_tree', readonly: true, long_running: false },
      { name: 'editor_get_scene_tree', readonly: true, long_running: false },
    ]);
    wss = new WebSocketServer({ port: 0 });
    port = wss.address().port;
  });

  afterEach(() => {
    wss.close();
    clearRegistry();
  });

  it('forwards tool call as JSON-RPC and returns result', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { node_path: 'root/Player' } }));
      });
    });
    const conn = new EditorConnection({ port, reconnect: false, secret: 'test-secret' });
    await conn.connect();
    const executor = new EditorToolExecutor(conn);
    const result = await executor.execute('add_node', {
      project_path: '/test', scene_path: 'res://main.tscn',
      node_type: 'Sprite2D', node_name: 'Player',
    });
    expect(JSON.parse(result.content[0].text)).toEqual({ node_path: 'root/Player' });
    conn.disconnect();
  });

  it('handles JSON-RPC error from plugin', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'auth') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
        } else {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32002, message: 'Node not found' } }));
        }
      });
    });
    const conn = new EditorConnection({ port, reconnect: false, secret: 'test-secret' });
    await conn.connect();
    const executor = new EditorToolExecutor(conn);
    const result = await executor.execute('edit_node', { node_path: 'root/Missing' });
    expect(result.isError).toBe(true);
    conn.disconnect();
  });

  it('attaches _use_undo=true for write operations', async () => {
    let capturedParams = null;
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'auth') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
        } else {
          capturedParams = msg.params;
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }));
        }
      });
    });
    const conn = new EditorConnection({ port, reconnect: false, secret: 'test-secret' });
    await conn.connect();
    const executor = new EditorToolExecutor(conn);
    await executor.execute('add_node', { project_path: '/test', node_type: 'Sprite2D', node_name: 'Player' });
    expect(capturedParams).toBeDefined();
    expect(capturedParams._use_undo).toBe(true);
    expect(capturedParams.project_path).toBe('/test');
    conn.disconnect();
  });

  it('does NOT attach _use_undo for read-only operations', async () => {
    let capturedParams = null;
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'auth') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
        } else {
          capturedParams = msg.params;
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }));
        }
      });
    });
    const conn = new EditorConnection({ port, reconnect: false, secret: 'test-secret' });
    await conn.connect();
    const executor = new EditorToolExecutor(conn);
    await executor.execute('query_scene_tree', { project_path: '/test', scene_path: 'res://main.tscn' });
    expect(capturedParams).toBeDefined();
    expect(capturedParams._use_undo).toBeUndefined();
    conn.disconnect();
  });

  it('does NOT attach _use_undo for unknown tools', async () => {
    let capturedParams = null;
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'auth') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
        } else {
          capturedParams = msg.params;
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }));
        }
      });
    });
    const conn = new EditorConnection({ port, reconnect: false, secret: 'test-secret' });
    await conn.connect();
    const executor = new EditorToolExecutor(conn);
    await executor.execute('some_unknown_tool', { project_path: '/test' });
    expect(capturedParams).toBeDefined();
    expect(capturedParams._use_undo).toBeUndefined();
    conn.disconnect();
  });
});

// ─── Mock-based tests for sync/buffer/destroy logic ──────────────────────────

describe('EditorToolExecutor sync lifecycle (mocked conn)', () => {
  let mockConn;
  let executor;

  beforeEach(() => {
    clearRegistry();
    registerTools([
      { name: 'add_node', readonly: false, long_running: false },
    ]);
    mockConn = {
      request: vi.fn().mockResolvedValue({ status: 'ok' }),
      onNotification: vi.fn(),
      offNotification: vi.fn(),
      addOnDisconnectHandler: vi.fn(),
      addOnReconnectHandler: vi.fn(),
      removeOnDisconnectHandler: vi.fn(),
      removeOnReconnectHandler: vi.fn(),
    };
    executor = new EditorToolExecutor(mockConn);
  });

  afterEach(() => {
    clearRegistry();
  });

  it('sync_start registers notification handler and sets active', async () => {
    const result = await executor.execute('editor', { action: 'sync_start' });
    expect(mockConn.onNotification).toHaveBeenCalledWith('scene_tree_changed', expect.any(Function));
    expect(result.isError).toBeFalsy();
  });

  it('duplicate sync_start returns SYNC_ALREADY_ACTIVE', async () => {
    await executor.execute('editor', { action: 'sync_start' });
    const result = await executor.execute('editor', { action: 'sync_start' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe('SYNC_ALREADY_ACTIVE');
  });

  it('sync_stop without start returns SYNC_NOT_ACTIVE', async () => {
    const result = await executor.execute('editor', { action: 'sync_stop' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe('SYNC_NOT_ACTIVE');
  });

  it('sync_stop returns buffered changes', async () => {
    await executor.execute('editor', { action: 'sync_start' });
    // Simulate tree changes by invoking the registered handler
    const handler = mockConn.onNotification.mock.calls[0][1];
    handler({ type: 'node_added', path: 'root/A', node_type: 'Node' });
    handler({ type: 'node_removed', path: 'root/B', node_type: 'Sprite2D' });

    const result = await executor.execute('editor', { action: 'sync_stop' });
    expect(mockConn.offNotification).toHaveBeenCalledWith('scene_tree_changed', expect.any(Function));
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.buffered_changes).toHaveLength(2);
    expect(parsed.buffered_changes[0].type).toBe('node_added');
    expect(parsed.buffered_changes[1].type).toBe('node_removed');
  });

  it('sync_stop with empty buffer returns empty changes', async () => {
    await executor.execute('editor', { action: 'sync_start' });
    const result = await executor.execute('editor', { action: 'sync_stop' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.buffered_changes).toHaveLength(0);
  });

  it('sync_start failure removes notification handler', async () => {
    mockConn.request.mockRejectedValueOnce(new Error('Plugin error'));
    const result = await executor.execute('editor', { action: 'sync_start' });
    expect(result.isError).toBe(true);
    expect(mockConn.offNotification).toHaveBeenCalledWith('scene_tree_changed', expect.any(Function));
    // Should not be active after failure
    const stopResult = await executor.execute('editor', { action: 'sync_stop' });
    expect(stopResult.isError).toBe(true);
  });

  it('sync_stop failure still returns buffered changes', async () => {
    await executor.execute('editor', { action: 'sync_start' });
    const handler = mockConn.onNotification.mock.calls[0][1];
    handler({ type: 'node_added', path: 'root/X', node_type: 'Node' });

    mockConn.request.mockRejectedValueOnce(new Error('Stop failed'));
    const result = await executor.execute('editor', { action: 'sync_stop' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.buffered_changes).toHaveLength(1);
    expect(parsed.warning).toBe('Stop failed');
  });
});

describe('EditorToolExecutor treeChangeRing (mocked conn)', () => {
  let mockConn;
  let executor;

  beforeEach(() => {
    clearRegistry();
    registerTools([
      { name: 'add_node', readonly: false, long_running: false },
    ]);
    mockConn = {
      request: vi.fn().mockResolvedValue({ status: 'ok' }),
      onNotification: vi.fn(),
      offNotification: vi.fn(),
      addOnDisconnectHandler: vi.fn(),
      addOnReconnectHandler: vi.fn(),
      removeOnDisconnectHandler: vi.fn(),
      removeOnReconnectHandler: vi.fn(),
    };
    executor = new EditorToolExecutor(mockConn);
  });

  afterEach(() => { clearRegistry(); });

  it('ignores tree changes with missing type', async () => {
    await executor.execute('editor', { action: 'sync_start' });
    const handler = mockConn.onNotification.mock.calls[0][1];
    handler({ path: 'root/A' }); // missing type
    handler(null); // null
    handler(42); // not object
    handler({ type: 'node_added', path: 'root/C', node_type: 'Node' }); // valid

    const result = await executor.execute('editor', { action: 'sync_stop' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.buffered_changes).toHaveLength(1);
  });

  it('disconnect handler resets sync state', () => {
    const disconnectHandler = mockConn.addOnDisconnectHandler.mock.calls[0][0];
    // Start sync manually
    executor.execute('editor', { action: 'sync_start' });
    // Simulate disconnect
    disconnectHandler();
    // sync_stop should now say NOT_ACTIVE
    return executor.execute('editor', { action: 'sync_stop' }).then((result) => {
      expect(result.isError).toBe(true);
    });
  });

  it('reconnect handler re-registers notification if sync was active', async () => {
    await executor.execute('editor', { action: 'sync_start' });
    mockConn.onNotification.mockClear();

    const reconnectHandler = mockConn.addOnReconnectHandler.mock.calls[0][0];
    reconnectHandler();

    expect(mockConn.onNotification).toHaveBeenCalledWith('scene_tree_changed', expect.any(Function));
  });

  it('reconnect handler does not register if sync was not active', () => {
    mockConn.onNotification.mockClear();
    const reconnectHandler = mockConn.addOnReconnectHandler.mock.calls[0][0];
    reconnectHandler();
    expect(mockConn.onNotification).not.toHaveBeenCalled();
  });
});

describe('EditorToolExecutor execute branches (mocked conn)', () => {
  let mockConn;
  let executor;

  beforeEach(() => {
    clearRegistry();
    registerTools([
      { name: 'add_node', readonly: false, long_running: false },
    ]);
    mockConn = {
      request: vi.fn().mockResolvedValue({ nodes: [], root: 'Node3D' }),
      onNotification: vi.fn(),
      offNotification: vi.fn(),
      addOnDisconnectHandler: vi.fn(),
      addOnReconnectHandler: vi.fn(),
      removeOnDisconnectHandler: vi.fn(),
      removeOnReconnectHandler: vi.fn(),
    };
    executor = new EditorToolExecutor(mockConn);
  });

  afterEach(() => { clearRegistry(); });

  it('get_scene_tree action calls editor_get_scene_tree', async () => {
    const result = await executor.execute('editor', { action: 'get_scene_tree' });
    expect(mockConn.request).toHaveBeenCalledWith('editor_get_scene_tree', { action: 'get_scene_tree' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.root).toBe('Node3D');
  });

  it('get_scene_tree error returns error result', async () => {
    mockConn.request.mockRejectedValueOnce(Object.assign(new Error('Tree error'), { code: -32001 }));
    const result = await executor.execute('editor', { action: 'get_scene_tree' });
    expect(result.isError).toBe(true);
  });

  it('destroy removes disconnect and reconnect handlers', () => {
    executor.destroy();
    expect(mockConn.removeOnDisconnectHandler).toHaveBeenCalledWith(expect.any(Function));
    expect(mockConn.removeOnReconnectHandler).toHaveBeenCalledWith(expect.any(Function));
  });

  it('unknown editor action forwards to plugin', async () => {
    const result = await executor.execute('editor', { action: 'custom_action', foo: 'bar' });
    expect(mockConn.request).toHaveBeenCalledWith('editor', { action: 'custom_action', foo: 'bar' });
    expect(result.isError).toBeFalsy();
  });

  it('non-editor tool forwards to plugin with _use_undo for writes', async () => {
    const result = await executor.execute('add_node', { project_path: '/test' });
    expect(mockConn.request).toHaveBeenCalledWith('add_node', { project_path: '/test', _use_undo: true });
    expect(result.isError).toBeFalsy();
  });
});