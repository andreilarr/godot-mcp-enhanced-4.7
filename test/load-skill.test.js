import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { getToolDefinitions, handleTool, TOOL_META } from '../src/tools/load-skill.js';

describe('load_skill tool', () => {
  let libDir;

  beforeAll(async () => {
    libDir = await mkdtemp(join(tmpdir(), 'skill-lib-'));
    await mkdir(join(libDir, 'skills', 'jump'), { recursive: true });
    await writeFile(
      join(libDir, 'skills', 'jump', 'SKILL.md'),
      '---\nname: jump\ndescription: Coyote time jump\n---\n# Jump\nAdd coyote time.'
    );
  });

  afterAll(async () => {
    await rm(libDir, { recursive: true, force: true });
  });

  it('getToolDefinitions 含 load_skill 且 query 必填', () => {
    const defs = getToolDefinitions();
    expect(defs.map(d => d.name)).toContain('load_skill');
    expect(defs[0].inputSchema.required).toContain('query');
  });

  it('TOOL_META.readonly === true', () => {
    expect(TOOL_META.load_skill).toBeDefined();
    expect(TOOL_META.load_skill.readonly).toBe(true);
  });

  it('handleTool 检索返回 matches(含 source+score)+ total_matches', async () => {
    const result = await handleTool('load_skill', { query: 'coyote', libraries: [libDir] }, {});
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total_matches).toBeGreaterThan(0);
    expect(parsed.matches[0].score).toBeGreaterThan(0);
    expect(parsed.matches[0].source).toBeDefined();
    expect(parsed.matches[0].path).toBeDefined();
  });

  it('L6 缺失库进 missing_libraries,不 isError', async () => {
    const result = await handleTool(
      'load_skill',
      { query: 'x', libraries: [join(libDir, 'nope')] },
      {}
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.missing_libraries.length).toBe(1);
  });

  it('空 query 返回 isError', async () => {
    const result = await handleTool('load_skill', { libraries: [libDir] }, {});
    expect(result.isError).toBe(true);
  });

  it('未知工具名返回 null', async () => {
    const result = await handleTool('not_load_skill', {}, {});
    expect(result).toBeNull();
  });
});