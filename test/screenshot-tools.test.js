import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getToolDefinitions,
  handleTool,
  TOOL_META,
} from '../src/tools/screenshot.js';

// ─── Mock screenshot module ────────────────────────────────────────────────

vi.mock('../src/screenshot.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    captureScreenshot: vi.fn(async () => ({
      success: true,
      imagePath: '/tmp/test-screenshot.png',
      fileSize: 4096,
      width: 1280,
      height: 720,
    })),
  };
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCtx(overrides = {}) {
  return {
    opsScript: '/fake/ops.gd',
    findGodot: vi.fn(async () => '/usr/bin/godot'),
    runningProcess: null,
    setRunningProcess: vi.fn(),
    outputBuffer: [],
    setOutputBuffer: vi.fn(),
    processStartTime: 0,
    setProcessStartTime: vi.fn(),
    projectDir: '',
    setProjectDir: vi.fn(),
    parseGodotConfig: vi.fn(() => ({})),
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('screenshot-tools: getToolDefinitions', () => {
  it('returns 1 merged tool definition (screenshot)', () => {
    const defs = getToolDefinitions();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBe(1);
    expect(defs[0].name).toBe('screenshot');
  });

  it('action enum includes capture and analyze', () => {
    const defs = getToolDefinitions();
    const actionEnum = defs[0].inputSchema.properties.action.enum;
    expect(actionEnum).toContain('capture');
    expect(actionEnum).toContain('analyze');
  });

  it('tool has inputSchema with properties', () => {
    const defs = getToolDefinitions();
    const d = defs[0];
    expect(d.inputSchema).toBeDefined();
    expect(d.inputSchema.type).toBe('object');
    expect(d.inputSchema.properties).toBeDefined();
    expect(d.inputSchema.properties.action).toBeDefined();
  });
});

describe('screenshot-tools: TOOL_META', () => {
  it('has screenshot entry', () => {
    expect(Object.keys(TOOL_META).length).toBeGreaterThan(0);
    expect(TOOL_META.screenshot).toBeDefined();
  });

  it('screenshot tool is readonly', () => {
    expect(TOOL_META.screenshot).toBeDefined();
    expect(TOOL_META.screenshot.readonly).toBe(true);
    expect(TOOL_META.screenshot.long_running).toBe(false);
  });
});

describe('screenshot-tools: handleTool', () => {
  it('returns null for unknown tool', async () => {
    const result = await handleTool('unknown_screenshot_tool', {}, makeCtx());
    expect(result).toBeNull();
  });

  it('returns null for empty tool name', async () => {
    const result = await handleTool('', {}, makeCtx());
    expect(result).toBeNull();
  });

  it('handleTool for screenshot action=capture returns text result on success', async () => {
    const ctx = makeCtx();
    const result = await handleTool('screenshot', {
      project_path: '/tmp/test-project',
      action: 'capture',
    }, ctx);

    expect(result).not.toBeNull();
    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
    // Should contain text content about the screenshot
    const textContent = result.content.find(c => c.type === 'text');
    expect(textContent).toBeDefined();
    expect(textContent.text).toContain('Screenshot saved');
  });

  it('handleTool for screenshot action=analyze without image returns error text', async () => {
    const ctx = makeCtx();
    const result = await handleTool('screenshot', {
      action: 'analyze',
    }, ctx);

    expect(result).not.toBeNull();
    expect(result.content).toBeDefined();
    const textContent = result.content.find(c => c.type === 'text');
    expect(textContent).toBeDefined();
    // Without any path it should return an error message
    expect(textContent.text).toMatch(/error|Error|required|not found/i);
  });
});
