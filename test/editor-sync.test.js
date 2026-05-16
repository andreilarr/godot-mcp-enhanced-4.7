import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EditorConnection } from '../build/core/EditorConnection.js';

describe('EditorConnection notification channel', () => {
  it('should have onNotification and offNotification methods', () => {
    const conn = new EditorConnection({ port: 9999 });
    assert.equal(typeof conn.onNotification, 'function');
    assert.equal(typeof conn.offNotification, 'function');
  });

  it('should have onDisconnect property', () => {
    const conn = new EditorConnection({ port: 9999 });
    assert.equal(conn.onDisconnect, null);
  });
});
