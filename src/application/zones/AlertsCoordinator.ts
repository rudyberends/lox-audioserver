import type { ComponentLogger } from '@/shared/logging/logger';
import type { PlaybackMetadata } from '@/application/playback/audioManager';
import type { AlertMediaResource } from '@/application/alerts/types';
import type { LoxoneZoneState } from '@/domain/loxone/types';
import type { AlertSnapshot, ZoneContext } from '@/application/zones/internal/zoneTypes';
import { AudioType } from '@/domain/loxone/enums';
import { cloneQueueState, clampVolumeForZone } from '@/application/zones/helpers/stateHelpers';
import type { ZoneAudioHelpers } from '@/application/zones/internal/zoneAudioHelpers';
import { PlaybackCoordinator } from '@/application/zones/PlaybackCoordinator';
import { ZoneRepository } from '@/application/zones/ZoneRepository';

const MIN_ALERT_DURATION_MS = 20000;
const ALERT_STOP_MARGIN_MS = 750;

type AlertsCoordinatorDeps = {
  zones: ZoneRepository;
  playbackCoordinator: PlaybackCoordinator;
  applyPatch: (zoneId: number, patch: Partial<LoxoneZoneState>, force?: boolean) => void;
  log: ComponentLogger;
  audioHelpers: ZoneAudioHelpers;
};

export class AlertsCoordinator {
  private readonly zoneRepo: ZoneRepository;
  private readonly playbackCoordinator: PlaybackCoordinator;
  private readonly applyPatch: (
    zoneId: number,
    patch: Partial<LoxoneZoneState>,
    force?: boolean,
  ) => void;
  private readonly log: ComponentLogger;
  private readonly audioHelpers: ZoneAudioHelpers;

  constructor(deps: AlertsCoordinatorDeps) {
    this.zoneRepo = deps.zones;
    this.playbackCoordinator = deps.playbackCoordinator;
    this.applyPatch = deps.applyPatch;
    this.log = deps.log;
    this.audioHelpers = deps.audioHelpers;
  }

  public async startAlert(
    zoneId: number,
    type: string,
    media: AlertMediaResource,
    volume: number,
  ): Promise<void> {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }

    await this.stopAlert(zoneId);

    await this.waitForOutputReady(ctx);

    const snapshot = this.createAlertSnapshot(ctx);
    const rawDurationMs =
      !media.loop && typeof media.duration === 'number' && media.duration > 0
        ? Math.round(media.duration * 1000)
        : undefined;
    const durationMs = media.loop
      ? undefined
      : rawDurationMs !== undefined
        ? Math.max(rawDurationMs + ALERT_STOP_MARGIN_MS, 0)
        : MIN_ALERT_DURATION_MS;
    const playUrl = media.url;
    const title = media.title ?? type;

    ctx.alert = {
      type,
      title,
      url: playUrl,
      durationMs,
      snapshot,
    };

    this.playbackCoordinator.setInputMode(ctx, 'alert');

    const clampedVolume = clampVolumeForZone(ctx.config, volume);
    ctx.player.setVolume(clampedVolume);

    const metadata: PlaybackMetadata = {
      title,
      artist: '',
      album: '',
      coverurl: '',
      duration: durationMs ? Math.round(durationMs / 1000) : media.duration,
      audiopath: playUrl,
      station: '',
    };

    const session = ctx.player.playUri(playUrl, metadata);
    if (!session) {
      this.log.warn('alert playback skipped; no session', { zoneId, type });
      await this.stopAlert(zoneId);
      return;
    }

    if (durationMs && durationMs > 0) {
      const clampedMs = Math.min(durationMs + 150, 2147483647);
      ctx.alert.stopTimer = setTimeout(() => {
        void this.stopAlert(zoneId);
      }, clampedMs);
    }

