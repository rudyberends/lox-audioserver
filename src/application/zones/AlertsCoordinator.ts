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
// Keep alerts playing long enough for slower outputs to actually become audible.
// This is a safety net; we also try to reduce output buffering for alerts where possible.
const MIN_ALERT_AUDIBLE_MS = 2500;
const ALERT_STOP_MARGIN_MS = 750;
const SHORT_ALERT_SEC = 6;
const GOOGLECAST_SHORT_ALERT_PAD_TAIL_SEC = 8;
const SQUEEZELITE_SHORT_ALERT_PAD_TAIL_SEC = 4;

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
	    const reportedDurationSec =
	      !media.loop && typeof media.duration === 'number' && media.duration > 0
	        ? Math.max(0, Math.round(media.duration))
	        : undefined;
	    const padTailSec =
	      /tts/i.test(type) &&
	      !media.loop &&
	      typeof media.duration === 'number' &&
	      media.duration > 0 &&
	      media.duration <= SHORT_ALERT_SEC
	        ? this.hasCastOutput(ctx)
	          ? GOOGLECAST_SHORT_ALERT_PAD_TAIL_SEC
	          : this.hasOutputType(ctx, 'squeezelite')
	            ? SQUEEZELITE_SHORT_ALERT_PAD_TAIL_SEC
	            : 0
	        : 0;
	    const durationMs = media.loop
	      ? undefined
	      : rawDurationMs !== undefined
	        ? Math.max(rawDurationMs + ALERT_STOP_MARGIN_MS + padTailSec * 1000, MIN_ALERT_AUDIBLE_MS, 0)
	        : MIN_ALERT_DURATION_MS;
	    const playUrl = padTailSec > 0 ? appendAlertPadTail(media.url, padTailSec) : media.url;
	    const title = media.title ?? type;

	    ctx.alert = {
	      type,
	      title,
	      url: playUrl,
	      reportedDurationSec,
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
	      // Use a longer internal duration so outputs have time to start and render the alert.
	      // Loxone-facing duration is overridden separately via `reportedDurationSec`.
	      duration: durationMs ? Math.round(durationMs / 1000) : reportedDurationSec ?? media.duration,
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
	      audiopath: playUrl,
	      station: '',
	      mode: 'play',
	      clientState: 'on',
	      power: 'on',
      audiotype: AudioType.File,
      type: this.audioHelpers.resolveAlertEventType(type),
      sourceName: ctx.name,
    });
	  }

		  private hasOutputType(ctx: ZoneContext, type: string): boolean {
		    return (ctx.outputs ?? []).some((output) => output.type === type);
		  }

      private hasCastOutput(ctx: ZoneContext): boolean {
        return (ctx.outputs ?? []).some(
          (output) => output.type === 'googleCast' || output.type.endsWith('-cast'),
        );
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
        const resumeAtSecRaw = Number(activeAlert.snapshot.statePatch.time ?? 0);
        const resumeAtSec =
          Number.isFinite(resumeAtSecRaw) && resumeAtSecRaw > 0 ? Math.round(resumeAtSecRaw) : undefined;
        const session = await this.playbackCoordinator.startQueuePlayback(ctx, current.audiopath, {
          title: current.title,
          artist: current.artist,
          album: current.album,
          coverurl: current.coverurl,
          audiopath: current.audiopath,
          duration: current.duration,
          station: current.station,
          isRadio: this.audioHelpers.isRadioAudiopath(current.audiopath, current.audiotype),
        }, {
          startAtSec: resumeAtSec,
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
        time: ctx.state.time,
        duration: ctx.state.duration,
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

function appendAlertPadTail(url: string, padTailSec: number): string {
  if (!/^alerts(?:-loop)?:\/\//i.test(url)) {
    return url;
  }
  const [base, rawQuery = ''] = url.split('?', 2);
  const params = new URLSearchParams(rawQuery);
  params.set('padTailSec', String(Math.max(0, Math.round(padTailSec))));
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}
