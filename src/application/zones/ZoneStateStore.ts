import type { LoxoneZoneState } from '@/domain/loxone/types';
import { applyZonePatch } from '@/domain/loxone/reducer';
import type { NotifierPort } from '@/ports/NotifierPort';
import type { AudioManager } from '@/application/playback/audioManager';
import { normalizeSpotifyAudiopath } from '@/application/zones/helpers/queueHelpers';
import { FileType } from '@/domain/loxone/enums';
import type { ZoneContext } from '@/application/zones/internal/zoneTypes';
import { ZoneRepository } from '@/application/zones/ZoneRepository';

type ZoneStateStoreDeps = {
  isRadioAudiopath: (audiopath: string | undefined, audiotype?: number | null) => boolean;
  isLineInAudiopath: (audiopath: string | undefined) => boolean;
  syncGroupMembersPatch: (leaderId: number, patch: Partial<LoxoneZoneState>, force: boolean) => void;
  onStatePatch?: (
    zoneId: number,
    patch: Partial<LoxoneZoneState>,
    nextState: LoxoneZoneState,
  ) => void;
  notifyOutputMetadata: (
    zoneId: number,
    ctx: ZoneContext,
    patch: Partial<LoxoneZoneState>,
  ) => void;
  notifier: NotifierPort;
  audioManager: AudioManager;
};

export class ZoneStateStore {
  constructor(
    private readonly zoneRepo: ZoneRepository,
    private readonly deps: ZoneStateStoreDeps,
  ) {}

  /** Read-only snapshot of the current zone state for external consumers (e.g. outputs). */
  public getZoneState(zoneId: number): LoxoneZoneState | null {
    const ctx = this.zoneRepo.get(zoneId);
    return ctx ? ctx.state : null;
  }

  public getState(zoneId: number): LoxoneZoneState | undefined {
    return this.zoneRepo.get(zoneId)?.state;
  }

