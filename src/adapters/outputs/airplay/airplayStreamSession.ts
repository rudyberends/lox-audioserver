import { PassThrough } from 'node:stream';
import { createLogger } from '@/shared/logging/logger';
import type { EnginePort } from '@/ports/EnginePort';
import type { PlaybackSource } from '@/ports/EngineTypes';
import type { AudioOutputSettings } from '@/ports/types/audioFormat';

/**
 * Minimal shared PCM stream session for AirPlay.
 * Keeps a single subscriber to the audio engine alive across track changes
 * so outputs do not thrash the engine with new readers.
 */
export class AirplayStreamSession {
  private readonly log = createLogger('Output', 'AirPlayStreamSession');
  private stream: PassThrough | null = null;
  private source: PassThrough | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private sourceKey: string | null = null;
  private onResubscribe: ((stream: PassThrough) => void) | null = null;

  constructor(
    private readonly zoneId: number,
    private readonly engine: EnginePort,
  ) {}

  /**
   * Called on a track-change source swap with the fresh shared stream, so the
   * consumer (RaopSender) can flush its device buffer and re-bind — dropping the
   * old track's buffered tail at the seam instead of playing it out.
   */
  public setOnResubscribe(cb: (stream: PassThrough) => void): void {
    this.onResubscribe = cb;
  }

  /**
   * Re-acquire a FRESH LIVE subscriber + fresh shared stream for resume, and
   * return the stream (the caller re-anchors the sender with `play`). Unlike
   * switchTrack this does NOT flush/rebind the device — resume wants the fast
   * `play` anchor (now+200ms), not the slow flush path (now+latency).
   *
   * Subscribes LIVE (primeWithBuffer:false), NOT with a buffer snapshot: a primed
   * snapshot replays buffered audio ON TOP of the device's own backlog replay and
   * is heard as a stutter. Destroying the old (backpressured) subscriber releases
   * the engine stall so ffmpeg resumes feeding the live one.
   */
  public reacquireLive(): PassThrough | null {
    if (!this.stream || this.stream.destroyed) {
      return null;
    }
    const next = this.createSourceStream(false);
    if (!next) {
      return null;
    }
    const oldSource = this.source;
    const oldStream = this.stream;
    this.stream = this.createGuardedStream();
    this.attachSource(next);
    if (oldSource && !oldSource.destroyed) {
      try {
        oldSource.destroy();
      } catch {
        /* ignore */
      }
    }
    if (oldStream && !oldStream.destroyed) {
      try {
        oldStream.destroy();
      } catch {
        /* ignore */
      }
    }
    return this.stream;
  }

  /**
   * Obtain a PCM PassThrough for this zone. Keeps a persistent stream open so
   * AirPlay does not see end-of-stream on track switches.
   */
  public getStream(): PassThrough | null {
    if (this.stream && !this.stream.destroyed) {
      this.ensureSource();
      return this.stream;
    }
    this.stream = this.createGuardedStream();
    this.ensureSource();
    return this.stream;
  }

  private createGuardedStream(): PassThrough {
    // Small HWM on purpose. Backpressure (the RaopSender pausing its read when its
    // ring is full) backs audio UP into the engine subscriber rather than pooling
    // it here. On a track handoff the engine destroys the old subscriber (and its
    // buffered audio) — so a small buffer here means little stale old-track PCM
    // survives the seam. The sender's own ~0.5s ring still smooths playback.
    const next = new PassThrough({ highWaterMark: 1024 * 16 });
    next.once('close', () => {
      if (this.stream === next) this.stream = null;
    });
    next.once('error', (err) => {
      this.log.warn('airplay stream session error', {
        zoneId: this.zoneId,
        message: err instanceof Error ? err.message : String(err),
      });
      if (this.stream === next) this.stream = null;
    });
    return next;
  }

  public setPlaybackSource(
    playbackSource: PlaybackSource | null,
    outputSettings: AudioOutputSettings,
  ): void {
    const nextKey =
      playbackSource?.kind === 'url'
        ? [
            playbackSource.url,
            playbackSource.inputFormat ?? '',
            String(outputSettings.sampleRate),
            String(outputSettings.channels),
            String(outputSettings.pcmBitDepth),
          ].join('|')
        : (playbackSource?.kind ?? null);
    if (nextKey === this.sourceKey) {
      return;
    }
    this.sourceKey = nextKey;
    if (this.stream && !this.stream.destroyed) {
      this.ensureSource();
    }
  }

