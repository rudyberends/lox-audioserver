import { isIPv4 } from 'node:net';
import { createLogger } from '@/shared/logging/logger';
import {
  startSender,
  stopSender,
  sendChunk,
  senderControl,
  setSenderVolume,
  setSenderMetadata,
  setSenderProgress,
  setSenderArtwork,
  setLogHandler,
} from '@lox-audioserver/node-libraop';
import { discoverAirplayDevices } from '@/adapters/outputs/airplay/airplayDiscovery';
import { findAirplayQuirkWarning } from '@/adapters/outputs/airplay/airplayQuirks';

let nativeLogWired = false;

/** Route libraop's native RTSP/RAOP logs into our logger (once, when debug is on). */
function ensureNativeLogging(): void {
  if (nativeLogWired) {
    return;
  }
  nativeLogWired = true;
  const log = createLogger('Output', 'libraop');
  try {
    setLogHandler(
      (entry) => {
        const fn = entry.level === 'error' ? log.warn : entry.level === 'warn' ? log.warn : log.debug;
        fn.call(log, 'libraop', { source: entry.source, line: entry.line });
      },
      'debug',
      'debug',
      'debug',
    );
  } catch {
    nativeLogWired = false;
  }
}

/**
 * Read-ahead requested from libraop, in frames. This is the dominant component
 * of start/resume latency and the skip "tail": the device buffers this much
 * before the first sample is heard. Lower = snappier start and skip; higher =
 * more resilience to network jitter / packet loss. ~0.5s is a responsive
 * default for a healthy LAN (libraop's own retransmit covers minor loss);
 * jittery setups can raise it via `latencyMs`. (MA's conservative default is 1s.)
 */
const DEFAULT_LATENCY_FRAMES = 22_050; // ~500ms
// libraop adds this fixed minimum to the requested latency (raopcl_latency), so
// the real end-to-end playout delay is DEFAULT_LATENCY_FRAMES + this.
const RAOP_LATENCY_MIN_FRAMES = 11_025;
const SAMPLE_RATE = 44_100;
const CHANNELS = 2;
const SAMPLE_SIZE = 2; // s16le
const FRAME_BYTES = CHANNELS * SAMPLE_SIZE;
const DEFAULT_RAOP_PORT = 5000;
// libraop's raopcl_send_chunk does NOT split: it passes the whole buffer to the
// ALAC encoder, whose output buffer is sized for exactly one packet. So every
// sendChunk call must carry exactly CHUNK_FRAMES frames or the encoder overflows
// (heap corruption). Must match the `frameLength` passed to startSender.
const CHUNK_FRAMES = 352;
const CHUNK_BYTES = CHUNK_FRAMES * FRAME_BYTES; // 1408

// libraop accepts PCM at the device's realtime rate (accept_frames gates ~1.25s
// ahead). The engine can produce faster than realtime, so we must apply
// backpressure: pause the source when our ring grows past PAUSE_RING_BYTES and
// resume once it drains below RESUME_RING_BYTES. Without this the ring overflows
// and we drop audio continuously. MAX_RING_BYTES is only a last-resort safety cap
// (e.g. a dead device) so memory can't grow unbounded.
const PAUSE_RING_BYTES = Math.round(SAMPLE_RATE * FRAME_BYTES * 0.5); // ~0.5s
const RESUME_RING_BYTES = Math.round(SAMPLE_RATE * FRAME_BYTES * 0.15); // ~0.15s
const MAX_RING_BYTES = SAMPLE_RATE * FRAME_BYTES * 3; // ~3s hard cap
const DRAIN_RETRY_MS = 25;

export interface RaopSenderConfig {
  host: string;
  port?: number;
  password?: string;
  /**
   * Device encryption types (mDNS TXT `et`, e.g. "0,4"). Resolved at config time
   * by the AdminUI device picker and stored in the zone config. When present we
   * skip runtime discovery entirely. A `4` makes libraop perform the MFi
   * auth-setup the device requires. Empty string = clear-only (no auth-setup).
   */
  et?: string;
  /** Device metadata capabilities (mDNS TXT `md`, e.g. "0,1,2"). */
  md?: string;
  /**
   * Requested read-ahead latency in milliseconds. Lower = snappier start/skip,
   * higher = more jitter resilience. Defaults to ~500ms when unset.
   */
  latencyMs?: number;
  /** Forward libraop native logs at debug level. */
  debug?: boolean;
  /** Invoked when the device is lost and reconnect attempts are exhausted. */
  onUnavailable?: (reason: string) => void;
}

