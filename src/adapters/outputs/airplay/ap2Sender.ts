import { randomBytes } from 'node:crypto';
import {
  AirPlayConnection,
  PtpEngine,
  RealtimeSender,
  createIdentity,
  setVolume as sendVolume,
  setupRealtimeStream,
  FRAMES_PER_PACKET,
  type SenderIdentity,
} from '@sonn-audio/node-airplay';
import { createLogger } from '@/shared/logging/logger';
import type { AirplaySender } from '@/adapters/outputs/airplay/airplaySender';

const SAMPLE_RATE = 44_100;
const BYTES_PER_FRAME = 4; // s16le stereo
const BYTES_PER_PACKET = FRAMES_PER_PACKET * BYTES_PER_FRAME;
/**
 * How far ahead of the render point audio is handed over. The receiver plays a
 * sample this long after we send it, so this single number is the output's
 * latency, the delay before the first sound, AND how much of the previous track
 * a skip still plays out (the realtime path has no device-side flush yet).
 *
 * The reference sender defaults to 2000 ms for resilience; that costs about six
 * seconds before a start is audible, which is not what this server's AirPlay
 * zones are tuned for — the RAOP path deliberately sits near 750 ms. The
 * receiver's own window bottoms out at latencyMin (11025 frames = 250 ms), so
 * 500 ms leaves headroom above the floor while keeping start and skip snappy.
 */
const LEAD_MS = 500;
/**
 * PCM buffered before the stream is set up. The receiver drops the control
 * channel when a stream SETUP is not followed promptly by audio, so the buffer
 * has to be filled BEFORE the session is built, never after (measured: four
 * seconds of silence between SETUP and the first packet ends the session, and
 * the sender keeps streaming into the void with nothing to show for it).
 */
const PRIME_MS = LEAD_MS + 250;
const SEND_TICK_MS = 4;
/**
 * Backpressure bounds. The engine produces faster than realtime, so without
 * these the ring simply grows — and everything in it is audio the listener has
 * to sit through before a skip is heard. Measured before this existed: a track
 * change kept playing the old track for the best part of ten seconds. Pause the
 * source above PAUSE_RING_BYTES, resume below RESUME_RING_BYTES; MAX_RING_BYTES
 * is only a last-resort cap for a source that ignores both.
 */
const PAUSE_RING_BYTES = Math.round(SAMPLE_RATE * BYTES_PER_FRAME * 0.5);
const RESUME_RING_BYTES = Math.round(SAMPLE_RATE * BYTES_PER_FRAME * 0.15);
const MAX_RING_BYTES = SAMPLE_RATE * BYTES_PER_FRAME * 3;

/**
 * One PTP grandmaster for the whole process.
 *
 * UDP 319/320 can only be bound once, and a single grandmaster can serve every
 * receiver, so sessions register themselves as peers instead of each running an
 * engine. This is also what a synchronised group will need later: members that
 * share one clock share a timeline by construction.
 */
class SharedPtp {
  private engine: PtpEngine | null = null;
  private starting: Promise<PtpEngine | null> | null = null;
  private readonly identity: SenderIdentity = createIdentity(randomBytes(8));
  private readonly log = createLogger('Output', 'AirPlay2/PTP');

  public get senderIdentity(): SenderIdentity {
    return this.identity;
  }

  /** Start the engine if it is not up yet, and serve `peer` from it. */
  public async acquire(peer: string): Promise<PtpEngine | null> {
    if (this.engine) {
      this.engine.addPeer(peer);
      return this.engine;
    }
    if (!this.starting) {
      this.starting = this.startEngine();
    }
    const engine = await this.starting;
    engine?.addPeer(peer);
    return engine;
  }

  public release(peer: string): void {
    this.engine?.removePeer(peer);
  }

  private async startEngine(): Promise<PtpEngine | null> {
    const engine = new PtpEngine({
      clockId: this.identity.clockId,
      peers: [],
      onLog: (message) => this.log.debug('ptp', { message }),
    });
    try {
      await engine.start();
      this.engine = engine;
      this.log.info('PTP grandmaster started', { clockId: this.identity.clockId.toString(16) });
      return engine;
    } catch (err) {
      // Almost always the privileged ports. An AirPlay 2 session without PTP
      // connects, reports healthy and renders silence on an Apple receiver, so
      // this has to fail loudly rather than fall back.
      this.log.error('PTP grandmaster could not start; AirPlay 2 output is unavailable', {
        message: err instanceof Error ? err.message : String(err),
        hint: 'UDP 319/320 need root or CAP_NET_BIND_SERVICE',
      });
      this.starting = null;
      return null;
    }
  }
}

const sharedPtp = new SharedPtp();

export interface Ap2SenderConfig {
  host: string;
  port?: number;
  password?: string;
  /** Name the receiver shows for the session. */
  name?: string;
  onUnavailable?: (reason: string) => void;
}

/**
 * Drives a single AirPlay 2 receiver over node-airplay: HAP pairing, an
 * encrypted control channel, PTP timing and an encrypted realtime RTP stream.
 *
 * The shape mirrors {@link RaopSender} so an output can hold either without
 * knowing which — see {@link AirplaySender}.
 */
