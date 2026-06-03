import { expect } from 'vitest';
import {
  registerTools,
  clearRegistry,
  isReadOnly,
  isLongRunning,
  isKnownTool,
  getReadOnlyTools,
  getWriteTools,
  getAllToolNames,
  registerInlineTool,
} from '../src/core/tool-registry.js';
import { VERIFY_ELIGIBLE_TOOLS, isVerifyEligible } from '../src/core/tool-registry.js';

describe('tool-registry', () => {
  it('registers tools with tags', () => {
    clearRegistry();
    registerTools([
      { name: 'read_scene', readonly: true, long_running: false },
      { name: 'add_node', readonly: false, long_running: false },
      { name: 'nav_bake_mesh', readonly: false, long_running: true },
    ]);
    expect(isReadOnly('read_scene')).toBe(true);
    expect(isKnownTool('read_scene')).toBe(true);
    expect(isReadOnly('add_node')).toBe(false);
    expect(isKnownTool('add_node')).toBe(true);
    expect(isLongRunning('nav_bake_mesh')).toBe(true);
    expect(isLongRunning('add_node')).toBe(false);
  });

  it('unknown tools: isKnownTool=false, isReadOnly=false, isLongRunning=false', () => {
    expect(isKnownTool('nonexistent_tool')).toBe(false);
    expect(isReadOnly('nonexistent_tool')).toBe(false);
    expect(isLongRunning('nonexistent_tool')).toBe(false);
  });

  it('lists all readonly tools', () => {
    registerTools([
      { name: 'read_scene', readonly: true, long_running: false },
      { name: 'add_node', readonly: false, long_running: false },
      { name: 'get_project_info', readonly: true, long_running: false },
    ]);
    const ro = getReadOnlyTools();
    expect(ro.includes('read_scene')).toBeTruthy();
    expect(ro.includes('get_project_info')).toBeTruthy();
    expect(!ro.includes('add_node')).toBeTruthy();
  });

  it('lists all write tools', () => {
    registerTools([
      { name: 'read_scene', readonly: true, long_running: false },
      { name: 'add_node', readonly: false, long_running: false },
      { name: 'write_script', readonly: false, long_running: false },
    ]);
    const wr = getWriteTools();
    expect(wr.includes('add_node')).toBeTruthy();
    expect(wr.includes('write_script')).toBeTruthy();
    expect(!wr.includes('read_scene')).toBeTruthy();
  });

  it('getAllToolNames returns all registered names', () => {
    clearRegistry();
    registerTools([
      { name: 'a', readonly: true, long_running: false },
      { name: 'b', readonly: false, long_running: false },
    ]);
    const names = getAllToolNames();
    expect(names.sort()).toEqual(['a', 'b']);
  });
});

describe('L1 verify eligible tools', () => {
  it('VERIFY_ELIGIBLE_TOOLS contains merged tool names', () => {
    expect(VERIFY_ELIGIBLE_TOOLS.has('scene')).toBeTruthy();
    expect(VERIFY_ELIGIBLE_TOOLS.has('script')).toBeTruthy();
    expect(VERIFY_ELIGIBLE_TOOLS.has('ui')).toBeTruthy();
  });

  it('isVerifyEligible returns true for scene', () => {
    expect(isVerifyEligible('scene')).toBe(true);
  });

  it('isVerifyEligible returns false for non-eligible tools', () => {
    expect(isVerifyEligible('profiler')).toBe(false);
    expect(isVerifyEligible('physics')).toBe(false);
    expect(isVerifyEligible('docs')).toBe(false);
  });
});

describe('registerInlineTool', () => {
  afterEach(() => clearRegistry());

  it('registers an inline tool so isKnownTool returns true', () => {
    registerInlineTool('confirm_and_execute', { readonly: true, long_running: false });
    expect(isKnownTool('confirm_and_execute')).toBe(true);
  });

  it('registers readonly metadata correctly', () => {
    registerInlineTool('confirm_and_execute', { readonly: true, long_running: false });
    expect(isReadOnly('confirm_and_execute')).toBe(true);
    expect(isLongRunning('confirm_and_execute')).toBe(false);
  });

  it('appears in getAllToolNames and getReadOnlyTools', () => {
    registerInlineTool('confirm_and_execute', { readonly: true, long_running: false });
    expect(getAllToolNames()).toContain('confirm_and_execute');
    expect(getReadOnlyTools()).toContain('confirm_and_execute');
  });

  it('overwrites if called twice (idempotent)', () => {
    registerInlineTool('confirm_and_execute', { readonly: true, long_running: false });
    registerInlineTool('confirm_and_execute', { readonly: false, long_running: true });
    expect(isReadOnly('confirm_and_execute')).toBe(false);
    expect(isLongRunning('confirm_and_execute')).toBe(true);
  });
});
