import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { clearGodotPathCache, getCachedGodotPath } from '../build/GodotServer.js';

describe('Godot path cache', () => {
  beforeEach(() => {
    clearGodotPathCache();
  });

  it('returns null before any findGodot call', () => {
    assert.strictEqual(getCachedGodotPath(), null);
  });

  it('clearGodotPathCache resets cache to null', () => {
    // Even if a test previously set the cache, clearing should yield null
    clearGodotPathCache();
    assert.strictEqual(getCachedGodotPath(), null);
  });

  it('getCachedGodotPath returns same value on repeated calls without clearing', () => {
    const first = getCachedGodotPath();
    const second = getCachedGodotPath();
    assert.strictEqual(first, second);
  });

  it('clearGodotPathCache is idempotent', () => {
    clearGodotPathCache();
    clearGodotPathCache();
    clearGodotPathCache();
    assert.strictEqual(getCachedGodotPath(), null);
  });
});
