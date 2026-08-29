import { createLogger } from '@/shared/logging/logger';
import {
  type AudioManager,
  type CoverArtPayload,
  type PlaybackMetadata,
  type PlaybackSession,
  type PlaybackSource,
} from '@/application/playback/audioManager';
import { resolveSourcePreDelayMs } from '@/application/playback/playbackPreDelay';
import type { PlayerEvent, PlayerEventMap, PlayerState } from '@/application/playback/types';

type Listener<T> = (payload: T) => void;

// Sample the position clock several times per second. tick() only emits when the
// whole-second value changes, so the broadcast rate stays ~1/sec — but sampling
// faster than 1s means each second boundary is detected within ~250ms instead of
// up to ~1s late. That removes the occasional "text skips a second then jumps by
// two" stutter, which happened when a 1s sampler stepped over a boundary and
// caught up with a +2 on the next tick.
const TICK_INTERVAL_MS = 250;

export class ZonePlayer {
  private readonly log = createLogger('Audio', `Player:${this.zoneId}`);
  private readonly listeners = new Map<PlayerEvent, Set<Listener<any>>>();
  private state: PlayerState = { mode: 'stopped', time: 0, duration: 0, playbackSource: null };
  private tickTimer?: NodeJS.Timeout;
  /** Pending start of the ticker while the engine's wake-up silence still plays out. */
  private tickStartTimer?: NodeJS.Timeout;
  private lastTickAt = 0;
  private endedEmitted = false;
  private tickerToken = 0;
  private endGuardSec = 0;
  private lastPlayRequestAtLogged: number | null = null;

  constructor(
    private readonly audioManager: AudioManager,
    private readonly zoneId: number,
    _zoneName: string,
    _sourceMac: string,
    private readonly requiresPcm: boolean,
  ) {}

  public playUri(uri: string, metadata?: PlaybackMetadata, startAtSec?: number): PlaybackSession | null {
    const normalizedStartAt = this.normalizeStartAtSec(startAtSec, metadata?.duration ?? 0);
    const session = this.audioManager.startPlayback(
      this.zoneId,
      uri,
      metadata,
      this.requiresPcm,
      { startAtSec: normalizedStartAt },
    );
    if (!session) {
      this.emit('error', 'no playback source resolved');
      return null;
    }
    const effectiveStartAt = this.normalizeStartAtSec(
      normalizedStartAt,
      session.duration ?? metadata?.duration ?? 0,
    );
    this.endedEmitted = false;
    this.startTickerWhenReady(session, effectiveStartAt);
    this.state = {
      mode: 'playing',
      time: effectiveStartAt,
      duration: session.duration ?? metadata?.duration ?? 0,
      metadata: metadata ?? session.metadata,
      sourceLabel: uri,
      playbackSource: session.playbackSource,
    };
    this.emit('started', session);
    return session;
  }

  public playExternal(
    label: string,
    playbackSource: PlaybackSource | null,
    metadata?: PlaybackMetadata,
    startAtSec?: number,
  ): PlaybackSession | null {
    const normalizedStartAt = this.normalizeStartAtSec(startAtSec, metadata?.duration ?? 0);
    const session = this.audioManager.startExternalPlayback(
      this.zoneId,
      label,
      playbackSource,
      metadata,
      this.requiresPcm,
      { startAtSec: normalizedStartAt },
    );
    if (!session) {
      this.emit('error', 'no playback source resolved');
      return null;
    }
    const effectiveStartAt = this.normalizeStartAtSec(
      normalizedStartAt,
      session.duration ?? metadata?.duration ?? 0,
    );
    this.endedEmitted = false;
    this.startTickerWhenReady(session, effectiveStartAt);
    this.state = {
      mode: 'playing',
      time: effectiveStartAt,
      duration: session.duration ?? metadata?.duration ?? 0,
      metadata: metadata ?? session.metadata,
      sourceLabel: label,
      playbackSource: session.playbackSource,
    };
    this.emit('started', session);
    return session;
  }

  public pause(): PlaybackSession | null {
    const session = this.audioManager.pausePlayback(this.zoneId);
    if (session) {
      this.state.mode = 'paused';
      this.stopTicker();
      this.emit('paused', session);
    }
    return session;
  }

