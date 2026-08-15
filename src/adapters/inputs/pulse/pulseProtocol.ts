/**
 * The slice of PulseAudio's wire protocol needed to be a sound card for one client.
 *
 * Soloist plays to PulseAudio and nothing else — its binary carries exactly two audio drivers,
 * `PulseAudioDriver` and a no-op — and it reaches it through `libpulse.so.0`, which it dlopens and
 * points at whatever `PULSE_SERVER` names. So rather than run a sound server to own a FIFO for us,
 * this server *is* the sound card: the decoded audio arrives here directly.
 *
 * Everything is length-prefixed frames carrying a "tagstruct": a stream of values, each announced
 * by a one-byte tag. Commands and their field order come from PulseAudio's own
 * `pulsecore/native-common.h` and `protocol-native.c`.
 */

/** Commands, by their position in PulseAudio's own enum. Only the ones a player uses. */
export const PA = {
  ERROR: 0,
  REPLY: 2,
  CREATE_PLAYBACK_STREAM: 3,
  DELETE_PLAYBACK_STREAM: 4,
  AUTH: 8,
  SET_CLIENT_NAME: 9,
  LOOKUP_SINK: 10,
  DRAIN_PLAYBACK_STREAM: 12,
  STAT: 13,
  GET_PLAYBACK_LATENCY: 14,
  GET_SERVER_INFO: 20,
  GET_SINK_INFO: 21,
  GET_SINK_INFO_LIST: 22,
  GET_SOURCE_INFO_LIST: 24,
  GET_SINK_INPUT_INFO: 29,
  GET_SINK_INPUT_INFO_LIST: 30,
  SUBSCRIBE: 35,
  SET_SINK_INPUT_VOLUME: 37,
  SET_SINK_INPUT_MUTE: 39,
  CORK_PLAYBACK_STREAM: 41,
  FLUSH_PLAYBACK_STREAM: 42,
  TRIGGER_PLAYBACK_STREAM: 43,
  UPDATE_PLAYBACK_STREAM_PROPLIST: 81,
  SET_STREAM_BUFFER_ATTR: 79,
  /** Server to client: you may send this many more bytes. */
  REQUEST: 61,
  UNDERFLOW: 63,
  STARTED: 86,
} as const;

/**
 * The protocol version we answer with.
 *
 * 15 rather than the newest: the reply layouts grow with every version, and 15 is the first that
 * knows the 24-bit sample formats — below it a client asking for one is refused before it ever
 * reaches us. Nothing above it buys anything here, and each step costs fields to get right.
 */
export const PA_PROTOCOL_VERSION = 15;

/** `channel` in the frame header: this frame is a command rather than audio. */
export const PA_CHANNEL_COMMAND = 0xffffffff;

/** Sample formats, by their position in `pa_sample_format`. */
const SAMPLE_FORMATS: Record<number, string> = {
  0: 'u8',
  1: 'alaw',
  2: 'ulaw',
  3: 's16le',
  4: 's16be',
  5: 'f32le',
  6: 'f32be',
  7: 's32le',
  8: 's32be',
  9: 's24le',
  10: 's24be',
  11: 's24_32le',
  12: 's24_32be',
};

export type SampleSpec = { format: string; channels: number; rate: number };

/** What a sample format reads as when this card has never heard of it. */
export const UNKNOWN_FORMAT = 'invalid';

/**
 * Bytes one sample of each format occupies.
 *
 * Spelled out rather than read off the name. Guessing from the digits in the string gets `u8`
 * wrong, and a width that is wrong by a factor of four is a credit that is wrong by a factor of
 * four — the player is told it may send an amount of audio nobody asked for.
 */
const SAMPLE_WIDTHS: Record<string, number> = {
  u8: 1,
  alaw: 1,
  ulaw: 1,
  s16le: 2,
  s16be: 2,
  s24le: 3,
  s24be: 3,
  s24_32le: 4,
  s24_32be: 4,
  s32le: 4,
  s32be: 4,
  f32le: 4,
  f32be: 4,
};

/** Bytes one sample of this format occupies. */
export function sampleWidth(format: string): number {
  return SAMPLE_WIDTHS[format] ?? 4;
}

/** Bytes one frame of this spec occupies, which is how every credit here is counted. */
export function frameSize(spec: SampleSpec): number {
  return sampleWidth(spec.format) * spec.channels;
}

/**
 * The largest frame this card will assemble.
 *
 * A length is four bytes off a socket and nothing else vouches for it. Without a ceiling, one bad
 * number has this process waiting for four gigabytes that will never arrive, holding everything
 * that has arrived meanwhile. Far above any real write, so no player ever meets it.
 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * The socket's bytes, back into the frames they were sent as.
 *
 * Held as the list of reads it arrived in rather than one growing buffer. Joining the whole backlog
 * on every socket read copies what was already copied, once per read, and this is the path every
 * sample of every track travels.
 */
