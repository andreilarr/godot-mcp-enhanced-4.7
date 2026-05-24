import { expect } from 'vitest';
import { EditorConnection } from '../build/core/EditorConnection.js';
import { WebSocketServer } from 'ws';

describe('EditorConnection', () => {
  let wss;
  let port;

  beforeEach(() => {
    wss = new WebSocketServer({ port: 0 });
    port = wss.address().port;
  });

  afterEach(() => {
    wss.close();
  });

  it('connects and sends JSON-RPC request', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
      });
    });

    const conn = new EditorConnection({ port, reconnect: false });
    await conn.connect();
    const result = await conn.request('test_method', { key: 'value' });
    expect(result).toEqual({ status: 'ok' });
    conn.disconnect();
  });

  it('handles connection refused gracefully', async () => {
    const conn = new EditorConnection({ port: 59999, reconnect: false, connectTimeout: 1000 });
    await expect(() => conn.connect()).rejects.toThrow(/connect/i);
  });

  it('handles request timeout', async () => {
    wss.on('connection', (ws) => {
      // 不回复，模拟超时
    });

    const conn = new EditorConnection({ port, reconnect: false, requestTimeout: 500 });
    await conn.connect();
    await expect(() => conn.request('slow_method', {})).rejects.toThrow(/timeout/i);
    conn.disconnect();
  });

  it('sends operation_start for long running operations', async () => {
    let received = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        received.push(msg);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
      });
    });

    const conn = new EditorConnection({ port, reconnect: false });
    await conn.connect();
    await conn.startOperation(300);
    expect(received.some(m => m.method === 'operation_start')).toBeTruthy();
    await conn.endOperation();
    expect(received.some(m => m.method === 'operation_end')).toBeTruthy();
    conn.disconnect();
  });
});
