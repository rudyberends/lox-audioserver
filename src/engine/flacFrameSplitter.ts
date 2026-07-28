/**
 * Splits a raw FLAC byte stream into individual frames.
 *
 * Why this exists: ffmpeg's stdout hands us arbitrary byte chunks, each holding
 * many FLAC frames. The sendspin protocol describes a binary audio message as
 * carrying "encoded audio frame" — singular — and libavcodec-based clients decode
 * one frame per packet, discarding the remainder.
 *
 * CURRENTLY UNREACHABLE FROM SENDSPIN. The sendspin output pins its codec to PCM
 * (see normalizeFormat) after FLAC proved audibly bad for reasons that were never
 * pinned down — the frames we emit are provably valid, yet the client failed to
 * decode nearly all of them. This splitter is kept because it is correct and
 * tested, and because one-frame-per-message is what the protocol describes, so it
 * is a prerequisite for any future FLAC attempt. It is not needed for the
 * HTTP-based FLAC outputs (squeezelite, Sonos), which stream bytes rather than
 * discrete frame messages.
 *
 * Frame boundaries are found by scanning for the 14-bit sync code and validating
 * the frame header's CRC-8. The CRC check is not optional: measured on a real
 * 24-bit/96 kHz stream, 107 of 1049 byte pairs matching the sync pattern were
 * audio data rather than frame headers (~10% false positives). Splitting on the
 * sync pattern alone would cut frames in half.
 */

/** Lowest and highest byte values for the 14-bit FLAC frame sync (0xFFF8–0xFFFB). */
const SYNC_HIGH = 0xff;
const SYNC_LOW_MIN = 0xf8;
const SYNC_LOW_MAX = 0xfb;

/** A FLAC frame header is 4 bytes minimum and at most 16 before its CRC-8 byte. */
const MIN_HEADER_BYTES = 4;
const MAX_HEADER_BYTES = 16;

/**
 * Guard against unbounded buffering when a stream turns out not to be FLAC (or
 * gets corrupted): if we cannot find a second frame boundary within this many
 * bytes, we stop holding data back and flush what we have.
 */
const MAX_PENDING_BYTES = 1024 * 1024;

/** CRC-8 with polynomial x^8+x^2+x^1+x^0 (0x07), as specified by FLAC. */
function crc8(buf: Buffer, start: number, end: number): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc ^= buf[i]!;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

/**
 * True when `offset` holds a FLAC frame header whose CRC-8 checks out. The header
 * length is variable (coded blocksize/samplerate and a UTF-8 frame number), so we
 * try every legal length and accept the first whose trailing byte matches.
 *
 * Returns false when there are not enough bytes yet to decide — the caller must
 * then wait for more data rather than treat the position as non-syncing.
 */
function isFrameHeaderAt(buf: Buffer, offset: number): boolean {
  if (offset + MIN_HEADER_BYTES >= buf.length) {
    return false;
  }
  if (buf[offset] !== SYNC_HIGH) {
    return false;
  }
  const low = buf[offset + 1]!;
  if (low < SYNC_LOW_MIN || low > SYNC_LOW_MAX) {
    return false;
  }
  const maxLen = Math.min(MAX_HEADER_BYTES, buf.length - offset - 1);
  for (let headerLen = MIN_HEADER_BYTES; headerLen <= maxLen; headerLen++) {
    if (crc8(buf, offset, offset + headerLen) === buf[offset + headerLen]) {
      return true;
    }
  }
  return false;
}

/** Finds the next validated frame header at or after `from`, or -1. */
function findFrameStart(buf: Buffer, from: number): number {
  for (let i = from; i + MIN_HEADER_BYTES < buf.length; i++) {
    if (buf[i] !== SYNC_HIGH) {
      continue;
    }
    const low = buf[i + 1]!;
    if (low < SYNC_LOW_MIN || low > SYNC_LOW_MAX) {
      continue;
    }
    if (isFrameHeaderAt(buf, i)) {
      return i;
    }
  }
  return -1;
}

/**
 * Stateful splitter for a single FLAC stream. Feed it the bytes that follow the
 * file header (STREAMINFO etc. must already be stripped by the caller and sent as
 * the codec header) and it yields whole frames.
 *
 * A frame is only emitted once the *next* frame's header is in hand, because FLAC
 * frames carry no length field — the boundary is only known by finding where the
 * next one starts. The final frame therefore stays pending until `flush()`.
 */
export class FlacFrameSplitter {
  private pending: Buffer = Buffer.alloc(0);
  /** Byte offset in `pending` of the current frame's start, once located. */
  private frameStart = -1;

  /**
   * Appends `chunk` and returns every complete frame that became available.
   * Frames are returned in stream order; the array is empty when a chunk merely
   * extends an incomplete frame.
   */
  public push(chunk: Buffer): Buffer[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const frames: Buffer[] = [];

    if (this.frameStart < 0) {
      this.frameStart = findFrameStart(this.pending, 0);
      if (this.frameStart < 0) {
        // No frame header yet. Don't buffer without bound if this isn't FLAC.
        if (this.pending.length > MAX_PENDING_BYTES) {
          frames.push(this.pending);
          this.pending = Buffer.alloc(0);
        }
        return frames;
      }
      if (this.frameStart > 0) {
        // Drop bytes before the first sync; they are not part of any frame.
        this.pending = this.pending.subarray(this.frameStart);
        this.frameStart = 0;
      }
    }

    // Emit each frame as soon as the following frame's header is found.
    for (;;) {
      const next = findFrameStart(this.pending, this.frameStart + MIN_HEADER_BYTES);
      if (next < 0) {
        break;
      }
      frames.push(this.pending.subarray(this.frameStart, next));
      this.pending = this.pending.subarray(next);
      this.frameStart = 0;
    }

    if (this.pending.length > MAX_PENDING_BYTES) {
      // A single frame this large means we lost sync; pass it through rather than
      // grow forever, and let the decoder resynchronise.
      frames.push(this.pending);
      this.pending = Buffer.alloc(0);
      this.frameStart = -1;
    }

    return frames;
  }

  /** Returns any buffered trailing frame. Call once the source stream has ended. */
  public flush(): Buffer[] {
    if (!this.pending.length) {
      return [];
    }
    const tail = this.pending;
    this.pending = Buffer.alloc(0);
    this.frameStart = -1;
    return [tail];
  }

  /** Bytes currently held back awaiting a frame boundary. */
  public get pendingBytes(): number {
    return this.pending.length;
  }
}
