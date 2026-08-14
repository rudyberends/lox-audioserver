import { isIPv4 } from 'node:net';
import { createLogger } from '@/shared/logging/logger';
import {
  startSender,
  stopSender,
  sendChunk,
  senderControl,
  senderStartAt,
  getNtp,
  getSenderState,
  setSenderVolume,
  setSenderMetadata,
  setSenderProgress,
  setSenderArtwork,
  setLogHandler,
} from '@sonn-audio/node-libraop';
import { discoverAirplayDevices } from '@/adapters/outputs/airplay/airplayDiscovery';
import { findAirplayQuirkWarning } from '@/adapters/outputs/airplay/airplayQuirks';

let nativeLogWired = false;

/**
 * Compute a shared playback anchor `prebufferMs` in the future, in NTP units
 * (seconds<<32 | fraction). Every member of a sync group passes the SAME value
 * to `startForGroup` so identical frames play at the same wall-clock time across
 * devices. The prebuffer must exceed the time to connect all members + the
 * device read-ahead latency. BigInt throughout to keep sub-millisecond accuracy.
 */
export function computeGroupAnchorNtp(prebufferMs: number): bigint {
  return getNtp() + msToNtp(Math.max(0, prebufferMs));
}

/** Convert milliseconds to NTP fraction units (1s = 2^32). Signed (offsets may be negative). */
function msToNtp(ms: number): bigint {
  return (BigInt(Math.round(ms)) * (1n << 32n)) / 1000n;
}

