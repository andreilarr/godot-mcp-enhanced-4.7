import { expect } from 'vitest';
import { EditorConnection } from '../build/core/EditorConnection.js';

describe('EditorConnection notification channel', () => {
  it('should have onNotification and offNotification methods', () => {
    const conn = new EditorConnection({ port: 9999 });
    expect(typeof conn.onNotification).toBe('function');
    expect(typeof conn.offNotification).toBe('function');
  });

  it('should have onDisconnect property', () => {
    const conn = new EditorConnection({ port: 9999 });
    expect(conn.onDisconnect).toBe(null);
  });
});
