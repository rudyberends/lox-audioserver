import type { AudioManager, PlaybackMetadata, PlaybackSession, PlaybackSource } from '@/application/playback/audioManager';
import { applyPreferredPlaybackSettings } from '@/application/playback/PlaybackSettingsApplier';
import type { PlaybackPlan } from '@/application/playback/types/PlaybackPlan';
import type { ZoneContext } from '@/application/zones/internal/zoneTypes';
import { normalizeSpotifyAudiopath, parseSpotifyUser } from '@/application/zones/helpers/queueHelpers';
import type { ContentPort } from '@/ports/ContentPort';
import type { InputsPort } from '@/ports/InputsPort';
import type { ComponentLogger } from '@/shared/logging/logger';

export type ExecutePlaybackPlanArgs = {
  ctx: ZoneContext;
  plan: PlaybackPlan;
  content: ContentPort;
  inputs: InputsPort;
  log: ComponentLogger;
  audioManager: AudioManager;
  startAtSec?: number;
};

export async function executePlaybackPlan(args: ExecutePlaybackPlanArgs): Promise<PlaybackSession | null> {
  const { ctx, plan, content, inputs, log, audioManager, startAtSec } = args;
  applyPreferredPlaybackSettings(audioManager, ctx.id, plan.preferredSettings);
  const normalizedStartAt =
    typeof startAtSec === 'number' && Number.isFinite(startAtSec) && startAtSec > 0 ? startAtSec : undefined;
  const resolveStartAt = (source?: PlaybackSource | null): number | undefined => {
    if (!normalizedStartAt) {
      return undefined;
    }
    if (!source) {
      return undefined;
    }
    // For pipe sources (e.g. Spotify librespot), the ffmpeg seek is embedded in the stream via
    // startPositionMs and audioManager ignores startAtSec for pipes. However, startAt is still
    // needed so that zonePlayer initialises the ticker at the correct seek position instead of 0.
    return normalizedStartAt;
  };

  if (plan.playExternalLabel === 'musicassistant') {
    const result = await inputs.startStreamForAudiopath(
      ctx.id,
      ctx.name,
      plan.audiopath,
      {
        flow: true,
        parentAudiopath: plan.metadata.station,
        startItem: plan.audiopath,
        startIndex: typeof plan.metadata.stationIndex === 'number' ? plan.metadata.stationIndex : undefined,
        zoneConfig: ctx.config,
      },
    );
    if (result.playbackSource) {
      return ctx.player.playExternal(
        'musicassistant',
        result.playbackSource,
        plan.metadata,
        resolveStartAt(result.playbackSource),
      );
    }
    if (result.outputOnly) {
      return ctx.player.playExternal('musicassistant', null, plan.metadata);
    }
    return null;
  }

  if (plan.kind === 'provider-stream' && plan.playExternalLabel) {
    const result = await content.resolvePlaybackSource({
      zoneId: plan.zoneId,
      zoneName: plan.zoneName,
      audiopath: plan.audiopath,
    });
    if (result.playbackSource) {
      return ctx.player.playExternal(
        plan.playExternalLabel,
        result.playbackSource,
        plan.metadata,
        resolveStartAt(result.playbackSource),
      );
    }
    if (result.outputOnly) {
      return ctx.player.playExternal(plan.playExternalLabel, null, plan.metadata);
    }
    return null;
  }

  if (plan.playExternalLabel === 'spotify') {
    const offloadEnabled = ctx.config.inputs?.spotify?.offload === true;
    const parsedUser = parseSpotifyUser(plan.audiopath);
    // When the queue normalizes to `spotify:...`, parsing yields `nouser`. Never pass `nouser`
    // to the spotify input, since it overrides the configured/default account selection.
    const accountId = parsedUser && parsedUser !== 'nouser' ? parsedUser : undefined;
    let playbackSource: PlaybackSource | null = null;
    if (!offloadEnabled) {
      const seekPositionMs = normalizedStartAt ? Math.max(0, Math.round(normalizedStartAt * 1000)) : 0;
      playbackSource = await inputs.getPlaybackSourceForUri(
        ctx.id,
        normalizeSpotifyAudiopath(plan.audiopath),
        seekPositionMs,
        accountId,
      );
    }
    log.debug('startQueuePlayback spotify', {
      zoneId: ctx.id,
      audiopath: plan.audiopath,
      hasPlaybackSource: Boolean(playbackSource),
      playbackKind: playbackSource?.kind,
      connectEnabled: offloadEnabled,
      queueSize: ctx.queue.items.length,
    });
    if (!playbackSource && !offloadEnabled) {
      log.warn('spotify input not ready; blocking playback to avoid skips', { zoneId: ctx.id });
      return null;
    }
    const playbackIsPipe = playbackSource?.kind === 'pipe';
    const queueUris = ctx.queue.items.map((q) => q.audiopath);
    const queueIndex = ctx.queueController.currentIndex();
    const meta = {
      ...plan.metadata,
      queue: queueUris,
      queueIndex,
    } as PlaybackMetadata;
    const startAt = resolveStartAt(playbackSource);
    const session = ctx.player.playExternal('spotify', playbackSource, meta, startAt);
    if (playbackIsPipe) {
      // Preserve queue/trackId context for spotify session tracking.
      inputs.markSessionActive(ctx.id, meta);
    }
    return session;
  }

  return ctx.player.playUri(plan.audiopath, plan.metadata, normalizedStartAt);
}
