import { describe, it, expect } from 'vitest';
import { validateScreenshotAssertion } from '../../src/tools/workflow.js';

describe('validateScreenshotAssertion', () => {
  it('应验证有效的 screenshot_diff 断言', () => {
    const result = validateScreenshotAssertion({
      description: 'Main menu visible',
      type: 'screenshot_diff',
      expect_present: ['PlayButton', 'SettingsButton'],
    });
    expect(result.valid).toBe(true);
  });

  it('应拒绝缺少 description 的断言', () => {
    const result = validateScreenshotAssertion({
      type: 'screenshot_diff',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('description');
  });

  it('应接受仅检查截图成功的断言（无 expect_present）', () => {
    const result = validateScreenshotAssertion({
      description: 'Game running screenshot',
      type: 'screenshot_diff',
    });
    expect(result.valid).toBe(true);
  });
});
