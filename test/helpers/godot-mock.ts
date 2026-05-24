/**
 * Godot executor mock for integration tests.
 *
 * vi.mock() is hoisted to module top by Vitest, so the factory closure
 * runs before any test code. Use vi.mocked().mockResolvedValueOnce()
 * in individual tests to override the default behavior.
 *
 * Note: vi.mock() paths are relative to THIS file (test/helpers/).
 */

// Top-level mock declaration — hoisted by Vitest
vi.mock('../../build/gdscript-executor.js', () => ({
  executeGdscript: vi.fn(() => Promise.resolve({
    success: true,
    compile_success: true,
    compile_error: '',
    errors: [],
    run_success: true,
    run_error: '',
    outputs: [],
    raw_output: '',
    duration_ms: 100,
  })),
  parseMcpMarkers: vi.fn((raw: string) => ({
    parsed: null,
    logLines: raw.split('\n').map((l: string) => l.trim()).filter(Boolean),
  })),
}));

// Re-export mock references so tests can override per-test
export { executeGdscript, parseMcpMarkers } from '../../build/gdscript-executor.js';
