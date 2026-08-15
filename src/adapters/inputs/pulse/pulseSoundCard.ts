import net from 'node:net';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createLogger } from '@/shared/logging/logger';
import { resolveDataDir } from '@/shared/utils/file';
import {
  frame,
  frameSize,
  PA,
  PA_CHANNEL_COMMAND,
  PA_PROTOCOL_VERSION,
  TagReader,
  TagWriter,
  type SampleSpec,
} from '@/adapters/inputs/pulse/pulseProtocol';

/**
 * A sound card, in this process.
 *
 * Plenty of programs can only play to a sound card — Spotify's Soloist is the first here, but any
 * Linux audio application is the same story — and the usual answer is to run a sound server and
 * arrange for a sink that writes somewhere we can read. That costs a 207 MB dependency, a daemon
 * that refuses to start whenever another one holds its D-Bus name, and a pipe that keeps a quarter
 * second of the previous track between one song and the next.
 *
 * This is the same idea without the middleman. Such programs reach PulseAudio through `libpulse`,
 * which connects to whatever `PULSE_SERVER` names, and what it finds there is this: the decoded
 * audio arrives in this process directly, in whatever format the program chose. Because a client
 * may only send what it has been granted, the reader is the clock — no timer, no resampling, and
 * nothing between the decoder and the engine.
 *
 * One socket per caller, so two players cannot be confused with one another.
 */
export class PulseSoundCard {
  private readonly log = createLogger('Audio', 'PulseCard');
  private readonly cards = new Map<number, CardSocket>();
  private clientConfigWritten: Promise<string> | null = null;

  /** Where the sockets live. Short paths matter: a unix socket path is capped near 100 bytes. */
  private get runtimeDir(): string {
    return resolveDataDir('pulse');
  }

  private socketPathFor(id: number): string {
    return path.join(this.runtimeDir, `card-${id}.sock`);
  }

  /**
   * A client config that turns shared memory off.
   *
   * libpulse would otherwise hand audio over in shared memory segments, which is faster than a
   * socket and far more protocol than this needs. Refused in the handshake it falls back to the
   * socket, but saying so here as well keeps the client from preparing for it at all.
   */
  private async clientConfigPath(): Promise<string> {
    this.clientConfigWritten ??= (async () => {
      const file = path.join(this.runtimeDir, 'client.conf');
      await fsp.mkdir(this.runtimeDir, { recursive: true });
      await fsp.writeFile(file, 'enable-shm = no\nautospawn = no\n', 'utf8');
      return file;
    })();
    return this.clientConfigWritten;
  }