export class FrameSplitter {
  private chunks: Buffer[] = [];
  private total = 0;

  public push(chunk: Buffer): void {
    if (chunk.length === 0) {
      return;
    }
    this.chunks.push(chunk);
    this.total += chunk.length;
  }

  /** The next whole frame, or null while it is still arriving. */
  public next(): { channel: number; payload: Buffer } | null {
    const header = this.peek(20);
    if (!header) {
      return null;
    }
    const length = header.readUInt32BE(0);
    if (length > MAX_FRAME_BYTES) {
      throw new Error(`frame announced ${length} bytes, past anything a player sends`);
    }
    if (this.total < 20 + length) {
      return null;
    }
    const channel = header.readUInt32BE(4);
    this.take(20);
    return { channel, payload: this.take(length) };
  }

  /** The first `n` bytes, joining only as far as it takes to see them. */
  private peek(n: number): Buffer | null {
    if (this.total < n) {
      return null;
    }
    const head = this.chunks[0]!;
    if (head.length >= n) {
      return head.subarray(0, n);
    }
    const parts: Buffer[] = [];
    let have = 0;
    for (const chunk of this.chunks) {
      parts.push(chunk);
      have += chunk.length;
      if (have >= n) {
        break;
      }
    }
    return Buffer.concat(parts).subarray(0, n);
  }

  /** Remove and return the first `n` bytes; a frame inside one read costs no copy at all. */
  private take(n: number): Buffer {
    const parts: Buffer[] = [];
    let need = n;
    while (need > 0) {
      const head = this.chunks[0]!;
      if (head.length <= need) {
        parts.push(head);
        need -= head.length;
        this.chunks.shift();
      } else {
        parts.push(head.subarray(0, need));
        this.chunks[0] = head.subarray(need);
        need = 0;
      }
    }
    this.total -= n;
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
  }
}

/** Builds a tagstruct. Every method appends one value and returns `this`. */
export class TagWriter {
  private readonly parts: Buffer[] = [];

  private raw(buffer: Buffer): this {
    this.parts.push(buffer);
    return this;
  }

  public u32(value: number): this {
    const b = Buffer.alloc(5);
    b.write('L');
    b.writeUInt32BE(value >>> 0, 1);
    return this.raw(b);
  }

  public u8(value: number): this {
    const b = Buffer.alloc(2);
    b.write('B');
    b.writeUInt8(value, 1);
    return this.raw(b);
  }

  public u64(value: number): this {
    const b = Buffer.alloc(9);
    b.write('R');
    b.writeBigUInt64BE(BigInt(Math.max(0, Math.round(value))), 1);
    return this.raw(b);
  }

  public s64(value: number): this {
    const b = Buffer.alloc(9);
    b.write('r');
    b.writeBigInt64BE(BigInt(Math.round(value)), 1);
    return this.raw(b);
  }

  public usec(value: number): this {
    const b = Buffer.alloc(9);
    b.write('U');
    b.writeBigUInt64BE(BigInt(Math.max(0, Math.round(value))), 1);
    return this.raw(b);
  }

  public bool(value: boolean): this {
    return this.raw(Buffer.from(value ? '1' : '0'));
  }

  public str(value: string | null): this {
    if (value === null) {
      return this.raw(Buffer.from('N'));
    }
    return this.raw(Buffer.concat([Buffer.from('t'), Buffer.from(value, 'utf8'), Buffer.from([0])]));
  }

  public sampleSpec(spec: SampleSpec): this {
    const code = Number(
      Object.entries(SAMPLE_FORMATS).find(([, name]) => name === spec.format)?.[0] ?? 5,
    );
    const b = Buffer.alloc(7);
    b.write('a');
    b.writeUInt8(code, 1);
    b.writeUInt8(spec.channels, 2);
    b.writeUInt32BE(spec.rate, 3);
    return this.raw(b);
  }

  public channelMap(channels: number): this {
    const b = Buffer.alloc(2 + channels);
    b.write('m');
    b.writeUInt8(channels, 1);
    // 1 = front left, 2 = front right; anything beyond stereo simply counts on.
    for (let i = 0; i < channels; i += 1) {
      b.writeUInt8(i + 1, 2 + i);
    }
    return this.raw(b);
  }

  public cvolume(channels: number, volume = 0x10000): this {
    const b = Buffer.alloc(2 + 4 * channels);
    b.write('v');
    b.writeUInt8(channels, 1);
    for (let i = 0; i < channels; i += 1) {
      b.writeUInt32BE(volume, 2 + 4 * i);
    }
    return this.raw(b);
  }

  /** The same, when the channels are not all at one level. */
  public cvolumeOf(volumes: number[]): this {
    const b = Buffer.alloc(2 + 4 * volumes.length);
    b.write('v');
    b.writeUInt8(volumes.length, 1);
    volumes.forEach((volume, i) => b.writeUInt32BE(volume >>> 0, 2 + 4 * i));
    return this.raw(b);
  }