interface ResolvedTarget {
  address: string;
  port: number;
  et?: string;
  md?: string;
}

/**
 * Drives a single RAOP (AirPlay 1) device via node-libraop. PCM is fed from a
 * source stream through a bounded ring that drains into libraop as fast as the
 * device accepts it; libraop owns all realtime timing, ALAC/RTP, and retransmit.
 */
export class RaopSender {
  private readonly log = createLogger('Output', 'RaopSender');
  private handle: number | null = null;
  private resolved: ResolvedTarget | null = null;
  private source: NodeJS.ReadableStream | null = null;
  private onData: ((chunk: Buffer) => void) | null = null;
  private currentVolume = 30;

  private readonly ring: Buffer[] = [];
  private ringBytes = 0;
  private residual: Buffer = Buffer.alloc(0);
  private pending: Buffer | null = null; // one CHUNK_BYTES packet assembled, awaiting accept
  private sourcePaused = false;
  private droppedBytes = 0;
  private lastDropLogAt = 0;

  private drainTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private stopped = false;
  private starting = false;
  private readonly latencyFrames: number;

  constructor(
    private readonly config: RaopSenderConfig,
    private readonly context: { zoneId: number; zoneName: string },
  ) {
    this.latencyFrames =
      Number.isFinite(config.latencyMs) && (config.latencyMs as number) > 0
        ? Math.round(((config.latencyMs as number) / 1000) * SAMPLE_RATE)
        : DEFAULT_LATENCY_FRAMES;
  }

  public isRunning(): boolean {
    return this.handle !== null;
  }

  public getLatencyMs(): number {
    return Math.round(((this.latencyFrames + RAOP_LATENCY_MIN_FRAMES) / SAMPLE_RATE) * 1000);
  }

