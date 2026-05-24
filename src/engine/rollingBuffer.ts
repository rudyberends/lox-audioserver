/**
 * Rolling pre-buffer for late-joining subscribers.
 *
 * Two modes:
 *   - default: FIFO ring trimmed to maxBytes (drops oldest as new chunks arrive)
 *   - keepInitial: fills up to maxBytes once and stops; subsequent chunks are ignored
 *     (used for alert sources where the initial ~6s burst must survive the whole alert)
 */
export class RollingBuffer {
  private queue: Buffer[] = [];
  private byteCount = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly keepInitial: boolean,
  ) {}

  public push(chunk: Buffer): void {
    if (this.maxBytes <= 0 || !chunk?.length) {
      return;
    }

    if (this.keepInitial) {
      const remaining = this.maxBytes - this.byteCount;
      if (remaining <= 0) {
        return;
      }
      const toStore = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      this.queue.push(toStore);
      this.byteCount += toStore.length;
      return;
    }

    if (chunk.length >= this.maxBytes) {
      const tail = chunk.subarray(chunk.length - this.maxBytes);
      this.queue.length = 0;
      this.queue.push(tail);
      this.byteCount = tail.length;
      return;
    }

    this.queue.push(chunk);
    this.byteCount += chunk.length;
    while (this.byteCount > this.maxBytes && this.queue.length > 0) {
      const removed = this.queue.shift();
      if (!removed) {
        break;
      }
      this.byteCount -= removed.length;
    }
  }

  public snapshot(): readonly Buffer[] {
    return this.queue;
  }

  public firstChunk(): Buffer | undefined {
    return this.queue[0];
  }

  public clear(): void {
    this.queue.length = 0;
    this.byteCount = 0;
  }

  public get bytes(): number {
    return this.byteCount;
  }

  public get capacity(): number {
    return this.maxBytes;
  }
}
