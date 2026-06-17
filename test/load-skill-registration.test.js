import { describe, it, expect } from 'vitest';
import {
  TOOL_GROUPS,
  isOfflineCapable,
  skipProjectPath,
  resolveProfile,
  clearRegistry,
  getAllToolNames,
} from '../src/core/tool-registry.js';
import { registerAllModules } from '../src/core/module-loader.js';

describe('load_skill registration', () => {
  it('TOOL_GROUPS.code 含 load_skill', () => {
    expect(TOOL_GROUPS.code.tools).toContain('load_skill');
  });

  it('resolveProfile(full) 含 load_skill', () => {
    expect(resolveProfile('full').has('load_skill')).toBe(true);
  });

  it('isOfflineCapable(load_skill) === true', () => {
    expect(isOfflineCapable('load_skill')).toBe(true);
  });

  it('skipProjectPath(load_skill) === true', () => {
    expect(skipProjectPath('load_skill')).toBe(true);
  });

  it('registerAllModules 后 getAllToolNames 含 load_skill', () => {
    clearRegistry();
    registerAllModules();
    expect(getAllToolNames()).toContain('load_skill');
  });
});