/** Convert a frame count to NTP fraction units (1s = 2^32). For latency math. */
function framesToNtp(frames: number): bigint {
  return (BigInt(Math.max(0, Math.round(frames))) * (1n << 32n)) / BigInt(SAMPLE_RATE);
}

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
 * Read-ahead requested from libraop, in frames. This is the device's playback
 * buffer: it holds this much audio before the first sample is heard. Lower =
 * snappier start and skip "tail"; higher = more resilience to network jitter /
 * packet loss (stutter / buffer-underrun on slower devices). ~0.5s requested
 * (≈750ms total with the libraop minimum below) is a responsive default for a
 * healthy LAN; stutter-prone devices can raise it per-output via `bufferMs`.
 * (MA's conservative default is 1.5s.)
 */
const DEFAULT_LATENCY_FRAMES = 22_050; // ~500ms requested
// libraop adds this fixed minimum to the requested latency (raopcl_latency), so
// the real end-to-end playout delay is DEFAULT_LATENCY_FRAMES + this.
const RAOP_LATENCY_MIN_FRAMES = 11_025;
const SAMPLE_RATE = 44_100;
// Per-output device-buffer override (`bufferMs` = total read-ahead the device
// holds, i.e. what getLatencyMs() reports). Unset keeps the snappy 750ms that
// DEFAULT_LATENCY_FRAMES + RAOP_LATENCY_MIN_FRAMES already add up to; the range
// mirrors Music Assistant's RAOP buffer bounds.
const MIN_BUFFER_MS = 250;
const MAX_BUFFER_MS = 5_000;
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
// Max refill gap a bare-flush rebind tolerates before re-anchoring. A bare flush
// empties the device buffer, so unlike a non-flushing gap (covered by latencyMs of
// buffer) the device has ZERO headroom afterwards: any real refill stall leaves the
// kept RTP timeline behind the playout clock and the new frames land LATE → silent.
// Track changes routinely refill in ~400ms-1s (ffmpeg respawn / librespot load),
// while a genuine seamless skip continues within the normal send cadence (<100ms),
// so this grace cleanly separates "re-anchor" from "keep the seamless flush".
const REBIND_REFILL_GRACE_MS = 250;

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
   * Multiroom sync offset in milliseconds (per zone). Shifts this device's
   * playback anchor relative to the group so a fixed hardware offset between
   * grouped AirPlay devices can be tuned out — positive = this device plays
   * later. Default 0 = rely on automatic per-device latency compensation. The
   * RAOP read-ahead buffer itself is a fixed internal default (DEFAULT_LATENCY_FRAMES).
   */
  latencyMs?: number;
  /**
   * Per-output device read-ahead BUFFER in milliseconds (distinct from the sync
   * offset `latencyMs`). Total audio the device buffers before playout — higher
   * trades start/skip snappiness for resilience against stutter / buffer underrun
   * on slower or jittery devices. Unset = 750ms; when set, clamped to
   * [{@link MIN_BUFFER_MS}, {@link MAX_BUFFER_MS}].
   */
  bufferMs?: number;
  /** Forward libraop native logs at debug level. */
  debug?: boolean;
  /** Invoked when the device is lost and reconnect attempts are exhausted. */
  onUnavailable?: (reason: string) => void;
  /**
   * Invoked once when a legacy config (no stored `et`) is resolved via runtime
   * mDNS discovery, so the caller can persist the discovered `et/md/port` back
   * into the zone config (self-heal). Removes the runtime-discovery dependency on
   * subsequent connects — important for MFi devices, whose `et` (with a `4`) is
   * required for auth-setup and would otherwise be lost if mDNS is unavailable.
   */
  onDeviceResolved?: (info: { et?: string; md?: string; port: number }) => void;
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
  // Wall-clock of the last frame actually accepted by the device, and whether the
  // device is currently paused. Used by rebind() to decide between a seamless bare
  // flush (live timeline) and a re-anchor (paused or drained timeline).
  private lastSentAt = 0;
  private playoutPaused = false;
  // Set by rebind()'s bare-flush path: the staleness check runs again when the
  // first frame of the new source actually arrives (the refill gap — e.g. a new
  // ffmpeg spawn on a station change — isn't visible at rebind time).
  private rebindAwaitingFirstFrame = false;

  private drainTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private stopped = false;
  private starting = false;
  // RAOP read-ahead buffer in frames, requested from libraop. Defaults to a snappy
  // 750ms total; raised per-output via `bufferMs` for stutter-prone devices. The
  // per-zone `latencyMs` is reserved for the multiroom sync offset, not this.
  private readonly latencyFrames: number;
  // Per-zone multiroom sync offset (ms): shifts this device's playback anchor so
  // a fixed hardware offset between grouped devices can be tuned out. Positive =
  // this device plays later. Default 0 = pure auto-sync.
  private readonly syncOffsetMs: number;

  constructor(
    private readonly config: RaopSenderConfig,
    private readonly context: { zoneId: number; zoneName: string },
  ) {
    this.syncOffsetMs = Number.isFinite(config.latencyMs) ? (config.latencyMs as number) : 0;
    // `bufferMs` is the TOTAL device read-ahead; libraop adds RAOP_LATENCY_MIN_FRAMES
    // on top of what we request, so subtract it back out. Unset → the 750ms default.
    if (Number.isFinite(config.bufferMs)) {
      const clampedMs = Math.min(MAX_BUFFER_MS, Math.max(MIN_BUFFER_MS, config.bufferMs as number));
      const totalFrames = Math.round((clampedMs / 1000) * SAMPLE_RATE);
      this.latencyFrames = Math.max(0, totalFrames - RAOP_LATENCY_MIN_FRAMES);
    } else {
      this.latencyFrames = DEFAULT_LATENCY_FRAMES;
    }
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
    this.playoutPaused = false;
    this.rebindAwaitingFirstFrame = false;
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
      if (!(await this.connect())) {
        return false;
      }
      // Anchor the RTP start clock to now; after this libraop accepts frames.
      senderControl(this.handle!, 'play');
      this.reconnectAttempts = 0;
      this.attachSource(source);
      this.log.info('raop sender started', {
        ...this.context,
        latencyMs: this.getLatencyMs(),
      });
      return true;
    } finally {
      this.starting = false;
    }
  }

  /**
   * Start as a member of a sync group. Identical to {@link start} except the RTP
   * clock is anchored to a SHARED NTP time (the same `anchorNtp` is passed to
   * every group member) instead of "now", so frame 0 — and every frame after —
   * plays at the same wall-clock moment on all devices. The caller must feed all
   * members identical PCM from frame 0 (batched engine subscribers).
   */
  public async startForGroup(
    source: NodeJS.ReadableStream,
    volume: number,
    basePlayNtp: bigint,
    reAnchor: boolean,
  ): Promise<boolean> {
    this.stopped = false;
    this.playoutPaused = false;
    this.currentVolume = clampVolume(volume, this.currentVolume);
    const connected = this.handle !== null;
    // Track change within a synced group: the sender stays connected and keeps its
    // RTP timeline, so just re-attach the (identical, new-track) subscriber — no
    // re-anchor, or we'd add a gap every track.
    if (connected && !reAnchor) {
      this.attachSource(source);
      return true;
    }
    if (this.starting) {
      return false;
    }
    this.starting = true;
    try {
      if (connected) {
        // Re-sync of an already-connected sender (leader was solo, or a member
        // joined). Tear the RTSP session down and fresh-connect so every member
        // takes the SAME clean start path: connect -> start_at -> accept/send.
        // (Flush-re-anchoring a live stream to a future anchor starts it LATE and
        // breaks sync; cliraop only ever fresh-starts or unpauses to now+200ms.)
        this.detachSource();
        this.clearDrainTimer();
        this.clearRing();
        const stale = this.handle;
        this.handle = null;
        if (stale !== null) {
          try {
            stopSender(stale);
          } catch {
            /* ignore */
          }
        }
      }
      if (!(await this.connect())) {
        return false;
      }
      // Per-device latency compensation. The device announces its own buffer
      // latency (Audio-Latency override), and a frame at start_ts plays at
      // start_ts + deviceLatency. To make frame 0 play at the SAME wall time
      // (basePlayNtp) on every member regardless of its latency, anchor each
      // sender at basePlayNtp - deviceLatency. The per-zone syncOffsetMs is added
      // on top to tune out any residual fixed hardware offset (positive = later).
      const deviceLatencyFrames = this.deviceLatencyFrames();
      const anchorNtp = basePlayNtp - framesToNtp(deviceLatencyFrames) + msToNtp(this.syncOffsetMs);
      senderStartAt(this.handle!, anchorNtp);
      this.reconnectAttempts = 0;
      this.attachSource(source);
      this.log.info('raop sender started (group)', {
        ...this.context,
        reAnchor,
        deviceLatencyFrames,
        syncOffsetMs: this.syncOffsetMs,
      });
      return true;
    } finally {
      this.starting = false;
    }
  }

  /** Device-effective playback latency (frames) — the device's Audio-Latency
   * override if any, else our configured value. Used for group sync compensation. */
  private deviceLatencyFrames(): number {
    if (this.handle !== null) {
      try {
        const reported = getSenderState(this.handle).latencyFrames;
        if (typeof reported === 'number' && reported > 0) {
          return reported;
        }
      } catch {
        /* ignore */
      }
    }
    return this.latencyFrames + RAOP_LATENCY_MIN_FRAMES;
  }

  /** Resolve the target and open the RAOP connection (ANNOUNCE/SETUP/RECORD). */
  private async connect(): Promise<boolean> {
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
    try {
      this.handle = startSender(opts);
    } catch (err) {
      this.log.warn('raop sender: startSender failed', {
        ...this.context,
        address: target.address,
        port: target.port,
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    return true;
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

  /**
   * Pause playout, sendspin/snapcast-style: hold position, don't tear down. The
   * device keeps its buffer (`raopcl_pause`, no flush) and we FREEZE the feed at the
   * exact sample — pause the source and stop the pump — instead of detaching and
   * clearing the ring. The engine subscriber backpressure-stalls upstream, so on
   * resume the SAME source + ring continue from the same position (no fresh
   * subscriber, no skip). The RTSP connection is kept.
   */
  public pause(): void {
    if (this.handle === null) {
      return;
    }
    try {
      senderControl(this.handle, 'pause');
    } catch {
      /* ignore */
    }
    this.playoutPaused = true;
    // A pause mid-refill supersedes the deferred rebind check; resume() re-anchors.
    this.rebindAwaitingFirstFrame = false;
    // Stop the not-ready retry loop and freeze the feed. Pausing the source keeps
    // the ring holding the pause-point audio (otherwise trimRing would drop it for
    // newer PCM) and backpressures the engine subscriber to a stall — position held.
    this.clearDrainTimer();
    if (this.source && !this.sourcePaused) {
      this.source.pause();
      this.sourcePaused = true;
    }
  }

  /**
   * Resume after a pause. Re-anchor the device clock with `play` (it replays its
   * retained backlog from the pause point via "restarting w/ pause") and un-gate
   * the SAME source + ring, so playback continues from the exact sample with no
   * fresh-subscriber skip. `source` is the reused shared stream — attachSource is a
   * no-op when it is unchanged.
   */
  public resume(source: NodeJS.ReadableStream): void {
    if (this.handle === null) {
      return;
    }
    this.stopped = false;
    this.playoutPaused = false;
    try {
      senderControl(this.handle, 'play');
    } catch {
      /* ignore */
    }
    this.attachSource(source);
    if (this.source && this.sourcePaused) {
      this.source.resume();
      this.sourcePaused = false;
    }
    this.pump();
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
    // A bare flush keeps the device's RTP timeline and resumes on the next frames —
    // correct for a skip mid-playback, where the device buffer is live. But when the
    // device is paused (skip while paused) or has drained during a fetch gap (natural
    // track advance after the old session ended seconds before the next one is ready),
    // the timeline is stale: a bare flush leaves new frames anchored in the past, so
    // the device either leaks a sliver of the old buffered tail or stays silent until
    // a manual pause/unpause. In those cases re-anchor with `play` (now+200ms), like
    // resume(), so the new track starts cleanly. Solo path only; grouped sync
    // re-anchors via startForGroup()'s shared NTP anchor.
    const idleMs = this.lastSentAt === 0 ? Infinity : Date.now() - this.lastSentAt;
    const timelineStale = this.playoutPaused || idleMs > this.getLatencyMs();
    this.log.debug('raop rebind', {
      ...this.context,
      reAnchored: timelineStale,
      paused: this.playoutPaused,
      idleMs: Number.isFinite(idleMs) ? Math.round(idleMs) : null,
      latencyMs: this.getLatencyMs(),
    });

    if (timelineStale) {
      this.reanchorWithFreshStart(source);
      return;
    }

    // Live timeline (skip mid-playback): a bare flush drops the old track's buffered
    // tail but keeps the RTP clock, so the new frames resume seamlessly — IF the new
    // source delivers promptly. But idleMs only sees the gap so far; a station change
    // respawns ffmpeg, so the real gap is the refill ahead (~1s) which underruns the
    // device and lands the kept-timeline frames LATE → silent. We can't see that gap
    // yet, so flush now and re-check staleness when the first new frame arrives.
    try {
      senderControl(this.handle, 'flush');
    } catch {
      /* ignore */
    }
    this.clearDrainTimer();
    this.clearRing();
    this.attachSource(source);
    this.rebindAwaitingFirstFrame = true;
    this.pump();
  }

  /**
   * Tear the RTSP session down and fresh-start on the same source. A flush on the
   * LIVE connection keeps the old head_ts, so re-anchoring with `play` leaves new
   * frames stamped in the PAST — the device drops them (raopcl_send_chunk "begining
   * to stream (LATE)") and stays silent until a manual pause/play. (Same finding as
   * the group re-sync: flush-re-anchor starts LATE.) A fresh start resets head_ts and
   * takes the clean connect -> `play` (now+200ms) path that start() uses, so the new
   * track actually plays.
   */
  private reanchorWithFreshStart(source: NodeJS.ReadableStream): void {
    this.rebindAwaitingFirstFrame = false;
    this.detachSource();
    this.clearDrainTimer();
    this.clearRing();
    this.playoutPaused = false;
    const stale = this.handle;
    this.handle = null;
    if (stale !== null) {
      try {
        stopSender(stale);
      } catch {
        /* ignore */
      }
    }
    void this.start(source, this.currentVolume).catch((err) => {
      this.log.warn('raop rebind reconnect failed', {
        ...this.context,
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }

  public stop(): void {
    this.stopped = true;
    this.rebindAwaitingFirstFrame = false;
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
      // First frame after a bare-flush rebind: now that real new-source PCM has
      // arrived we can measure the actual refill gap. The bare flush emptied the
      // device buffer, so any stall beyond the seamless-skip cadence stamps these
      // frames in the past (LATE → silent), so re-anchor now — crucially only now
      // that PCM is flowing, so the anchor lands with audio ready rather than on an
      // empty stream. Within the grace = genuine seamless skip, keep the bare flush.
      if (this.rebindAwaitingFirstFrame && this.ringBytes >= CHUNK_BYTES) {
        this.rebindAwaitingFirstFrame = false;
        const gapMs = this.lastSentAt === 0 ? Infinity : Date.now() - this.lastSentAt;
        if (gapMs > REBIND_REFILL_GRACE_MS && this.source && this.handle !== null) {
          // The device buffer drained during the refill; the kept RTP timeline would
          // stamp these frames in the past (LATE → silent). Re-anchor with a clean
          // RTSP teardown+reconnect — we are at the first frame, so the reconnect's
          // `play` anchor lands with PCM ready. (An in-session pause/play re-anchor is
          // faster but some receivers ignore it and stay silent until a manual
          // pause/play, so the clean restart is the reliable universal path.)
          this.log.debug('raop rebind clean-restart on refill gap', {
            ...this.context,
            gapMs: Number.isFinite(gapMs) ? Math.round(gapMs) : null,
            latencyMs: this.getLatencyMs(),
          });
          this.reanchorWithFreshStart(this.source);
          return;
        }
      }
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
        this.lastSentAt = Date.now();
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
          // Self-heal a legacy config: we only reach this discovery path when the
          // stored config had no `et`. Persist what we found so future connects use
          // it directly (no runtime mDNS dependency).
          if (this.resolved.et !== undefined) {
            this.config.onDeviceResolved?.({
              et: this.resolved.et,
              md: this.resolved.md,
              port: this.resolved.port,
            });
          }
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
