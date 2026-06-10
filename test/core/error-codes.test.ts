import { describe, it, expect } from 'vitest';
import { ErrorCodes } from '../../src/core/error-codes.js';

describe('ErrorCodes', () => {
  it('定义了所有必需的错误码', () => {
    expect(ErrorCodes.MISSING_ACTION).toBe('MISSING_ACTION');
    expect(ErrorCodes.UNKNOWN_ACTION).toBe('UNKNOWN_ACTION');
    expect(ErrorCodes.MISSING_REQUIRED_PARAM).toBe('MISSING_REQUIRED_PARAM');
    expect(ErrorCodes.HANDLER_ERROR).toBe('HANDLER_ERROR');
  });

  it('错误码值是字符串字面量', () => {
    const values = Object.values(ErrorCodes);
    for (const v of values) {
      expect(typeof v).toBe('string');
    }
  });
});