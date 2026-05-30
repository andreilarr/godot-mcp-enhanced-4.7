import { describe, it, expect } from 'vitest';
import { PROJECT_TEMPLATES, getScaffoldFiles } from '../../src/tools/code-templates.js';

describe('PROJECT_TEMPLATES', () => {
  it('应定义 3 种模板类型', () => {
    expect(Object.keys(PROJECT_TEMPLATES)).toContain('2d-platformer');
    expect(Object.keys(PROJECT_TEMPLATES)).toContain('3d-fps');
    expect(Object.keys(PROJECT_TEMPLATES)).toContain('visual-novel');
  });

  it('每个模板应有 scenes 和 scripts 字段', () => {
    for (const [name, tmpl] of Object.entries(PROJECT_TEMPLATES)) {
      expect(tmpl.scenes.length, `${name} should have scenes`).toBeGreaterThan(0);
      expect(tmpl.scripts.length, `${name} should have scripts`).toBeGreaterThan(0);
    }
  });
});

describe('getScaffoldFiles', () => {
  it('应返回 2d-platformer 模板的文件列表', () => {
    const files = getScaffoldFiles('2d-platformer', 'MyGame');
    expect(files.length).toBeGreaterThan(0);
    // 应包含主场景
    const mainScene = files.find(f => f.path.includes('Level') || f.path.includes('main'));
    expect(mainScene).toBeDefined();
    // 应包含脚本
    const scriptFile = files.find(f => f.path.endsWith('.gd'));
    expect(scriptFile).toBeDefined();
  });

  it('对未知模板应返回空数组', () => {
    const files = getScaffoldFiles('unknown', 'Test');
    expect(files).toEqual([]);
  });
});
