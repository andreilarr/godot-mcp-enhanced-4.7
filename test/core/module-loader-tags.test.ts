// test/core/module-loader-tags.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

// Mock tool-registry to capture registered definitions while keeping TOOL_GROUPS
const capturedTools: Tool[] = [];
vi.mock('../../src/core/tool-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/tool-registry.js')>();
  return {
    ...actual,
    registerModule: vi.fn((mod: any) => {
      capturedTools.push(...mod.getToolDefinitions());
    }),
  };
});

import { registerAllModules } from '../../src/core/module-loader.js';

describe('Module loader tag injection', () => {
  beforeEach(() => {
    capturedTools.length = 0;
  });

  it('all registered tools have annotations.tags', () => {
    registerAllModules();
    const toolsWithoutTags = capturedTools.filter(
      t => !t.annotations?.tags || !Array.isArray(t.annotations.tags) || t.annotations.tags.length === 0
    );
    const missingNames = toolsWithoutTags.map(t => t.name);
    expect(missingNames, `Tools missing annotations.tags: ${missingNames.join(', ')}`).toEqual([]);
  });

  it('tags follow group:xxx format', () => {
    capturedTools.length = 0;
    registerAllModules();
    for (const tool of capturedTools) {
      const tags = tool.annotations?.tags as string[];
      if (tags) {
        for (const tag of tags) {
          expect(tag).toMatch(/^group:\w+$/);
        }
      }
    }
  });

  it('is idempotent — double registration does not wrap tags twice', () => {
    // registerAllModules already called by earlier tests in this describe block.
    // Calling it again should be a no-op thanks to the idempotency guard.
    // Verify capturedTools count does NOT double after a second call.
    const beforeCount = capturedTools.length;
    registerAllModules();
    expect(capturedTools.length).toBe(beforeCount);

    // Also verify tags have not been duplicated per tool.
    const tags = capturedTools.map(t => t.annotations?.tags as string[]);
    const hasDuplicate = tags.some(t => t && new Set(t).size !== t.length);
    expect(hasDuplicate, 'Some tools have duplicate tags after double registration').toBe(false);
  });

});