export class Ap2Sender implements AirplaySender {
  private readonly log = createLogger('Output', 'Ap2Sender');
  private connection: AirPlayConnection | null = null;
  private sender: RealtimeSender | null = null;
  private ptp: PtpEngine | null = null;

  private source: NodeJS.ReadableStream | null = null;
  private onData: ((chunk: Buffer) => void) | null = null;
  private readonly ring: Buffer[] = [];
  private ringBytes = 0;

  private sendTimer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private packetsDue = 0;
  private currentVolume = 30;
  private starting = false;
  private paused = false;
  private sourcePaused = false;
  private silenceLogged = false;

  constructor(
    private readonly config: Ap2SenderConfig,
    private readonly context: { zoneId: number; zoneName: string },
  ) {}

  public isRunning(): boolean {
    return this.sender !== null;
  }

  public getLatencyMs(): number {
    return LEAD_MS;
  }

  public async start(source: NodeJS.ReadableStream, volume: number): Promise<boolean> {
    this.currentVolume = clampVolume(volume, this.currentVolume);
    this.paused = false;

    if (this.sender) {
      this.attachSource(source);
      return true;
    }
    if (this.starting) {
      return false;
    }
    this.starting = true;
    try {
      // Fill the ring FIRST: the session must not sit idle after its stream
      // SETUP (see PRIME_MS).
      this.attachSource(source);
      const primed = await this.waitForPrime();
      if (!primed) {
        this.log.warn('no PCM arrived; not opening an AirPlay 2 session', this.context);
        this.detachSource();
        return false;
      }
      return await this.openSession();
    } finally {
      this.starting = false;
    }
  }

  /**
   * Grouped playback is not implemented on the AirPlay 2 path yet: it needs one
   * shared anchor across members, which is a different start contract. Falling
   * back to a solo start keeps the zone audible instead of silently dropping it
   * out of the group.
   */
  public async startForGroup(
    source: NodeJS.ReadableStream,
    volume: number,
    _basePlayNtp: bigint,
    _reAnchor: boolean,
  ): Promise<boolean> {
    this.log.warn('AirPlay 2 has no synced-group support yet; starting this zone on its own', {
      ...this.context,
    });
    return this.start(source, volume);
  }

  public pause(): void {
    this.paused = true;
    this.stopSendLoop();
  }

  public resume(source: NodeJS.ReadableStream): void {
    this.paused = false;
    this.attachSource(source);
    if (this.sender) {
      this.startSendLoop();
    }
  }

  public rebind(source: NodeJS.ReadableStream): void {
    // Drop what is still queued from the old track: keeping it would play the
    // previous track's tail over the new one. What the receiver already holds
    // (up to LEAD_MS) still plays out — the realtime path has no flush yet, so
    // the lead is what bounds that.
    this.clearRing();
    this.attachSource(source);
  }

