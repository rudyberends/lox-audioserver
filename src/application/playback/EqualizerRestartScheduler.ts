import type { ComponentLogger } from '@/shared/logging/logger';
import type { PlaybackService } from '@/application/playback/PlaybackService';
import type { PlaybackSession } from '@/ports/types/playback';
import { zoneSessionKey } from '@/ports/types/SessionKey';

export type EqualizerRestartSchedulerDeps = {
  getSession: (zoneId: number) => PlaybackSession | undefined;
  playbackService: Pick<PlaybackService, 'hasSession' | 'restartZoneForEqualizer'>;
  getEqualizerBands: (zoneId: number) => ReadonlyArray<number> | null;
  log: ComponentLogger;
};

const DEFAULT_DEBOUNCE_MS = 350;

/**
 * Debounces equalizer-driven engine restarts. Loxone App EQ slider drags
 * fire many band-change events in quick succession; without coalescing
 * we would tear down and respawn ffmpeg on every tick.
 */
export class EqualizerRestartScheduler {
  private readonly deps: EqualizerRestartSchedulerDeps;
  private readonly debounceMs: number;
  private readonly timers = new Map<number, NodeJS.Timeout>();

  constructor(deps: EqualizerRestartSchedulerDeps, debounceMs: number = DEFAULT_DEBOUNCE_MS) {
    this.deps = deps;
    this.debounceMs = debounceMs;
  }

  public schedule(zoneId: number): void {
    const existing = this.timers.get(zoneId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.timers.delete(zoneId);
      this.apply(zoneId);
    }, this.debounceMs);
    timer.unref?.();
    this.timers.set(zoneId, timer);
  }

  private apply(zoneId: number): void {
    const session = this.deps.getSession(zoneId);
    if (!session || !session.playbackSource) {
      return;
    }
    if (!this.deps.playbackService.hasSession(zoneSessionKey(zoneId))) {
      return;
    }
    if (session.state !== 'playing') {
      return;
    }
    // Swap ffmpeg in-place so output subscribers (Squeezelite, Snapcast,
    // Cast, ...) stay attached. The standard PlaybackService.start path
    // calls stop({ discardSubscribers: true }) which destroys their
    // PassThrough streams and forces the user to press Play again.
    const bands = this.deps.getEqualizerBands(zoneId);
    this.deps.log.info('restarting audio engine to apply equalizer change', { zoneId });
    this.deps.playbackService.restartZoneForEqualizer(zoneSessionKey(zoneId), bands);
  }
}
