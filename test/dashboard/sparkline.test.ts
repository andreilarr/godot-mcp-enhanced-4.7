import { describe, it, expect } from 'vitest';
import { sparkline } from '../../src/dashboard/sparkline.js';

describe('sparkline', () => {
  it('should render empty data as empty string', () => {
    expect(sparkline([])).toBe('');
  });

  it('should render single value as full bar', () => {
    expect(sparkline([5])).toBe('█');
  });

  it('should render linear ramp', () => {
    const result = sparkline([0, 1, 2, 3, 4]);
    expect(result).toContain('▁');
    expect(result).toContain('█');
    expect(result.length).toBe(5);
  });

  it('should render all zeros as minimum bar', () => {
    const result = sparkline([0, 0, 0]);
    expect(result).toBe('▁▁▁');
  });

  it('should handle large dataset by sampling', () => {
    const data = Array.from({ length: 100 }, (_, i) => i);
    const result = sparkline(data, { maxWidth: 30 });
    expect(result.length).toBeLessThanOrEqual(30);
  });

  it('should preserve non-zero minimum offset', () => {
    const result = sparkline([10, 11, 12, 13, 14]);
    expect(result[0]).toBe('▁');
    expect(result[result.length - 1]).toBe('█');
  });

  it('should handle negative values', () => {
    const result = sparkline([-5, -3, -1, 0, 2]);
    expect(result[0]).toBe('▁');
    expect(result[result.length - 1]).toBe('█');
    expect(result.length).toBe(5);
  });

  it('should handle NaN values as minimum', () => {
    const result = sparkline([1, NaN, 3]);
    expect(result.length).toBe(3);
    expect(result[1]).toBe('▁');
  });

  it('should defensively downsample huge arrays (>10000)', () => {
    const data = Array.from({ length: 50000 }, (_, i) => i % 100);
    const result = sparkline(data);
    expect(result.length).toBeLessThanOrEqual(1000);
  });
});
