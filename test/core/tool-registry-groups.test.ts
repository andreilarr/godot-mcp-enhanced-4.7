// test/core/tool-registry-groups.test.ts
import { describe, it, expect } from 'vitest';
import {
  TOOL_GROUPS,
  PROFILES,
  expandGroups,
  resolveProfile,
} from '../../src/core/tool-registry.js';

describe('TOOL_GROUPS enhanced', () => {
  it('each group has description, tools, requires, protected fields', () => {
    for (const [name, group] of Object.entries(TOOL_GROUPS)) {
      expect(group).toHaveProperty('description');
      expect(group).toHaveProperty('tools');
      expect(group).toHaveProperty('requires');
      expect(Array.isArray(group.requires)).toBe(true);
      if (name === 'core') {
        expect(group.protected).toBe(true);
      }
    }
  });

  it('core group is protected', () => {
    expect(TOOL_GROUPS.core.protected).toBe(true);
  });

  it('bridge group requires bridge connection', () => {
    expect(TOOL_GROUPS.bridge.requires).toContain('bridge');
  });

  it('recording group requires bridge connection', () => {
    expect(TOOL_GROUPS.recording.requires).toContain('bridge');
  });

  it('editor group requires editor connection', () => {
    expect(TOOL_GROUPS.editor.requires).toContain('editor');
  });
});