  public setInitial(zoneId: number, state: LoxoneZoneState): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    ctx.state = state;
  }

  public getMetadata(zoneId: number): Record<string, unknown> | undefined {
    return this.zoneRepo.get(zoneId)?.metadata;
  }

  public getTechnicalSnapshot(zoneId: number): {
    inputMode: ZoneContext['inputMode'];
    activeInput: string | null;
    activeOutput: string | null;
    transports: string[];
    outputs: string[];
  } | null {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return null;
    }
    const transports = ctx.outputs.map((t) => t.type);
    const outputs =
      ctx.activeOutput !== null
        ? ctx.outputs.filter((t) => t.type === ctx.activeOutput).map((t) => t.type)
        : [];
    return {
      inputMode: ctx.inputMode,
      activeInput: ctx.activeInput,
      activeOutput: ctx.activeOutput,
      transports,
      outputs,
    };
  }

  public applyPatch(zoneId: number, patch: Partial<LoxoneZoneState>, force = false): void {
    this.patch(zoneId, patch, force);
  }

  public patch(zoneId: number, patch: Partial<LoxoneZoneState>, force = false): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }

    const mergedForType = applyZonePatch(ctx.state, patch);
    const isRadioState = this.deps.isRadioAudiopath(mergedForType.audiopath, mergedForType.audiotype);
    const isLineInState = this.deps.isLineInAudiopath(mergedForType.audiopath);
    const desiredType = resolveLoxoneType(mergedForType.audiopath, mergedForType.audiotype);
    if (desiredType !== mergedForType.type) {
      patch.type = desiredType;
    }
    if (isRadioState) {
      const artistValue =
        typeof mergedForType.artist === 'string' ? mergedForType.artist.trim() : '';
      if (!('audiotype' in patch) || patch.audiotype !== 1) {
        patch.audiotype = 1;
      }
      if (!('time' in patch) || patch.time !== 0) {
        patch.time = 0;
      }
      if (!('duration' in patch) || patch.duration !== 0) {
        patch.duration = 0;
      }
      if (artistValue) {
        if (!mergedForType.station?.trim()) {
          if (ctx.state.station?.trim()) {
            patch.station = ctx.state.station;
          } else {
            const fallback =
              typeof ctx.metadata.radioStationFallback === 'string'
                ? ctx.metadata.radioStationFallback
                : '';
            if (fallback) {
              patch.station = fallback;
            }
          }
        }
      } else if (!mergedForType.station?.trim()) {
        const fallback =
          typeof ctx.metadata.radioStationFallback === 'string'
            ? ctx.metadata.radioStationFallback
            : '';
        if (fallback) {
          patch.station = fallback;
        }
      }
    }

    const isStopping = patch.mode === 'stop';
    const trackChanged =
      typeof patch.audiopath === 'string' &&
      patch.audiopath.trim().length > 0 &&
      normalizeSpotifyAudiopath(patch.audiopath) !== normalizeSpotifyAudiopath(ctx.state.audiopath);
    // Prevent overwriting a valid duration with zero/invalid values.
    if ('duration' in patch) {
      const nextDuration = patch.duration;
      const currentDuration = ctx.state.duration;
      if (
        typeof nextDuration !== 'number' ||
        (!isRadioState && !isLineInState && !isStopping && nextDuration <= 0)
      ) {
        delete (patch as any).duration;
      } else if (
        !isRadioState &&
        !isLineInState &&
        !trackChanged &&
        typeof currentDuration === 'number' &&
        currentDuration > 0
      ) {
        // keep the larger of the known durations
        (patch as any).duration = Math.max(nextDuration, currentDuration);
      }
    }

    const entries = Object.entries(patch);
    // Skip if nothing actually changes.
    if (!force && !entries.some(([key, value]) => (ctx.state as any)[key] !== value)) {
      return;
    }

    const nextState = applyZonePatch(ctx.state, patch);
    ctx.state = nextState;

    const isTimeOnlyUpdate = entries.length === 1 && entries[0][0] === 'time';
    const now = Date.now();
    // Avoid blasting Loxone clients with time-only ticks faster than ~1 Hz.
    if (force || !(isTimeOnlyUpdate && now - ctx.lastZoneBroadcastAt < 1000)) {
      ctx.lastZoneBroadcastAt = now;
      this.deps.notifier.notifyZoneStateChanged(ctx.state);
    }
    this.deps.onStatePatch?.(zoneId, patch, nextState);
    this.deps.syncGroupMembersPatch(zoneId, patch, force);
    const session = this.deps.audioManager.getSession(zoneId);
    if (session) {
      if ('time' in patch || 'duration' in patch) {
        const elapsed = typeof ctx.state.time === 'number' ? ctx.state.time : session.elapsed;
        const duration = typeof ctx.state.duration === 'number' ? ctx.state.duration : session.duration;
        this.deps.audioManager.updateSessionTiming(zoneId, elapsed, duration);
      }
      const hasMetadataUpdate =
        'title' in patch ||
        'artist' in patch ||
        'album' in patch ||
        'coverurl' in patch ||
        'station' in patch ||
        'audiopath' in patch;
      if (hasMetadataUpdate) {
        const base = session.metadata ?? { title: '', artist: '', album: '' };
        const nextMetadata = {
          title: ctx.state.title || base.title,
          artist: ctx.state.artist || base.artist,
          album: ctx.state.album || base.album,
          coverurl: ctx.state.coverurl || base.coverurl,
          duration:
            typeof ctx.state.duration === 'number' && ctx.state.duration > 0
              ? ctx.state.duration
              : base.duration,
          audiopath: ctx.state.audiopath || base.audiopath,
          station: ctx.state.station || base.station,
          trackId: base.trackId,
          stationIndex: base.stationIndex,
          queue: base.queue,
          queueIndex: base.queueIndex,
        };
        const prev = session.metadata;
        const unchanged =
          prev &&
          prev.title === nextMetadata.title &&
          prev.artist === nextMetadata.artist &&
          prev.album === nextMetadata.album &&
          prev.coverurl === nextMetadata.coverurl &&
          prev.duration === nextMetadata.duration &&
          prev.audiopath === nextMetadata.audiopath &&
          prev.station === nextMetadata.station;
        if (!unchanged) {
          this.deps.audioManager.updateSessionMetadata(zoneId, nextMetadata);
        }
      }
    }
    this.deps.notifyOutputMetadata(zoneId, ctx, patch);
  }

}

function resolveLoxoneType(_audiopath: string | undefined, audiotype?: number | null): number {
  if (audiotype === 3) {
    return FileType.LineIn;
  }
  return FileType.File;
}