  /**
   * Connect to the device and begin feeding PCM from `source`.
   *
   * :param source: continuous PCM stream (s16le/44100/stereo). Kept across track
   *   switches; the sender stays connected and only metadata is refreshed.
   * :param volume: initial volume (0-100).
   */
  public async start(source: NodeJS.ReadableStream, volume: number): Promise<boolean> {
    this.stopped = false;
    this.currentVolume = clampVolume(volume, this.currentVolume);
    if (this.handle !== null) {
      // Already connected; just (re)bind the source.
      this.attachSource(source);
      return true;
    }
    if (this.starting) {
      return false;
    }
    this.starting = true;
    try {
      if (this.config.debug) {
        ensureNativeLogging();
      }
      const target = await this.resolveTarget();
      if (!target) {
        this.log.warn('raop sender: could not resolve target address', {
          ...this.context,
          host: this.config.host,
        });
        return false;
      }
      // Only include OPTIONAL fields when actually defined. Passing
      // `{ passwd: undefined }` is NOT a no-op: the addon's N-API layer sees the
      // key, coerces undefined via ToString() to the literal "undefined", and
      // libraop then thinks a password is set — triggering a digest-auth double
      // ANNOUNCE that the device rejects with RTSP 455.
      const opts: {
        target: string;
        port: number;
        codec: 'alac';
        sampleRate: number;
        channels: number;
        sampleSize: number;
        frameLength: number;
        latencyFrames: number;
        volume: number;
        et?: string;
        md?: string;
        passwd?: string;
      } = {
        target: target.address,
        port: target.port,
        // Real AirPlay/RAOP devices require ALAC (they 406 raw PCM).
        codec: 'alac',
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
        sampleSize: SAMPLE_SIZE,
        frameLength: CHUNK_FRAMES,
        latencyFrames: this.latencyFrames,
        volume: this.currentVolume,
      };
      // Forward the device's advertised encryption types verbatim: when it
      // includes '4' (MFiSAP), libraop performs the auth-setup the device
      // requires before SETUP. Do NOT strip it.
      if (target.et) opts.et = target.et;
      if (target.md) opts.md = target.md;
      if (this.config.password) opts.passwd = this.config.password;
      let handle: number;
      try {
        handle = startSender(opts);
      } catch (err) {
        this.log.warn('raop sender: startSender failed', {
          ...this.context,
          address: target.address,
          port: target.port,
          message: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
      this.handle = handle;
      // Anchor the RTP start clock; after this libraop accepts frames.
      senderControl(handle, 'play');
      this.reconnectAttempts = 0;
      this.attachSource(source);
      this.log.info('raop sender started', {
        ...this.context,
        address: target.address,
        port: target.port,
        latencyMs: this.getLatencyMs(),
      });
      return true;
    } finally {
      this.starting = false;
    }
  }

  public async setVolume(volume: number): Promise<void> {
    const clamped = clampVolume(volume, this.currentVolume);
    if (clamped === this.currentVolume && this.handle === null) {
      return;
    }
    this.currentVolume = clamped;
    if (this.handle !== null) {
      try {
        setSenderVolume(this.handle, clamped);
      } catch (err) {
        this.log.warn('raop sender: setVolume failed', {
          ...this.context,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  public updateMetadata(payload: {
    title?: string;
    artist?: string;
    album?: string;
    cover?: { data: Buffer; mime?: string };
    elapsedMs?: number;
    durationMs?: number;
  }): void {
    if (this.handle === null) {
      return;
    }
    try {
      setSenderMetadata(this.handle, {
        title: payload.title ?? '',
        artist: payload.artist ?? '',
        album: payload.album ?? '',
      });
      if (Number.isFinite(payload.elapsedMs) && Number.isFinite(payload.durationMs)) {
        setSenderProgress(this.handle, Math.round(payload.elapsedMs!), Math.round(payload.durationMs!));
      }
      if (payload.cover?.data?.length) {
        setSenderArtwork(this.handle, payload.cover.mime || 'image/jpeg', payload.cover.data);
      }
    } catch (err) {
      this.log.debug('raop sender: metadata update failed', {
        ...this.context,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Update only the device's progress bar (no metadata/artwork re-send). */
  public setProgress(elapsedMs: number, durationMs: number): void {
    if (this.handle === null) {
      return;
    }
    if (!Number.isFinite(elapsedMs) || !Number.isFinite(durationMs) || durationMs <= 0) {
      return;
    }
    try {
      setSenderProgress(this.handle, Math.round(elapsedMs), Math.round(durationMs));
    } catch {
      /* ignore */
    }
  }

  /** Pause playout (flushes the device buffer). The connection is kept. */
  public pause(): void {
    if (this.handle === null) {
      return;
    }
    try {
      senderControl(this.handle, 'pause');
    } catch {
      /* ignore */
    }
    this.detachSource();
    this.clearRing();
  }

  /** Resume after a pause by re-anchoring the start clock and re-binding the source. */
  public resume(source: NodeJS.ReadableStream): void {
    if (this.handle === null) {
      return;
    }
    this.stopped = false;
    try {
      senderControl(this.handle, 'play');
    } catch {
      /* ignore */
    }
    this.attachSource(source);
  }

  /**
   * Track-boundary swap: drop all buffered old-track audio and bind to a fresh
   * source. Flushes libraop's device buffer (bare raopcl_flush — no pause-state,
   * resumes on the next frames via accept_frames), clears our ring, and re-binds
   * to the new stream so the new track streams in immediately. The RTSP connection
   * is kept (no teardown/zap). Trades the device's buffered tail (a chunk of the
   * track just left — most audible on a skip) for a short refill silence, which is
   * the desired behaviour.
   */
  public rebind(source: NodeJS.ReadableStream): void {
    if (this.handle === null) {
      return;
    }
    try {
      senderControl(this.handle, 'flush');
    } catch {
      /* ignore */
    }
    this.clearDrainTimer();
    this.clearRing();
    this.attachSource(source);
    this.pump();
  }

  public stop(): void {
    this.stopped = true;
    this.clearReconnect();
    this.clearDrainTimer();
    this.detachSource();
    this.clearRing();
    if (this.handle !== null) {
      const handle = this.handle;
      this.handle = null;
      try {
        stopSender(handle);
      } catch {
        /* ignore */
      }
    }
  }

  // --- feed pipeline -------------------------------------------------------

  private attachSource(source: NodeJS.ReadableStream): void {
    if (this.source === source && this.onData) {
      return;
    }
    this.detachSource();
    this.source = source;
    this.sourcePaused = false;
    const onData = (chunk: Buffer) => this.feed(chunk);
    this.onData = onData;
    source.on('data', onData);
  }

  private detachSource(): void {
    if (this.source && this.onData) {
      this.source.off('data', this.onData);
    }
    this.source = null;
    this.onData = null;
    this.sourcePaused = false;
  }

  private feed(chunk: Buffer): void {
    if (this.stopped || this.handle === null || !chunk?.length) {
      return;
    }
    const combined = this.residual.length ? Buffer.concat([this.residual, chunk]) : chunk;
    const alignedLen = combined.length - (combined.length % FRAME_BYTES);
    if (alignedLen > 0) {
      this.ring.push(combined.subarray(0, alignedLen));
      this.ringBytes += alignedLen;
      this.residual = combined.subarray(alignedLen);
    } else {
      this.residual = combined;
    }
    this.trimRing();
    this.pump();
    this.updateBackpressure();
  }

  /**
   * Pause the source when the ring fills (device can't keep up) and resume once
   * it drains — so the engine paces to the device's realtime rate instead of
   * over-producing into an overflowing ring.
   */
  private updateBackpressure(): void {
    if (!this.source) {
      return;
    }
    if (!this.sourcePaused && this.ringBytes >= PAUSE_RING_BYTES) {
      this.source.pause();
      this.sourcePaused = true;
    } else if (this.sourcePaused && this.ringBytes <= RESUME_RING_BYTES) {
      this.source.resume();
      this.sourcePaused = false;
    }
  }

  private trimRing(): void {
    if (this.ringBytes <= MAX_RING_BYTES) {
      return;
    }
    while (this.ringBytes > MAX_RING_BYTES && this.ring.length > 0) {
      const removed = this.ring.shift()!;
      this.ringBytes -= removed.length;
      this.droppedBytes += removed.length;
    }
    const now = Date.now();
    if (now - this.lastDropLogAt > 5000) {
      this.lastDropLogAt = now;
      this.log.warn('raop sender: dropping PCM, device not keeping up', {
        ...this.context,
        droppedBytes: this.droppedBytes,
        ringBytes: this.ringBytes,
      });
      this.droppedBytes = 0;
    }
  }

  private pump(): void {
    if (this.stopped || this.handle === null) {
      return;
    }
    this.clearDrainTimer();
    for (;;) {
      // Assemble exactly one CHUNK_BYTES packet (libraop requires fixed-size
      // chunks). Hold it in `pending` so a not-ready retry doesn't re-pull/lose it.
      if (!this.pending) {
        if (this.ringBytes < CHUNK_BYTES) {
          this.updateBackpressure(); // ring drained — resume source if paused
          return; // wait for a full packet's worth of PCM
        }
        this.pending = this.pullChunk(CHUNK_BYTES);
      }
      let result;
      try {
        result = sendChunk(this.handle, this.pending);
      } catch (err) {
        this.log.warn('raop sender: sendChunk threw', {
          ...this.context,
          message: err instanceof Error ? err.message : String(err),
        });
        this.onConnectionLost('send-error');
        return;
      }
      if (result.sent) {
        this.pending = null;
        this.updateBackpressure(); // ring shrank — maybe resume source
        continue;
      }
      if (result.reason === 'disconnected') {
        this.onConnectionLost('disconnected');
        return;
      }
      // not-ready: libraop's queue is full; keep `pending` and retry shortly.
      this.scheduleDrain();
      return;
    }
  }

  /** Remove and return exactly `n` bytes from the head of the ring. */
  private pullChunk(n: number): Buffer {
    const parts: Buffer[] = [];
    let remaining = n;
    while (remaining > 0 && this.ring.length > 0) {
      const head = this.ring[0]!;
      if (head.length <= remaining) {
        parts.push(head);
        remaining -= head.length;
        this.ring.shift();
        this.ringBytes -= head.length;
      } else {
        parts.push(head.subarray(0, remaining));
        this.ring[0] = head.subarray(remaining);
        this.ringBytes -= remaining;
        remaining = 0;
      }
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
  }

  private scheduleDrain(): void {
    if (this.drainTimer || this.stopped) {
      return;
    }
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.pump();
    }, DRAIN_RETRY_MS);
  }

  private clearDrainTimer(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
  }

  private clearRing(): void {
    this.ring.length = 0;
    this.ringBytes = 0;
    this.residual = Buffer.alloc(0);
    this.pending = null;
  }

  private onConnectionLost(reason: string): void {
    if (this.stopped) {
      return;
    }
    this.log.warn('raop sender: connection lost', { ...this.context, reason });
    const source = this.source;
    this.clearDrainTimer();
    this.detachSource();
    if (this.handle !== null) {
      const handle = this.handle;
      this.handle = null;
      try {
        stopSender(handle);
      } catch {
        /* ignore */
      }
    }
    if (!source) {
      this.config.onUnavailable?.(reason);
      return;
    }
    this.scheduleReconnect(source);
  }

  private scheduleReconnect(source: NodeJS.ReadableStream): void {
    if (this.reconnectTimer || this.stopped) {
      return;
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log.warn('raop sender: giving up reconnect', {
        ...this.context,
        attempts: this.reconnectAttempts,
      });
      this.config.onUnavailable?.('reconnect-exhausted');
      return;
    }
    const delay = Math.min(2000, 250 + this.reconnectAttempts * 250);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts += 1;
      this.clearRing();
      void this.start(source, this.currentVolume);
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
  }

  // --- target resolution ---------------------------------------------------

  private async resolveTarget(): Promise<ResolvedTarget | null> {
    if (this.resolved) {
      return this.resolved;
    }
    const host = this.config.host.trim();
    const configPort = Number.isFinite(this.config.port) ? Number(this.config.port) : undefined;
    const target = host.toLowerCase();

    // Config-time discovery: the AdminUI picker stored `et` (and host/port/md),
    // so we have everything and skip the runtime mDNS browse entirely. `et` may
    // be an empty string (clear-only device) — its presence is what matters.
    if (this.config.et !== undefined && isIPv4(host)) {
      this.resolved = {
        address: host,
        port: configPort ?? DEFAULT_RAOP_PORT,
        et: this.config.et || undefined,
        md: this.config.md,
      };
      return this.resolved;
    }

    // Fallback: no stored `et` (manual/legacy config) — discover once.
    try {
      const devices = await discoverAirplayDevices(2000);
      const matches = devices.filter((device) =>
        [device.host, device.address, device.name]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLowerCase() === target),
      );
      // libraop speaks RAOP only. If the device advertises AirPlay but no RAOP,
      // it's AirPlay-2-only and we can't drive it — surface that clearly.
      const raop = matches.find((device) => device.protocol === 'raop');
      if (!raop && matches.length > 0) {
        this.log.warn('raop sender: device is AirPlay 2 only (no RAOP advertised); not supported', {
          ...this.context,
          host,
        });
      }
      if (raop) {
        const quirk = findAirplayQuirkWarning([
          raop.name,
          typeof raop.txt?.am === 'string' ? (raop.txt.am as string) : undefined,
          typeof raop.txt?.model === 'string' ? (raop.txt.model as string) : undefined,
          typeof raop.txt?.manufacturer === 'string' ? (raop.txt.manufacturer as string) : undefined,
        ]);
        if (quirk) {
          this.log.warn('raop sender: known-problematic device', { ...this.context, note: quirk });
        }
        const address = raop.address && isIPv4(raop.address) ? raop.address : isIPv4(host) ? host : undefined;
        if (address) {
          // Cache only a real discovered match. The device's `et` (which may
          // include '4' for the MFi auth-setup it requires) is essential, so we
          // must not pin an et-less fallback from a startup race.
          this.resolved = {
            address,
            port: configPort ?? raop.port ?? DEFAULT_RAOP_PORT,
            et: typeof raop.txt?.et === 'string' ? (raop.txt.et as string) : undefined,
            md: typeof raop.txt?.md === 'string' ? (raop.txt.md as string) : undefined,
          };
          return this.resolved;
        }
      }
    } catch (err) {
      this.log.debug('raop sender: discovery failed', {
        ...this.context,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    // Fallback: host is an IPv4 literal but discovery hasn't surfaced it yet
    // (e.g. mDNS not ready at startup). Return WITHOUT caching so the next
    // attempt re-discovers and can pick up `et` once the device is advertised.
    if (isIPv4(host)) {
      return { address: host, port: configPort ?? DEFAULT_RAOP_PORT };
    }
    return null;
  }
}

function clampVolume(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}