  public async setVolume(volume: number): Promise<void> {
    this.currentVolume = clampVolume(volume, this.currentVolume);
    const connection = this.connection;
    if (!connection) {
      return;
    }
    try {
      await sendVolume(connection.rtsp, connection.sessionUrl, this.currentVolume);
    } catch (err) {
      this.log.debug('volume not applied', {
        ...this.context,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Not carried on this path yet; the receiver simply shows nothing. */
  public updateMetadata(_payload: {
    title?: string;
    artist?: string;
    album?: string;
    cover?: { data: Buffer; mime?: string };
    elapsedMs?: number;
    durationMs?: number;
  }): void {
    /* no-op until the MediaRemote channel is ported */
  }

  public setProgress(_elapsedMs: number, _durationMs: number): void {
    /* no-op until the MediaRemote channel is ported */
  }

  public stop(): void {
    this.stopSendLoop();
    this.detachSource();
    this.clearRing();
    this.sender?.stop();
    this.sender = null;
    this.connection?.close();
    this.connection = null;
    if (this.ptp) {
      sharedPtp.release(this.config.host);
      this.ptp = null;
    }
    this.log.info('AirPlay 2 sender stopped', this.context);
  }

  // -- session ---------------------------------------------------------------

  private async openSession(): Promise<boolean> {
    const identity = sharedPtp.senderIdentity;
    this.ptp = await sharedPtp.acquire(this.config.host);
    if (!this.ptp) {
      this.config.onUnavailable?.('PTP timing unavailable (needs UDP 319/320)');
      return false;
    }

    try {
      const connection = await AirPlayConnection.open({
        host: this.config.host,
        ...(this.config.port !== undefined ? { port: this.config.port } : {}),
        ...(this.config.password !== undefined ? { password: this.config.password } : {}),
        identity: identity.bytes,
        onEvent: (event) => this.handleSessionEvent(event),
      });
      this.connection = connection;
      await connection.setupSession(this.config.name ?? 'sonn');

      const sockets = await RealtimeSender.bindSockets();
      const stream = await setupRealtimeStream(connection.rtsp, connection.sessionUrl, {
        audioKey: connection.hap.sharedSecret,
        localDataPort: sockets.dataPort,
        localControlPort: sockets.controlPort,
        streamConnectionId: Math.floor(Math.random() * 0x7fff_ffff),
      });
      await sendVolume(connection.rtsp, connection.sessionUrl, this.currentVolume);

      this.sender = new RealtimeSender(
        {
          host: this.config.host,
          dataPort: stream.dataPort,
          controlPort: stream.controlPort,
          audioKey: connection.hap.sharedSecret,
          ptp: this.ptp,
          leadMs: LEAD_MS,
          onLog: (message) => this.log.debug('rtp', { ...this.context, message }),
        },
        sockets.data,
        sockets.control,
      );
      this.sender.start();
      this.startSendLoop();
      this.log.info('AirPlay 2 sender started', {
        ...this.context,
        host: this.config.host,
        leadMs: LEAD_MS,
      });
      return true;
    } catch (err) {
      this.log.warn('AirPlay 2 session failed', {
        ...this.context,
        host: this.config.host,
        message: err instanceof Error ? err.message : String(err),
      });
      this.connection?.close();
      this.connection = null;
      sharedPtp.release(this.config.host);
      this.ptp = null;
      return false;
    }
  }

  /**
   * The receiver dropping the control channel is the one failure this path has
   * that leaves everything else looking healthy — packets keep flowing into a
   * session that no longer exists.
   */
  private handleSessionEvent(event: string): void {
    this.log.warn('AirPlay 2 session event', { ...this.context, event });
    if (event.includes('closed the control channel')) {
      this.stop();
      this.config.onUnavailable?.(event);
    }
  }

  // -- audio -----------------------------------------------------------------

  private attachSource(source: NodeJS.ReadableStream): void {
    if (this.source === source) {
      return;
    }
    this.detachSource();
    this.source = source;
    this.onData = (chunk: Buffer): void => {
      if (this.ringBytes >= MAX_RING_BYTES) {
        return;
      }
      this.ring.push(chunk);
      this.ringBytes += chunk.length;
      if (!this.sourcePaused && this.ringBytes >= PAUSE_RING_BYTES) {
        this.sourcePaused = true;
        this.source?.pause();
      }
    };
    source.on('data', this.onData);
    this.sourcePaused = false;
  }

  private detachSource(): void {
    if (this.source && this.onData) {
      this.source.removeListener('data', this.onData);
    }
    this.source = null;
    this.onData = null;
    this.sourcePaused = false;
  }

  private clearRing(): void {
    this.ring.length = 0;
    this.ringBytes = 0;
  }

  private async waitForPrime(): Promise<boolean> {
    // Below PAUSE_RING_BYTES by construction, so priming never trips the
    // backpressure gate it shares a ring with.
    const target = Math.min(
      PAUSE_RING_BYTES,
      Math.ceil((PRIME_MS / 1000) * SAMPLE_RATE) * BYTES_PER_FRAME,
    );
    const deadline = Date.now() + 15_000;
    while (this.ringBytes < target && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.ringBytes > 0;
  }

  private takePacket(): Buffer | null {
    if (this.ringBytes < BYTES_PER_PACKET) {
      return null;
    }
    const parts: Buffer[] = [];
    let needed = BYTES_PER_PACKET;
    while (needed > 0) {
      const head = this.ring[0] as Buffer;
      if (head.length <= needed) {
        parts.push(head);
        needed -= head.length;
        this.ring.shift();
      } else {
        parts.push(head.subarray(0, needed));
        this.ring[0] = head.subarray(needed);
        needed = 0;
      }
    }
    this.ringBytes -= BYTES_PER_PACKET;
    if (this.sourcePaused && this.ringBytes <= RESUME_RING_BYTES) {
      this.sourcePaused = false;
      this.source?.resume();
    }
    return Buffer.concat(parts);
  }

  private startSendLoop(): void {
    if (this.sendTimer) {
      return;
    }
    this.startedAt = Date.now();
    this.packetsDue = 0;
    this.sendTimer = setInterval(() => this.pump(), SEND_TICK_MS);
  }

  private stopSendLoop(): void {
    if (this.sendTimer) {
      clearInterval(this.sendTimer);
      this.sendTimer = null;
    }
  }

  /** Keep the receiver one lead ahead of its render line, then track realtime. */
  private pump(): void {
    const sender = this.sender;
    if (!sender || this.paused) {
      return;
    }
    const elapsedFrames = ((Date.now() - this.startedAt) / 1000) * SAMPLE_RATE;
    const dueFrames = elapsedFrames + (LEAD_MS / 1000) * SAMPLE_RATE;
    while (this.packetsDue * FRAMES_PER_PACKET < dueFrames) {
      const pcm = this.takePacket();
      if (!pcm) {
        // A gap in the source still has to be filled: the RTP timeline may not
        // stall, or the receiver's anchor drifts away from the audio.
        sender.sendPacket(Buffer.alloc(BYTES_PER_PACKET));
        if (!this.silenceLogged) {
          this.silenceLogged = true;
          this.log.debug('source underrun; sending silence', this.context);
        }
      } else {
        sender.sendPacket(pcm);
        this.silenceLogged = false;
      }
      this.packetsDue++;
    }
  }
}

function clampVolume(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}
