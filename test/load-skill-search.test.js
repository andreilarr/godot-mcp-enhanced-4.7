import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { searchSkills } from '../src/tools/load-skill-search.js';

describe('load-skill-search', () => {
  let libDir;

  beforeAll(async () => {
    libDir = await mkdtemp(join(tmpdir(), 'skill-lib-'));
    // GodotPrompter 风格: skills/<name>/SKILL.md
    await mkdir(join(libDir, 'skills', 'platformer-movement'), { recursive: true });
    await writeFile(
      join(libDir, 'skills', 'platformer-movement', 'SKILL.md'),
      '---\nname: platformer-movement\ndescription: Platformer jump and coyote time\n---\n# Platformer Movement\nUse coyote time for forgiving jumps.'
    );
    // gd-agentic 风格: references/*.md (无 frontmatter)
    await mkdir(join(libDir, 'references'), { recursive: true });
    await writeFile(
      join(libDir, 'references', 'never-rules.md'),
      '# NEVER Rules\n\nNever read input in _process. Use _unhandled_input.'
    );
  });

  afterAll(async () => {
    await rm(libDir, { recursive: true, force: true });
  });

  it('L1a 高精度: query 词命中 name/description', async () => {
    const { matches } = await searchSkills([libDir], 'platformer coyote');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].name).toBe('platformer-movement');
    expect(matches[0].score).toBeGreaterThan(0.5);
  });

  it('L1b 全文 fallback: 无 name/desc 命中时匹配正文', async () => {
    const { matches } = await searchSkills([libDir], 'unhandled_input');
    const names = matches.map(m => m.name);
    expect(names).toContain('never-rules'); // 正文含 "unhandled_input"
  });

  it('L7 结果按 score 降序', async () => {
    const { matches } = await searchSkills([libDir], 'coyote');
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1].score).toBeGreaterThanOrEqual(matches[i].score);
    }
  });

  it('L4 source/path 标注', async () => {
    const { matches } = await searchSkills([libDir], 'platformer');
    expect(matches[0].source).toBe(require('path').basename(libDir));
    expect(matches[0].path).toContain('platformer-movement');
  });

  it('无匹配返回空 matches', async () => {
    const { matches } = await searchSkills([libDir], 'zzz_no_such_term_zzz');
    expect(matches).toEqual([]);
  });

  it('L6 缺失目录进 missing,不抛错', async () => {
    const { matches, missing } = await searchSkills(
      [join(libDir, 'does-not-exist')], 'test'
    );
    expect(matches).toEqual([]);
    expect(missing.length).toBe(1);
    expect(missing[0].reason).toMatch(/not found|traversal|not absolute/);
  });

  it('limit 截断结果数', async () => {
    const { matches } = await searchSkills([libDir], 'coyote', 1);
    expect(matches.length).toBeLessThanOrEqual(1);
  });
});