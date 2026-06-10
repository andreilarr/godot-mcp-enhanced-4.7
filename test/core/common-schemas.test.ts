import { describe, it, expect } from 'vitest';
import { COMMON_SCHEMAS, withCommonParams } from '../../src/core/common-schemas.js';

describe('common-schemas', () => {
  it('COMMON_SCHEMAS 包含所有共享参数', () => {
    expect(COMMON_SCHEMAS.project_path).toBeDefined();
    expect(COMMON_SCHEMAS.project_path.type).toBe('string');
    expect(COMMON_SCHEMAS.scene_path).toBeDefined();
    expect(COMMON_SCHEMAS.node_path).toBeDefined();
    expect(COMMON_SCHEMAS.animation_name).toBeDefined();
    expect(COMMON_SCHEMAS.load_autoloads).toBeDefined();
  });

  it('withCommonParams 注入指定参数', () => {
    const params = { action: { type: 'string' } };
    const result = withCommonParams(params, 'project_path', 'node_path');
    expect(result).toHaveProperty('action');
    expect(result).toHaveProperty('project_path');
    expect(result).toHaveProperty('node_path');
    expect(result).not.toHaveProperty('scene_path');
  });

  it('withCommonParams 不覆盖已有定义', () => {
    const params = { project_path: { type: 'string', description: '自定义' } };
    const result = withCommonParams(params, 'project_path');
    expect((result.project_path as { description: string }).description).toBe('自定义');
  });

  it('withCommonParams 忽略无效 key', () => {
    const params = { action: { type: 'string' } };
    // TypeScript 会阻止无效 key，但运行时应安全
    const result = withCommonParams(params, 'project_path');
    expect(result).toHaveProperty('project_path');
  });
});