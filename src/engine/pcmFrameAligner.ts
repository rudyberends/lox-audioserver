/**
 * Buffers partial PCM frames so emitted chunks are always frame-aligned.
 *
 * Without this, a subscriber that attaches mid-stream can start at an
 * arbitrary byte offset, producing loud noise from misaligned sample
 * boundaries.
 */
export class PcmFrameAligner {
  private remainder: Buffer | null = null;
  private readonly frameBytes: number;

  constructor(channels: number, bitDepth: number) {
    this.frameBytes = Math.max(1, Math.round(channels * (bitDepth / 8)));
  }

  /** Returns the largest frame-aligned prefix, or null if no full frame is ready yet. */
  public align(chunk: Buffer): Buffer | null {
    const combined =
      this.remainder && this.remainder.length
        ? Buffer.concat([this.remainder, chunk], this.remainder.length + chunk.length)
        : chunk;
    const alignedLen = Math.floor(combined.length / this.frameBytes) * this.frameBytes;
    if (alignedLen <= 0) {
      this.remainder = Buffer.from(combined);
      return null;
    }
    const out = combined.subarray(0, alignedLen);
    const remLen = combined.length - alignedLen;
    this.remainder = remLen > 0 ? Buffer.from(combined.subarray(alignedLen)) : null;
    return out;
  }

  public reset(): void {
    this.remainder = null;
  }
}
