import { describe, it, expect } from 'vitest';

// Mock dependencies that tool modules import
vi.mock('../../src/core/process-state.js', () => ({
  getRunningProcess: vi.fn().mockReturnValue(null),
  setRunningProcess: vi.fn(),
  getOutputBuffer: vi.fn().mockReturnValue([]),
  setOutputBuffer: vi.fn(),
  getProcessStartTime: vi.fn().mockReturnValue(0),
  setProcessStartTime: vi.fn(),
  getProjectDir: vi.fn().mockReturnValue(''),
  setProjectDir: vi.fn(),
}));

vi.mock('../../src/helpers.js', () => ({
  isPathInAllowedRoots: vi.fn().mockReturnValue(true),
  parseGodotConfig: vi.fn().mockReturnValue({}),
  requireProjectPath: vi.fn().mockReturnValue('/test'),
  validatePath: vi.fn((p) => p),
  buildSafeEnv: vi.fn().mockReturnValue({}),
  checkVersionMismatch: vi.fn(),
}));

vi.mock('../../src/core/logger.js', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    toolStart: vi.fn().mockReturnValue(0),
    toolEnd: vi.fn(),
  }),
}));

import { getAllToolDefinitions } from '../../src/core/tool-registry.js';

describe('Tool schema: project_path not required', () => {
  it('no tool has project_path in required array', () => {
    const tools = getAllToolDefinitions();
    const violations: string[] = [];
    for (const tool of tools) {
      const required = (tool.inputSchema as { required?: string[] }).required;
      if (required && required.includes('project_path')) {
        violations.push(tool.name);
      }
    }
    expect(violations).toEqual([]);
  });

  it('all tools that accept project_path have updated description', () => {
    const tools = getAllToolDefinitions();
    const violations: string[] = [];
    for (const tool of tools) {
      const props = (tool.inputSchema as { properties?: Record<string, { description?: string }> }).properties;
      if (props?.project_path) {
        const desc = props.project_path.description || '';
        if (!desc.includes('可选') && !desc.includes('optional')) {
          violations.push(tool.name);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});