  /** Start listening for this caller's player. Idempotent. */
  public async ensure(id: number): Promise<boolean> {
    if (this.cards.has(id)) {
      return true;
    }
    const socketPath = this.socketPathFor(id);
    try {
      await fsp.mkdir(this.runtimeDir, { recursive: true });
      // A socket file left by a previous run is dead but still occupies the name.
      await fsp.rm(socketPath, { force: true });
      const card = new CardSocket(id, socketPath, this.log);
      await card.listen();
      this.cards.set(id, card);
      return true;
    } catch (error) {
      this.log.warn('could not open an audio socket', {
        id,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** What a player needs in its environment to find this card and nothing else. */
  public async childEnv(id: number): Promise<Record<string, string>> {
    return {
      PULSE_SERVER: `unix:${this.socketPathFor(id)}`,
      PULSE_CLIENTCONFIG: await this.clientConfigPath(),
    };
  }

  /**
   * Take the audio this card is receiving, as a stream.
   *
   * Handing out a fresh stream per track mirrors what a track change means to the engine: the old
   * one ends, and nothing of the previous track can arrive on the new one.
   */
  public takeStream(id: number): Readable | null {
    return this.cards.get(id)?.takeStream() ?? null;
  }

  /**
   * What comes out of this card, once the player has said what it plays.
   *
   * Not always what the player sends: a decoder hands over float, and float cannot reach a 24-bit
   * output without something converting it. That something used to be PulseAudio's own sink, and
   * it is this card now — see `deliveredSpecOf`.
   */
  public specFor(id: number): SampleSpec | null {
    const spec = this.cards.get(id)?.spec;
    return spec ? deliveredSpecOf(spec) : null;
  }

  /**
   * Wait until the player has opened its stream and said what it is playing.
   *
   * Only the first track of a session ever waits: the client opens one stream and keeps it, so
   * afterwards the answer is already there. Without it, the first play of a fresh server asked for
   * a format nobody had stated yet and the caller refused to start.
   */
  public async waitForSpec(id: number, timeoutMs = 5_000): Promise<SampleSpec | null> {
    return this.cards.get(id)?.waitForSpec(timeoutMs) ?? null;
  }

  /** Throw away audio that arrived for a track this server has already finished with. */
  public discardPending(id: number): void {
    this.cards.get(id)?.discardPending();
  }

  public async remove(id: number): Promise<void> {
    const card = this.cards.get(id);
    if (!card) {
      return;
    }
    this.cards.delete(id);
    await card.close();
  }

  public async stop(): Promise<void> {
    const cards = [...this.cards.values()];
    this.cards.clear();
    await Promise.all(cards.map((card) => card.close()));
  }
}

/**
 * What a card hands on, given what the player sends it.
 *
 * Float is how a decoder thinks and not how anything downstream takes it: no output declares a
 * 32-bit format, and an engine asked to carry float has to convert it somewhere. Converting here
 * is what a sound card does — the old PulseAudio sink was pinned to 24-bit for exactly this — and
 * it is what lets everything after this point match the samples it is given instead of resampling
 * them into the shape they were already in.
 */
export function deliveredSpecOf(spec: SampleSpec): SampleSpec {
  return spec.format.startsWith('f') ? { ...spec, format: 's24le' } : spec;
}

/**
 * Float samples into 24-bit words.
 *
 * Rounded rather than truncated, and clamped: Spotify's own normalisation can push a peak past
 * full scale, and wrapping that would be a click where clipping is merely loud.
 */
export function floatToS24(chunk: Buffer): Buffer {
  const samples = Math.floor(chunk.length / 4);
  const out = Buffer.allocUnsafe(samples * 3);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.max(-1, Math.min(1, chunk.readFloatLE(i * 4)));
    const scaled = Math.round(value * 8388607);
    out.writeUIntLE(scaled < 0 ? scaled + 0x1000000 : scaled, i * 3, 3);
  }
  return out;
}

/** How much audio a client may run ahead of us. One second is what a sound card would offer. */
const TARGET_BUFFER_SEC = 1;
/** Never ask for less than this at a time; a stream of tiny grants is all overhead. */
const MIN_REQUEST_SEC = 0.125;

/** One card: its socket, the player on it, and the stream its audio is going to. */
class CardSocket {
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private stream: CardStream | null = null;
  /** Bytes promised to the client and not yet arrived. */
  private granted = 0;
  private streamIndex = 0;
  private corked = true;
  private written = 0;
  /**
   * Audio that arrived before anyone took a stream.
   *
   * A player starts sounding a moment before this server has asked for the stream, and those first
   * frames are the start of the track. Holding them is what keeps a song from starting clipped.
   */
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private specWaiters: Array<(spec: SampleSpec | null) => void> = [];
  public spec: SampleSpec | null = null;

  constructor(
    private readonly id: number,
    private readonly socketPath: string,
    private readonly log: ReturnType<typeof createLogger>,
  ) {}

  public listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.onClient(socket));
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        this.server = server;
        this.log.debug('sound card listening', { id: this.id, socket: this.socketPath });
        resolve();
      });
    });
  }

  public waitForSpec(timeoutMs: number): Promise<SampleSpec | null> {
    if (this.spec) {
      return Promise.resolve(this.spec);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.specWaiters = this.specWaiters.filter((w) => w !== waiter);
        resolve(null);
      }, timeoutMs);
      const waiter = (spec: SampleSpec | null): void => {
        clearTimeout(timer);
        resolve(spec);
      };
      this.specWaiters.push(waiter);
    });
  }

  public discardPending(): void {
    this.pending = [];
    this.pendingBytes = 0;
  }

  public takeStream(): Readable {
    this.stream?.destroy();
    // A Readable of our own rather than a PassThrough, because `_read` is the signal that matters:
    // it fires whenever the consumer wants more, including the moment it comes back after the
    // engine has restarted a session. Hanging the credit on writes and drains instead left the
    // player waiting through exactly that gap — the room fell silent until something happened to
    // set it going again.
    const stream = new CardStream(() => this.grant());
    this.stream = stream;
    for (const chunk of this.pending) {
      stream.feed(chunk);
    }
    this.discardPending();
    return stream;
  }

  public async close(): Promise<void> {
    this.stream?.destroy();
    this.stream = null;
    this.socket?.destroy();
    this.socket = null;
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      this.server = null;
    });
    await fsp.rm(this.socketPath, { force: true }).catch(() => undefined);
  }

  private onClient(socket: net.Socket): void {
    // One player per card, so a second connection means the first is gone.
    this.socket?.destroy();
    this.socket = socket;
    this.granted = 0;
    this.corked = true;
    let version = PA_PROTOCOL_VERSION;
    let buffered = Buffer.alloc(0);

    const send = (payload: Buffer): void => {
      socket.write(frame(PA_CHANNEL_COMMAND, payload));
    };
    const reply = (tag: number, body: TagWriter = new TagWriter()): void => {
      send(Buffer.concat([new TagWriter().u32(PA.REPLY).u32(tag).build(), body.build()]));
    };

    socket.on('error', (error) => {
      this.log.debug('audio client disconnected', { id: this.id, message: error.message });
    });
    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = null;
      }
    });

    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (buffered.length < 20) {
          return;
        }
        const length = buffered.readUInt32BE(0);
        const channel = buffered.readUInt32BE(4);
        if (buffered.length < 20 + length) {
          return;
        }
        const payload = buffered.subarray(20, 20 + length);
        buffered = buffered.subarray(20 + length);

        if (channel !== PA_CHANNEL_COMMAND) {
          this.onAudio(payload);
          continue;
        }
        try {
          const reader = new TagReader(payload);
          const command = reader.next() as number;
          const tag = reader.next() as number;
          version = this.onCommand(command, tag, reader, version, reply, send);
        } catch (error) {
          this.log.warn('could not read an audio command', {
            id: this.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });
  }

  /** Audio. The whole point: decoded Spotify, straight into this process. */
  private onAudio(chunk: Buffer): void {
    this.granted = Math.max(0, this.granted - chunk.length);
    this.written += chunk.length;
    const stream = this.stream;
    if (!stream || stream.destroyed) {
      // Nobody has taken this track's stream yet. A sound card would keep accepting audio — and so
      // do we, holding the last moment of it, because that moment is the start of the song. Older
      // than that is the previous track and is dropped.
      const converted = this.convert(chunk);
      this.pending.push(converted);
      this.pendingBytes += chunk.length;
      while (this.pendingBytes > this.maxPending()) {
        const dropped = this.pending.shift();
        this.pendingBytes -= dropped?.length ?? 0;
      }
      this.grant();
      return;
    }
    stream.feed(this.convert(chunk));
    this.grant();
  }

  /** Whatever arrives, in the shape this card hands on. */
  private convert(chunk: Buffer): Buffer {
    return this.spec?.format.startsWith('f') ? floatToS24(chunk) : chunk;
  }

  /** At most a second of audio may wait for a reader; beyond that it is not a start any more. */
  private maxPending(): number {
    const spec = this.spec;
    return spec ? spec.rate * frameSize(spec) : 512 * 1024;
  }

  /** Tell the player how much more it may send, counted from what we are still holding. */
  private grant(): void {
    const socket = this.socket;
    const spec = this.spec;
    if (!socket || !spec || this.corked) {
      return;
    }
    const bytesPerSec = spec.rate * frameSize(spec);
    const target = Math.round(bytesPerSec * TARGET_BUFFER_SEC);
    // Counted in what the player sends, not in what we hand on: those differ once float is being
    // converted, and credit is a promise made to the player in its own units.
    const asSent = frameSize(spec) / frameSize(deliveredSpecOf(spec));
    const held =
      (this.stream && !this.stream.destroyed ? this.stream.readableLength * asSent : 0) +
      this.pendingBytes;
    // One bound only: how much audio we are willing to be holding. Pacing by wall clock as well
    // was tried and made things worse — a session restart reads nothing for a moment, the clock
    // keeps running, and what follows is a burst and then a starved reader, which is a stutter.
    // The engine sets the tempo, as it does for every other pipe source; this keeps the buffer
    // shallow and lets it.
    const want = target - held - this.granted;
    if (want < Math.round(bytesPerSec * MIN_REQUEST_SEC)) {
      return;
    }
    const ask = want - (want % frameSize(spec));
    this.granted += ask;
    socket.write(
      frame(PA_CHANNEL_COMMAND, new TagWriter().u32(PA.REQUEST).u32(0xffffffff).u32(this.streamIndex).u32(ask).build()),
    );
  }

  private onCommand(
    command: number,
    tag: number,
    reader: TagReader,
    version: number,
    reply: (tag: number, body?: TagWriter) => void,
    send: (payload: Buffer) => void,
  ): number {
    switch (command) {
      case PA.AUTH: {
        const remote = reader.next() as number;
        const negotiated = Math.min(PA_PROTOCOL_VERSION, remote & 0xffff);
        this.log.debug('audio client connected', { id: this.id, clientVersion: remote & 0xffff });
        // No flags in the answer: no shared memory, no memfd, so the audio comes over the socket.
        reply(tag, new TagWriter().u32(negotiated));
        return negotiated;
      }
      case PA.SET_CLIENT_NAME: {
        reply(tag, version >= 13 ? new TagWriter().u32(1) : new TagWriter());
        return version;
      }
      case PA.GET_SERVER_INFO: {
        const spec = this.spec ?? { format: 'f32le', channels: 2, rate: 44100 };
        const body = new TagWriter()
          .str('sonn')
          .str('15.0')
          .str('sonn')
          .str('sonn')
          .sampleSpec(spec)
          .str(SINK_NAME)
          .str(`${SINK_NAME}.monitor`)
          .u32(0);
        if (version >= 15) {
          body.channelMap(spec.channels);
        }
        reply(tag, body);
        return version;
      }
      case PA.GET_SINK_INFO:
      case PA.GET_SINK_INFO_LIST: {
        reply(tag, this.sinkInfo(version));
        return version;
      }
      case PA.LOOKUP_SINK: {
        reply(tag, new TagWriter().u32(0));
        return version;
      }
      case PA.GET_SOURCE_INFO_LIST: {
        reply(tag);
        return version;
      }
      case PA.CREATE_PLAYBACK_STREAM: {
        const spec = reader.next() as SampleSpec;
        reader.next(); // channel map
        reader.next(); // sink index
        reader.next(); // sink name
        const maxlength = reader.next() as number;
        const corked = reader.next() as boolean;
        reader.next(); // tlength, ours to decide
        const prebuf = reader.next() as number;
        reader.next(); // minreq, ours to decide

        this.spec = spec;
        for (const waiter of this.specWaiters.splice(0)) {
          waiter(spec);
        }
        this.corked = corked;
        this.granted = 0;
        this.written = 0;
        const bytesPerSec = spec.rate * frameSize(spec);
        const tlength = Math.round(bytesPerSec * TARGET_BUFFER_SEC);
        const minreq = Math.round(bytesPerSec * MIN_REQUEST_SEC);
        this.log.info('player opened a stream', {
          id: this.id,
          format: spec.format,
          rate: spec.rate,
          channels: spec.channels,
          corked,
        });

        // The reply's third field is the first grant; a corked stream gets nothing until it starts.
        const initial = corked ? 0 : tlength;
        this.granted = initial;
        const body = new TagWriter().u32(this.streamIndex).u32(this.streamIndex).u32(initial);
        if (version >= 9) {
          body
            .u32(maxlength === 0xffffffff ? 4 << 20 : maxlength)
            .u32(tlength)
            .u32(prebuf === 0xffffffff ? 0 : prebuf)
            .u32(minreq);
        }
        if (version >= 12) {
          body.sampleSpec(spec).channelMap(spec.channels).u32(0).str(SINK_NAME).bool(false);
        }
        if (version >= 13) {
          body.usec(Math.round(TARGET_BUFFER_SEC * 1e6));
        }
        reply(tag, body);
        return version;
      }
      case PA.CORK_PLAYBACK_STREAM: {
        reader.next(); // stream index; there is only one
        const corked = reader.next() as boolean;
        this.corked = corked;
        reply(tag);
        if (!corked) {
          send(new TagWriter().u32(PA.STARTED).u32(0xffffffff).u32(this.streamIndex).build());
          this.grant();
        }
        return version;
      }
      case PA.GET_PLAYBACK_LATENCY: {
        const spec = this.spec ?? DEFAULT_SPEC;
        const bytesPerSec = spec.rate * frameSize(spec);
        const held = this.stream && !this.stream.destroyed ? this.stream.readableLength : 0;
        // What we are still holding is exactly how far behind the sound is; saying so is what keeps
        // the player's own position honest.
        const body = new TagWriter()
          .usec((held / bytesPerSec) * 1e6)
          .usec(0)
          .bool(!this.corked)
          .timeval()
          .timeval()
          .s64(this.written)
          .s64(Math.max(0, this.written - held));
        if (version >= 13) {
          body.u64(0).u64((this.written / bytesPerSec) * 1e6);
        }
        reply(tag, body);
        return version;
      }
      case PA.FLUSH_PLAYBACK_STREAM: {
        this.granted = 0;
        reply(tag);
        return version;
      }
      case PA.DELETE_PLAYBACK_STREAM: {
        this.corked = true;
        this.granted = 0;
        reply(tag);
        return version;
      }
      case PA.STAT: {
        reply(tag, new TagWriter().u32(0).u32(0).u32(0).u32(0).u32(0));
        return version;
      }
      case PA.DRAIN_PLAYBACK_STREAM:
      case PA.TRIGGER_PLAYBACK_STREAM:
      case PA.UPDATE_PLAYBACK_STREAM_PROPLIST:
      case PA.SET_STREAM_BUFFER_ATTR:
      case PA.SET_SINK_INPUT_VOLUME:
      case PA.SET_SINK_INPUT_MUTE:
      case PA.SUBSCRIBE: {
        reply(tag);
        return version;
      }
      default: {
        this.log.debug('a player asked for something this sound card does not do', {
          id: this.id,
          command,
        });
        // 19 = not implemented. Refusing plainly beats leaving the client waiting for a reply.
        send(new TagWriter().u32(PA.ERROR).u32(tag).u32(19).build());
        return version;
      }
    }
  }

  private sinkInfo(version: number): TagWriter {
    const spec = this.spec ?? DEFAULT_SPEC;
    const body = new TagWriter()
      .u32(0)
      .str(SINK_NAME)
      .str(SINK_DESCRIPTION)
      .sampleSpec(spec)
      .channelMap(spec.channels)
      .u32(0xffffffff)
      .cvolume(spec.channels)
      .bool(false)
      .u32(0xffffffff)
      .str(null)
      .usec(Math.round(TARGET_BUFFER_SEC * 1e6))
      .str('sonn')
      .u32(0);
    if (version >= 13) {
      body.proplist({ 'device.description': SINK_DESCRIPTION }).usec(Math.round(TARGET_BUFFER_SEC * 1e6));
    }
    if (version >= 15) {
      // Base volume, state (0 = running), volume steps, and the card this belongs to — there is
      // none, so the invalid index. A string here instead of that index is what a client reads as
      // a broken reply, and it drops the whole connection rather than the one request.
      body.volume().u32(0).u32(0x10000).u32(0xffffffff);
    }
    return body;
  }
}

