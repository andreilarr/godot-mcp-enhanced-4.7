import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs before importing the module under test
vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));
vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('path')>();
  return { ...actual, join: actual.join };
});

import { existsSync } from 'fs';
import { join, resolve } from 'path';

// Import AFTER mocks are set up
const { resolveProjectPath, _resetProjectPathCache } = await import('../../src/core/path-utils.js');

const mockExists = existsSync as unknown as ReturnType<typeof vi.fn>;

describe('resolveProjectPath', () => {
  const originalEnv = process.env.GODOT_PROJECT_PATH;

  beforeEach(() => {
    _resetProjectPathCache();
    delete process.env.GODOT_PROJECT_PATH;
    mockExists.mockReset();
  });

  afterEach(() => {
    if (originalEnv !== undefined) process.env.GODOT_PROJECT_PATH = originalEnv;
    else delete process.env.GODOT_PROJECT_PATH;
  });

  // T1: explicit path → use directly (no project.godot check at this layer)
  it('returns explicit path when provided', () => {
    const result = resolveProjectPath('/explicit/path');
    expect(result).toBe('/explicit/path');
    expect(mockExists).not.toHaveBeenCalled();
  });

  // T2: env var → use env value
  it('uses GODOT_PROJECT_PATH env when no explicit path', () => {
    process.env.GODOT_PROJECT_PATH = '/env/project';
    mockExists.mockReturnValue(true); // project.godot exists
    const result = resolveProjectPath();
    expect(result).toBe('/env/project');
  });

  // T2: env var points to invalid dir → warn, fall through to cwd search
  it('falls through to cwd search when env path lacks project.godot', () => {
    process.env.GODOT_PROJECT_PATH = '/bad/path';
    mockExists
      .mockReturnValueOnce(false) // /bad/path/project.godot
      .mockReturnValue(true);     // cwd search → true at some dir
    const result = resolveProjectPath();
    expect(result).toBeTruthy();
  });

  // T3: cwd upward search finds project.godot
  it('searches upward from cwd to find project.godot', () => {
    const originalCwd = process.cwd;
    process.cwd = () => '/a/b/c';
    const target = resolve('/a');
    mockExists.mockImplementation((p: string) => p === join(target, 'project.godot'));
    const result = resolveProjectPath();
    expect(result).toBe(target);
    process.cwd = originalCwd;
  });

  // T4: nothing found → returns undefined
  it('returns undefined when no path resolves', () => {
    mockExists.mockReturnValue(false);
    const result = resolveProjectPath();
    expect(result).toBeUndefined();
  });

  // T5: TTL cache — second call returns cached value
  it('caches result for 30s TTL', () => {
    process.env.GODOT_PROJECT_PATH = '/cached';
    mockExists.mockReturnValue(true);

    const first = resolveProjectPath();
    mockExists.mockClear();
    mockExists.mockReturnValue(false);
    const second = resolveProjectPath();

    expect(first).toBe('/cached');
    expect(second).toBe('/cached');
    expect(mockExists).not.toHaveBeenCalled();
  });

  // T5: cache expires after TTL
  it('re-resolves after TTL expires', () => {
    process.env.GODOT_PROJECT_PATH = '/cached';
    mockExists.mockReturnValue(true);

    resolveProjectPath(); // Populate cache

    vi.useFakeTimers();
    vi.advanceTimersByTime(301_000); // A-05: TTL changed from 30s to 5min

    mockExists.mockClear();
    mockExists.mockReturnValue(true);
    resolveProjectPath();

    expect(mockExists).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