  /**
   * Proactive track-change swap (driven by the playback track-change event, like
   * the sendspin output). The engine has already made the new session active, so
   * we subscribe to it NOW instead of waiting ~1.2s for the old subscriber to
   * drain and emit 'end'. Drops the old source + shared-stream backlog and lets
   * the consumer flush its device buffer — so almost no old-track audio survives
   * the seam. No-op if the new session isn't subscribable yet; the reactive
   * reconnect path then handles it.
   */
  public switchTrack(): void {
    if (!this.stream || this.stream.destroyed) {
      return;
    }
    const next = this.createSourceStream(true); // prime: new session, new track from start
    if (!next) {
      return; // new session not ready; reactive 'end' path will reconnect
    }
    const oldSource = this.source;
    const oldStream = this.stream;
    // Fresh shared stream (drop the old track's backlog) + flush/re-bind consumer.
    this.stream = this.createGuardedStream();
    this.onResubscribe?.(this.stream);
    this.attachSource(next);
    // Stop feeding the old track immediately. The old source's end/close is now
    // guarded (this.source !== old) so it won't trigger a duplicate reconnect.
    if (oldSource && !oldSource.destroyed) {
      try {
        oldSource.destroy();
      } catch {
        /* ignore */
      }
    }
    if (oldStream && !oldStream.destroyed) {
      try {
        oldStream.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  private ensureSource(): void {
    if (!this.stream || this.stream.destroyed) return;
    if (this.source && !this.source.destroyed && !this.source.readableEnded) {
      return;
    }
    const next = this.createSourceStream();
    if (!next) {
      this.source = null;
      this.scheduleReconnect();
      return;
    }
    this.attachSource(next);
  }

  private createSourceStream(primeWithBuffer = false): PassThrough | null {
    // Engine stream only. We deliberately do NOT fall back to a local decoder when
    // the engine has no session: at a track boundary the engine session for the old
    // track ends (EOF) before the next track's session exists, and a local fallback
    // would re-decode the OLD track's URL from the start (no seek) — heard as "a bit
    // of the start of the previous track". Returning null lets the reconnect retry
    // until the next track's session is up (brief silence during the fetch, which is
    // the acceptable behaviour). primeWithBuffer is TRUE only for the proactive
    // switchTrack swap (new handoff session → new track from its start, paired with
    // the device flush); FALSE for the reactive reconnect (live-only, no replay).
    return this.engine.createStream(this.zoneId, 'pcm', { label: 'airplay', primeWithBuffer });
  }

  private attachSource(next: PassThrough): void {
    this.clearReconnect();
    this.reconnectAttempts = 0;
    this.source = next;
    next.on('data', (chunk: Buffer) => {
      if (!chunk?.length || !this.stream || this.stream.destroyed) return;
      // Honor backpressure: when the shared stream's buffer is full (the RaopSender
      // paused its read because the device can't keep up), pause this engine
      // subscriber so the engine pacer throttles ffmpeg to realtime instead of
      // over-producing into an overflowing buffer. Resume on drain.
      if (!this.stream.write(chunk)) {
        next.pause();
        this.stream.once('drain', () => {
          if (this.source === next) next.resume();
        });
      }
    });
    const cleanup = () => {
      // Only reconnect if this is still the current source. If a proactive
      // track-change swap already attached a newer source, the old source's
      // end/close must NOT trigger another subscribe (that was the old churn).
      if (this.source !== next) {
        return;
      }
      this.source = null;
      this.scheduleReconnect();
    };
    next.once('end', cleanup);
    next.once('close', cleanup);
    next.once('error', (err) => {
      this.log.warn('airplay source stream error', {
        zoneId: this.zoneId,
        message: err instanceof Error ? err.message : String(err),
      });
      cleanup();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.stream || this.stream.destroyed) {
      return;
    }
    // First attempt is immediate so a track handoff (old engine session ends,
    // new one is already up) re-subscribes without an audible gap — otherwise the
    // wait shows up as a small hiccup + a sliver of the previous track at the
    // seam. Only back off if the new session isn't ready yet.
    const delay = this.reconnectAttempts === 0 ? 0 : Math.min(1000, this.reconnectAttempts * 100);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stream || this.stream.destroyed) return;
      const next = this.createSourceStream();
      if (next) {
        this.attachSource(next);
        return;
      }
      this.reconnectAttempts += 1;
      this.scheduleReconnect();
    }, delay);
  }

  private clearReconnect(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  public dispose(): void {
    this.clearReconnect();
    if (this.source && !this.source.destroyed) {
      try {
        this.source.destroy();
      } catch {
        /* ignore */
      }
    }
    this.source = null;
    if (this.stream && !this.stream.destroyed) {
      try {
        this.stream.destroy();
      } catch {
        /* ignore */
      }
    }
    this.stream = null;
  }
}