  public resume(): PlaybackSession | null {
    const session = this.audioManager.resumePlayback(this.zoneId);
    if (session) {
      this.state.mode = 'playing';
      this.endedEmitted = false;
      this.startTicker();
      this.emit('resumed', session);
    }
    return session;
  }

  public stop(reason?: string): PlaybackSession | null {
    const session = this.audioManager.stopPlayback(this.zoneId);
    this.stopTicker();
    this.state.mode = 'stopped';
    this.state.time = 0;
    this.state.duration = 0;
    this.state.playbackSource = null;
    this.endedEmitted = false;
    this.endGuardSec = 0;
    if (reason) {
      this.emit('error', reason);
    }
    this.emit('stopped', session);
    return session;
  }

  public updateMetadata(metadata: PlaybackMetadata): void {
    this.state.metadata = metadata;
    if (metadata.duration && metadata.duration > 0) {
      this.state.duration = metadata.duration;
    }
    this.emit('metadata', metadata);
  }

  public updateTiming(elapsed: number, duration: number): void {
    this.state.time = elapsed;
    this.state.duration = duration;
    this.lastTickAt = Date.now();
    this.emit('position', elapsed, duration);
    this.maybeEmitEnded();
  }

  public setEndGuardMs(ms: number): void {
    const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
    this.endGuardSec = safe / 1000;
  }

  public updateCover(cover?: CoverArtPayload): string | undefined {
    const relative = this.audioManager.updateSessionCover(this.zoneId, cover);
    this.emit('cover', relative);
    return relative;
  }

  /** Updates player state for an inline crossfade without sending PLAY to outputs.
   *  The HTTP stream stays on the same URL — no Squeezelite reconnect, no gap. */
  public updateStateForCrossfade(session: PlaybackSession): void {
    this.endedEmitted = false;
    this.endGuardSec = 0;
    this.startTickerWhenReady(session, 0);
    this.state = {
      mode: 'playing',
      time: 0,
      duration: session.duration ?? session.metadata?.duration ?? 0,
      metadata: session.metadata,
      sourceLabel: session.source,
      playbackSource: session.playbackSource,
    };
  }

  public notifyCrossfadeStarted(session: PlaybackSession): void {
    this.endedEmitted = false;
    this.endGuardSec = 0;
    this.startTickerWhenReady(session, 0);
    this.state = {
      mode: 'playing',
      time: 0,
      duration: session.duration ?? session.metadata?.duration ?? 0,
      metadata: session.metadata,
      sourceLabel: session.source,
      playbackSource: session.playbackSource,
    };
    this.emit('started', session);
  }

  public setVolume(level: number): void {
    this.emit('volume', level);
  }

  public getSession(): PlaybackSession | null {
    return this.audioManager.getSession(this.zoneId);
  }

  public getState(): PlayerState {
    return this.state;
  }

