import { serverNowUs } from '@sonn-audio/node-sendspin';

/**
 * Per-client send-ahead backpressure model.
 *
 * The Sendspin spec says the server may send audio "as far ahead as the client's buffer
 * capacity allows". This tracks the bytes still in flight to one client (each frame drains
 * by its playback end-time in server clock) and computes how long to wait before the next
 * frame fits. It is purely per-client state: every {@link SendspinClientSender} owns its
 * own gate so a slow client (e.g. a Pi Zero subwoofer) can never throttle the others —
 * synchronisation is carried by the shared frame timestamps, not by this pacing.
 *
 * Extracted verbatim from the single-client send loop in `SendspinOutput.startStream`; the
 * math is unchanged.
 */
export class ClientCapacityGate {
  private readonly buffered: Array<{ endUs: number; byteCount: number }> = [];
  private bufferedBytes = 0;

  constructor(private readonly capacityBytes: number) {}

  private prune(nowUs: number): void {
    while (this.buffered.length && this.buffered[0]!.endUs <= nowUs) {
      const removed = this.buffered.shift();
      if (removed) {
        this.bufferedBytes -= removed.byteCount;
      }
    }
    if (this.bufferedBytes < 0) {
      this.bufferedBytes = 0;
    }
  }

  /** Microseconds to wait before `bytesNeeded` more bytes fit within the client buffer. */
  public timeUntilCapacityUs(bytesNeeded: number): number {
    if (this.capacityBytes <= 0 || bytesNeeded <= 0 || bytesNeeded >= this.capacityBytes) {
      return 0;
    }
    const nowUs = serverNowUs();
    this.prune(nowUs);
    let virtualBytes = this.bufferedBytes;
    let cursorTimeUs = nowUs;
    let waitUs = 0;
    for (const chunk of this.buffered) {
      if (virtualBytes + bytesNeeded <= this.capacityBytes) {
        break;
      }
      waitUs += Math.max(0, chunk.endUs - cursorTimeUs);
      cursorTimeUs = chunk.endUs;
      virtualBytes = Math.max(0, virtualBytes - chunk.byteCount);
    }
    return waitUs;
  }

  /** Block until `bytesNeeded` more bytes fit within the client's buffer capacity. */
  public async waitForCapacity(bytesNeeded: number): Promise<void> {
    if (this.capacityBytes <= 0 || bytesNeeded <= 0) {
      return;
    }
    while (true) {
      const waitUs = this.timeUntilCapacityUs(bytesNeeded);
      if (waitUs <= 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.ceil(waitUs / 1000))));
    }
  }

  /** Record a frame as in flight: `byteCount` bytes that drain by `endUs` (server time). */
  public register(endUs: number, byteCount: number): void {
    if (this.capacityBytes <= 0 || byteCount <= 0) {
      return;
    }
    this.buffered.push({ endUs, byteCount });
    this.bufferedBytes += byteCount;
  }

  /** Shift all in-flight frame end-times by `deltaUs` (used when the timeline re-anchors). */
  public shift(deltaUs: number): void {
    for (let i = 0; i < this.buffered.length; i += 1) {
      const entry = this.buffered[i]!;
      this.buffered[i] = { endUs: entry.endUs + deltaUs, byteCount: entry.byteCount };
    }
  }
}
