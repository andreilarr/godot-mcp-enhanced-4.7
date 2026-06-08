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
});