    this.applyPatch(zoneId, {
      title,
      artist: '',
      album: '',
      coverurl: '',
      audiopath: media.url,
      station: '',
      mode: 'play',
      clientState: 'on',
      power: 'on',
      audiotype: AudioType.File,
      type: this.audioHelpers.resolveAlertEventType(type),
      sourceName: ctx.name,
    });
  }

  public async stopAlert(zoneId: number): Promise<void> {
    const ctx = this.zoneRepo.get(zoneId);
    const activeAlert = ctx?.alert;
    if (!ctx || !activeAlert) {
      return;
    }
    if (activeAlert.stopTimer) {
      clearTimeout(activeAlert.stopTimer);
    }
    ctx.alert = undefined;

    try {
      ctx.player.stop('alert_stop');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.debug('alert stop failed to stop player cleanly', { zoneId, message });
    }

    this.playbackCoordinator.setInputMode(ctx, activeAlert.snapshot.inputMode);
    ctx.activeOutput = activeAlert.snapshot.activeOutput;
    ctx.activeOutputTypes = new Set(activeAlert.snapshot.activeOutputTypes);
    ctx.queue.shuffle = activeAlert.snapshot.queue.shuffle;
    ctx.queue.repeat = activeAlert.snapshot.queue.repeat;
    ctx.queueController.setItems(
      activeAlert.snapshot.queue.items,
      activeAlert.snapshot.queue.currentIndex,
    );

    const restoreVolume = clampVolumeForZone(ctx.config, activeAlert.snapshot.volume);
    ctx.player.setVolume(restoreVolume);

    this.applyPatch(zoneId, {
      ...activeAlert.snapshot.statePatch,
      mode: activeAlert.snapshot.mode,
      clientState: 'on',
      power: 'on',
    });

    if (activeAlert.snapshot.mode === 'play') {
      const current = ctx.queueController.current();
      if (current) {
        const session = await this.playbackCoordinator.startQueuePlayback(ctx, current.audiopath, {
          title: current.title,
          artist: current.artist,
          album: current.album,
          coverurl: current.coverurl,
          audiopath: current.audiopath,
          duration: current.duration,
          station: current.station,
          isRadio: this.audioHelpers.isRadioAudiopath(current.audiopath, current.audiotype),
        });
        if (session) {
          const resumedAudiotype = this.audioHelpers.getStateAudiotype(ctx, current);
          const sourceName = this.audioHelpers.resolveSourceName(resumedAudiotype, ctx, current);
          this.applyPatch(zoneId, {
            title: current.title,
            artist: current.artist,
            album: current.album,
            coverurl: current.coverurl,
            audiopath: current.audiopath,
            station: current.station,
            qindex: ctx.queueController.currentIndex(),
            qid: current.unique_id,
            mode: 'play',
            clientState: 'on',
            power: 'on',
            ...(resumedAudiotype != null ? { audiotype: resumedAudiotype } : {}),
            type: this.audioHelpers.getStateFileType(),
            ...(sourceName ? { sourceName } : {}),
          });
        }
      }
    } else if (activeAlert.snapshot.mode === 'pause') {
      this.applyPatch(zoneId, { mode: 'pause', clientState: 'on', power: 'on' });
    } else if (activeAlert.snapshot.mode === 'stop') {
      this.applyPatch(zoneId, { mode: 'stop', clientState: 'on', power: 'on' });
    }
  }

  private createAlertSnapshot(ctx: ZoneContext): AlertSnapshot {
    const queueClone = cloneQueueState(ctx.queue);
    return {
      mode: ctx.state.mode,
      inputMode: ctx.inputMode,
      activeOutput: ctx.activeOutput,
      activeOutputTypes: new Set(ctx.activeOutputTypes),
      volume: ctx.state.volume ?? 0,
      queue: queueClone,
      statePatch: {
        title: ctx.state.title,
        artist: ctx.state.artist,
        album: ctx.state.album,
        coverurl: ctx.state.coverurl,
        audiopath: ctx.state.audiopath,
        station: ctx.state.station,
        qindex: ctx.state.qindex,
        qid: ctx.state.qid,
        audiotype: ctx.state.audiotype,
        sourceName: ctx.state.sourceName,
      },
    };
  }

  private async waitForOutputReady(ctx: ZoneContext, timeoutMs = 2000): Promise<void> {
    const outputs = ctx.outputs.filter((t) => t.type !== 'spotify-input');
    if (!outputs.length) {
      return;
    }
    const start = Date.now();
    const ready = (): boolean =>
      outputs.some((t) => {
        const maybe = (t as any).isReady;
        if (typeof maybe === 'function') {
          try {
            return maybe.call(t) === true;
          } catch {
            return false;
          }
        }
        return true;
      });
    if (ready()) {
      return;
    }
    return new Promise<void>((resolve) => {
      const tick = () => {
        if (ready() || Date.now() - start >= timeoutMs) {
          resolve();
          return;
        }
        setTimeout(tick, 100);
      };
      setTimeout(tick, 50);
    });
  }
}
