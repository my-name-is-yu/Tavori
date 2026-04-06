import { EnvelopePriority } from '../types/envelope.js';

const PRIORITY_ORDER: EnvelopePriority[] = ['critical', 'high', 'normal', 'low'];

export class PriorityQueue<T> {
  private buckets: Map<EnvelopePriority, T[]>;

  constructor() {
    this.buckets = new Map([
      ['critical', []],
      ['high', []],
      ['normal', []],
      ['low', []],
    ]);
  }

  enqueue(item: T, priority: EnvelopePriority): void {
    this.buckets.get(priority)!.push(item);
  }

  dequeue(): T | undefined {
    for (const p of PRIORITY_ORDER) {
      const bucket = this.buckets.get(p)!;
      if (bucket.length > 0) return bucket.shift();
    }
    return undefined;
  }

  peek(): T | undefined {
    for (const p of PRIORITY_ORDER) {
      const bucket = this.buckets.get(p)!;
      if (bucket.length > 0) return bucket[0];
    }
    return undefined;
  }

  size(): number {
    let total = 0;
    for (const bucket of this.buckets.values()) total += bucket.length;
    return total;
  }

  sizeByPriority(): Record<EnvelopePriority, number> {
    return {
      critical: this.buckets.get('critical')!.length,
      high: this.buckets.get('high')!.length,
      normal: this.buckets.get('normal')!.length,
      low: this.buckets.get('low')!.length,
    };
  }

  clear(): void {
    for (const bucket of this.buckets.values()) bucket.length = 0;
  }

  drain(priority: EnvelopePriority): T[] {
    const bucket = this.buckets.get(priority)!;
    const items = [...bucket];
    bucket.length = 0;
    return items;
  }
}
