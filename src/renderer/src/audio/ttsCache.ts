// Synthesis cache. The cafeteria pool is finite, so after one pass every quip is
// already an AudioBuffer and costs nothing to replay — only genuinely dynamic
// bubbles ever reach the model.

/** Collapse whitespace and case so "  Is it Pretzel Day? " hits one entry.
 *  Note the {god} token must already be substituted by the caller: two different
 *  coordinators say different words and must not share a clip. */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function cacheKey(voiceId: string, text: string, speed = 1): string {
  return `${voiceId}|${speed.toFixed(3)}|${normalizeText(text)}`;
}

/** Insertion-ordered Map used as an LRU: re-inserting on read moves an entry to
 *  the young end, so the first key iterated is always the least recently used. */
export class TtsCache<T> {
  private readonly map = new Map<string, T>();
  private totalBytes = 0;
  private readonly byteSize: (value: T) => number;
  private readonly maxBytes: number;

  constructor(private readonly capacity = 200, opts?: { maxBytes?: number; byteSize?: (value: T) => number }) {
    this.maxBytes = opts?.maxBytes ?? Number.POSITIVE_INFINITY;
    this.byteSize = opts?.byteSize ?? (() => 0);
  }

  get(key: string): T | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, value: T): void {
    const bytes = Math.max(0, this.byteSize(value));
    if (bytes > this.maxBytes) return;
    const old = this.map.get(key);
    if (old !== undefined) { this.map.delete(key); this.totalBytes -= Math.max(0, this.byteSize(old)); }
    this.map.set(key, value);
    this.totalBytes += bytes;
    while (this.map.size > this.capacity || this.totalBytes > this.maxBytes) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const evicted = this.map.get(oldest);
      this.map.delete(oldest);
      if (evicted !== undefined) this.totalBytes -= Math.max(0, this.byteSize(evicted));
    }
  }

  get size(): number {
    return this.map.size;
  }
}

/** Coalesces concurrent requests for the same key onto one synthesis. */
export class InFlight<T> {
  private readonly running = new Map<string, Promise<T>>();

  run(key: string, make: () => Promise<T>): Promise<T> {
    const existing = this.running.get(key);
    if (existing) return existing;
    const p = make().finally(() => this.running.delete(key));
    this.running.set(key, p);
    return p;
  }

  get pending(): number {
    return this.running.size;
  }
}
