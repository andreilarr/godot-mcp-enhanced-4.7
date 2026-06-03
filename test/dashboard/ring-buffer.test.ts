import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../../src/dashboard/ring-buffer.js';

describe('RingBuffer', () => {
  it('should push and retrieve items in order', () => {
    const buf = new RingBuffer<string>(3);
    buf.push('a');
    buf.push('b');
    buf.push('c');
    expect(buf.toArray()).toEqual(['a', 'b', 'c']);
    expect(buf.length).toBe(3);
  });

  it('should overwrite oldest item when full', () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4);
    expect(buf.toArray()).toEqual([2, 3, 4]);
    expect(buf.length).toBe(3);
  });

  it('should handle single capacity', () => {
    const buf = new RingBuffer<number>(1);
    buf.push(10);
    buf.push(20);
    expect(buf.toArray()).toEqual([20]);
    expect(buf.length).toBe(1);
  });

  it('should return empty array when nothing pushed', () => {
    const buf = new RingBuffer<number>(5);
    expect(buf.toArray()).toEqual([]);
    expect(buf.length).toBe(0);
  });

  it('should handle wrap-around multiple times', () => {
    const buf = new RingBuffer<number>(3);
    for (let i = 0; i < 10; i++) buf.push(i);
    expect(buf.toArray()).toEqual([7, 8, 9]);
    expect(buf.length).toBe(3);
  });

  it('should clear all items and reset length', () => {
    const buf = new RingBuffer<string>(5);
    buf.push('a');
    buf.push('b');
    buf.push('c');
    expect(buf.length).toBe(3);
    buf.clear();
    expect(buf.length).toBe(0);
    expect(buf.toArray()).toEqual([]);
    buf.push('d');
    expect(buf.toArray()).toEqual(['d']);
    expect(buf.length).toBe(1);
  });
});