  public volume(value = 0x10000): this {
    const b = Buffer.alloc(5);
    b.write('V');
    b.writeUInt32BE(value, 1);
    return this.raw(b);
  }

  public timeval(): this {
    const now = Date.now();
    const b = Buffer.alloc(9);
    b.write('T');
    b.writeUInt32BE(Math.floor(now / 1000), 1);
    b.writeUInt32BE((now % 1000) * 1000, 5);
    return this.raw(b);
  }

  public proplist(entries: Record<string, string> = {}): this {
    this.raw(Buffer.from('P'));
    for (const [key, value] of Object.entries(entries)) {
      const encoded = Buffer.from(`${value}\0`);
      this.str(key).u32(encoded.length);
      const b = Buffer.alloc(5);
      b.write('x');
      b.writeUInt32BE(encoded.length, 1);
      this.raw(Buffer.concat([b, encoded]));
    }
    return this.str(null);
  }

  public build(): Buffer {
    return Buffer.concat(this.parts);
  }
}

/**
 * Reads a tagstruct.
 *
 * Values come back by tag rather than by an expected schema, so a request whose tail belongs to a
 * newer protocol version can simply be read past instead of having to be understood.
 */
export class TagReader {
  private offset = 0;

  constructor(private readonly buffer: Buffer) {}

  public get done(): boolean {
    return this.offset >= this.buffer.length;
  }

  public next(): unknown {
    const tag = String.fromCharCode(this.buffer[this.offset]!);
    this.offset += 1;
    switch (tag) {
      case 'L': {
        const value = this.buffer.readUInt32BE(this.offset);
        this.offset += 4;
        return value;
      }
      case 'B': {
        const value = this.buffer.readUInt8(this.offset);
        this.offset += 1;
        return value;
      }
      case 'R':
      case 'U': {
        const value = Number(this.buffer.readBigUInt64BE(this.offset));
        this.offset += 8;
        return value;
      }
      case 'r': {
        // Signed, and it means it: a stream's write index runs negative while a client is still
        // filling the buffer ahead of the first sample.
        const value = Number(this.buffer.readBigInt64BE(this.offset));
        this.offset += 8;
        return value;
      }
      case '1':
        return true;
      case '0':
        return false;
      case 'N':
        return null;
      case 't': {
        const end = this.buffer.indexOf(0, this.offset);
        const value = this.buffer.toString('utf8', this.offset, end);
        this.offset = end + 1;
        return value;
      }
      case 'a': {
        // A format nobody here knows is named as such rather than guessed at. Reading it as float
        // would hand the engine one byte pattern described as another, which is noise at full
        // scale — a stream is far better refused than accepted and mangled.
        const spec: SampleSpec = {
          format: SAMPLE_FORMATS[this.buffer[this.offset]!] ?? UNKNOWN_FORMAT,
          channels: this.buffer[this.offset + 1]!,
          rate: this.buffer.readUInt32BE(this.offset + 2),
        };
        this.offset += 6;
        return spec;
      }
      case 'm': {
        const count = this.buffer[this.offset]!;
        this.offset += 1 + count;
        return count;
      }
      case 'v': {
        // The levels themselves, not just how many: a client that sets a volume wants to read back
        // what it set, and skipping past them leaves nothing to answer with.
        const count = this.buffer[this.offset]!;
        const volumes: number[] = [];
        for (let i = 0; i < count; i += 1) {
          volumes.push(this.buffer.readUInt32BE(this.offset + 1 + 4 * i));
        }
        this.offset += 1 + 4 * count;
        return volumes;
      }
      case 'V': {
        const value = this.buffer.readUInt32BE(this.offset);
        this.offset += 4;
        return value;
      }
      case 'x': {
        const length = this.buffer.readUInt32BE(this.offset);
        const value = this.buffer.subarray(this.offset + 4, this.offset + 4 + length);
        this.offset += 4 + length;
        return value;
      }
      case 'T': {
        this.offset += 8;
        return 0;
      }
      case 'P': {
        const out: Record<string, string> = {};
        for (;;) {
          const key = this.next();
          if (key === null || typeof key !== 'string') {
            break;
          }
          this.next();
          const value = this.next();
          out[key] = Buffer.isBuffer(value) ? value.toString('utf8').replace(/\0$/, '') : String(value);
        }
        return out;
      }
      case 'f': {
        this.next();
        this.next();
        return null;
      }
      default:
        throw new Error(`unknown tag 0x${(this.buffer[this.offset - 1] ?? 0).toString(16)}`);
    }
  }
}

/** Wrap a payload in the 20-byte frame header every packet carries. */
export function frame(channel: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(20);
  header.writeUInt32BE(payload.length, 0);
  header.writeUInt32BE(channel >>> 0, 4);
  // offset (64 bit) and seek flags: only meaningful for rewriting a stream, which no player does.
  return Buffer.concat([header, payload]);
}
