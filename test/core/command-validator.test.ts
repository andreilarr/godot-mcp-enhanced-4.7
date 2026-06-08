import { describe, it, expect } from 'vitest';
import { validateGdscriptCommand } from '../../src/core/command-validator.js';

describe('validateGdscriptCommand', () => {
  it('allows safe code', () => {
    const result = validateGdscriptCommand('var x = 10');
    expect(result.safe).toBe(true);
  });

  it('blocks OS.crash', () => {
    const result = validateGdscriptCommand('OS.crash("msg")');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('OS.crash');
  });

  it('blocks Engine.quit', () => {
    const result = validateGdscriptCommand('Engine.quit()');
    expect(result.safe).toBe(false);
  });

  it('blocks OS.execute (shell injection)', () => {
    const result = validateGdscriptCommand('OS.execute("rm", ["-rf", "/"])');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('OS.execute');
  });

  it('blocks get_tree().quit()', () => {
    const result = validateGdscriptCommand('get_tree().quit()');
    expect(result.safe).toBe(false);
  });

  it('blocks FileAccess.open', () => {
    const result = validateGdscriptCommand('FileAccess.open("res://save.dat", FileAccess.READ)');
    expect(result.safe).toBe(false);
    expect(result.priority).toBeDefined();
  });

  it('assigns priority levels', () => {
    const crash = validateGdscriptCommand('OS.crash("msg")');
    expect(crash.priority).toBe(1);

    const fileAccess = validateGdscriptCommand('FileAccess.open("test", FileAccess.READ)');
    expect(fileAccess.priority).toBeLessThanOrEqual(5);
  });

  it('returns safe=true for empty code', () => {
    const result = validateGdscriptCommand('');
    expect(result.safe).toBe(true);
  });
});
