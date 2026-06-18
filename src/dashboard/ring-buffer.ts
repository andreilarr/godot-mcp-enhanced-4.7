/**
 * RingBuffer — 固定容量环形缓冲区，O(1) 插入。
 * 用于 Dashboard recentLogs 和 timeSeries（替代 Array.shift 的 O(n) 操作）。
 */
export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private size = 0;

  constructor(private capacity: number) {
    // ADVISORY-2: capacity<=0 会导致 % 0 → NaN 索引污染状态。当前调用点用常量 30/500
    // 不触发,但通用工具类必须有防御。
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`RingBuffer capacity must be a positive integer, got: ${capacity}`);
    }
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.size; i++) {
      const idx = (this.head - this.size + i + this.capacity) % this.capacity;
      const item = this.buffer[idx];
      if (item !== undefined) result.push(item);
    }
    return result;
  }

  get length(): number {
    return this.size;
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
    this.buffer = new Array(this.capacity);
  }
}