  public on<E extends PlayerEvent>(event: E, listener: PlayerEventMap[E]): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as Listener<any>);
    return () => {
      this.listeners.get(event)?.delete(listener as Listener<any>);
    };
  }

  private emit<E extends PlayerEvent>(event: E, ...args: Parameters<PlayerEventMap[E]>): void {
    const listeners = this.listeners.get(event);
    if (!listeners?.size) return;
    listeners.forEach((fn) => {
      try {
        (fn as (...a: Parameters<PlayerEventMap[E]>) => void)(...args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn('player listener error', { zoneId: this.zoneId, event, message });
      }
    });
  }

  private startTicker(): void {
    this.stopTicker();
    this.beginTicking();
  }

  private beginTicking(): void {
    this.lastTickAt = Date.now();
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  private startTickerWhenReady(session: PlaybackSession | null, startAtSec = 0): void {
    this.stopTicker();
    const token = ++this.tickerToken;
    if (!session?.playbackSource) {
      return;
    }
    const profiles = session.profiles ?? [];
    const profile = profiles.includes('pcm') ? 'pcm' : profiles[0] ?? 'mp3';
    const timeoutMs = 15000;
    void this.audioManager.waitForFirstChunk(this.zoneId, profile, timeoutMs).then((ready) => {
      if (this.tickerToken !== token) {
        return;
      }
      if (ready) {
        session.firstAudioReadyAt = Date.now();
      }
      this.state.time = startAtSec;
      this.emit('position', this.state.time, this.state.duration);
      if (session.playRequestAt && session.playRequestAt !== this.lastPlayRequestAtLogged) {
        const now = Date.now();
        const playbackStartedAt = session.playbackStartedAt ?? session.updatedAt ?? null;
        const sincePlayContentMs = Math.max(0, now - session.playRequestAt);
        const sincePlaybackStartedMs = playbackStartedAt ? Math.max(0, now - playbackStartedAt) : null;
        const playContentToStartedMs = playbackStartedAt
          ? Math.max(0, playbackStartedAt - session.playRequestAt)
          : null;
        this.lastPlayRequestAtLogged = session.playRequestAt;
        this.log.info('playback first audio ready', {
          zoneId: this.zoneId,
          source: session.source,
          profile,
          ready,
          sincePlayContentMs,
          sincePlaybackStartedMs,
          playContentToStartedMs,
        });
      }
      if (!ready) {
        this.log.debug('ticker started without first chunk', { zoneId: this.zoneId, timeoutMs });
      }
      // The engine prepends the amp's wake-up silence to the stream (see
      // AudioManager.applyZonePlaybackPreDelay), and that silence arrives as ordinary
      // audio — the first chunk is the start of it, not of the music. Counting it as
      // playing time made the clock run ahead of what the room hears and reach
      // `duration` that much too early: the zone ended a track (and cut the tail off
      // every alert, #293) while the last seconds were still to be played. Hold the
      // clock until the silence has run out.
      const preDelayMs = resolveSourcePreDelayMs(session.playbackSource);
      if (preDelayMs > 0) {
        this.log.debug('clock waits out amp wake-up silence', { zoneId: this.zoneId, preDelayMs });
        this.tickStartTimer = setTimeout(() => {
          this.tickStartTimer = undefined;
          if (this.tickerToken !== token) {
            return;
          }
          this.beginTicking();
        }, preDelayMs);
        return;
      }
      this.beginTicking();
    });
  }

  private stopTicker(): void {
    this.tickerToken += 1;
    if (this.tickStartTimer) {
      clearTimeout(this.tickStartTimer);
      this.tickStartTimer = undefined;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
  }

  private tick(): void {
    if (this.state.mode !== 'playing') {
      return;
    }
    const now = Date.now();
    const deltaSeconds = Math.floor(Math.max(0, now - this.lastTickAt) / 1000);
    if (deltaSeconds <= 0) {
      return;
    }
    // Advance the baseline by the whole seconds we consumed, NOT to `now`.
    // Setting it to `now` discarded the sub-second remainder every tick, so
    // under timer jitter (heaviest with PCM/AirPlay output) the clock lost time
    // and the progress bar drifted behind real playback (#291). Carrying the
    // remainder forward keeps it aligned.
    this.lastTickAt += deltaSeconds * 1000;
    // Allow the internal clock to advance beyond `duration` by `endGuardSec`.
    // Player listeners clamp the exposed position to `duration`, but `ended` needs
    // to be able to fire when an output latency guard is configured.
    const endCap =
      this.state.duration > 0
        ? Math.max(0, this.state.duration + (this.endGuardSec > 0 ? this.endGuardSec : 0))
        : 0;
    const nextTime = endCap > 0
      ? Math.min(this.state.time + deltaSeconds, endCap)
      : this.state.time + deltaSeconds;
    if (nextTime !== this.state.time) {
      this.state.time = nextTime;
      this.emit('position', this.state.time, this.state.duration);
      this.maybeEmitEnded();
    }
  }

  private normalizeStartAtSec(startAtSec?: number, duration?: number): number {
    if (!Number.isFinite(startAtSec)) {
      return 0;
    }
    const safe = Math.max(0, startAtSec ?? 0);
    if (!Number.isFinite(duration) || (duration ?? 0) <= 0) {
      return safe;
    }
    return Math.min(safe, Math.max(0, (duration ?? 0) - 1));
  }

  private maybeEmitEnded(): void {
    if (this.endedEmitted) {
      return;
    }
    const effectiveDuration = this.state.duration > 0 ? this.state.duration + this.endGuardSec : 0;
    if (effectiveDuration > 0 && this.state.time >= effectiveDuration) {
      this.endedEmitted = true;
      this.stopTicker();
      const session = this.getSession();
      this.emit('ended', session);
    }
  }
}
