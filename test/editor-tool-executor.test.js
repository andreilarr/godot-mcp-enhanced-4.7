import { expect, vi } from 'vitest';
import { EditorToolExecutor } from '../src/core/EditorToolExecutor.js';
import { EditorConnection } from '../src/core/EditorConnection.js';
import { registerTools, clearRegistry } from '../src/core/tool-registry.js';
import { WebSocketServer } from 'ws';

describe('EditorToolExecutor', () => {
  let wss;
  let port;

  beforeEach(() => {
    // 注册测试工具元数据（add_node=写操作，query_scene_tree=只读）
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
      project_path: '/test',
      scene_path: 'res://main.tscn',
      node_type: 'Sprite2D',
      node_name: 'Player',
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
    await executor.execute('add_node', {
      project_path: '/test',
      node_type: 'Sprite2D',
      node_name: 'Player',
    });

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
    await executor.execute('query_scene_tree', {
      project_path: '/test',
      scene_path: 'res://main.tscn',
    });

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