/**
 * The audio of one card, as a stream the engine can read.
 *
 * `_read` is the whole point: Node calls it whenever the consumer has room, which is the only
 * honest moment to let the player send more.
 */
class CardStream extends Readable {
  constructor(private readonly onWanted: () => void) {
    super({ highWaterMark: 256 * 1024 });
  }

  public override _read(): void {
    this.onWanted();
  }

  /**
   * Every read is a moment the buffer got smaller, and the only honest one to look again.
   *
   * `_read` alone is not enough. Node calls it once and then waits for a push before it will ask
   * again, so a card that answers "not yet, I am still holding a second" is never asked a second
   * time — and since the client may only send what it has been granted, no audio arrives to break
   * the tie either. The room simply stopped after one second. Reads always keep coming, so this is
   * where the credit is released.
   */
  public override read(size?: number): unknown {
    const chunk = super.read(size) as unknown;
    this.onWanted();
    return chunk;
  }

  /** Hand over audio as it arrives. Backpressure is expressed by granting, not by refusing. */
  public feed(chunk: Buffer): void {
    this.push(chunk);
  }
}

const SINK_NAME = 'sonn';
/** What this card says it is before a player has said what it wants. */
const DEFAULT_SPEC: SampleSpec = { format: 's24le', channels: 2, rate: 44100 };
const SINK_DESCRIPTION = 'Sonn';
