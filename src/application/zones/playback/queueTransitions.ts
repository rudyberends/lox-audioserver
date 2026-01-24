import type { PlaybackMetadata, PlaybackSession } from '@/application/playback/audioManager';
import type { ZoneAudioHelpers } from '@/application/zones/internal/zoneAudioHelpers';
import type { QueueAuthority, ZoneContext } from '@/application/zones/internal/zoneTypes';
import type { LoxoneZoneState } from '@/domain/loxone/types';
import type { QueueItem } from '@/ports/types/queueTypes';
import type { ZoneOutput } from '@/ports/OutputsTypes';
import { buildQueueItemPlaybackPatch } from '@/application/zones/playback/patchBuilder';

type QueueTransitionCoordinator = {
  getZone: (zoneId: number) => ZoneContext | undefined;
  isLocalQueueAuthority: (authority: QueueAuthority | undefined | null) => boolean;
  startQueuePlayback: (
    ctx: ZoneContext,
    audiopath: string,
    metadata?: PlaybackMetadata,
    options?: { startAtSec?: number },
  ) => Promise<PlaybackSession | null>;
  applyPatch: (zoneId: number, patch: Partial<LoxoneZoneState>) => void;
  dispatchOutputs: (
    ctx: ZoneContext,
    outputs: ZoneOutput[],
    action: 'play' | 'pause' | 'resume' | 'stop',
    payload: PlaybackSession | null | undefined,
  ) => void;
  recentsRecord: (zoneId: number, item: QueueItem) => Promise<void>;
  audioHelpers: ZoneAudioHelpers;
};

export async function stepQueueAsync(args: {
  coordinator: QueueTransitionCoordinator;
  zoneId: number;
  delta: number;
}): Promise<void> {
  const { coordinator, zoneId, delta } = args;
  const ctx = coordinator.getZone(zoneId);
  if (!ctx || ctx.queue.items.length === 0) {
    return;
  }
  if (!coordinator.isLocalQueueAuthority(ctx.queue.authority)) {
    return;
  }

  const nextIndex = ctx.queueController.step(delta);
  if (nextIndex < 0) {
    return;
  }

  const item = ctx.queueController.current();
  if (!item) {
    return;
  }
  const session = await coordinator.startQueuePlayback(ctx, item.audiopath, {
    title: item.title,
    artist: item.artist,
    album: item.album,
    coverurl: item.coverurl,
    audiopath: item.audiopath,
    duration: item.duration,
    station: item.station,
    isRadio: coordinator.audioHelpers.isRadioAudiopath(item.audiopath, item.audiotype),
  });
  if (session) {
    const basePatch = buildQueueItemPlaybackPatch(ctx, item, nextIndex, coordinator.audioHelpers);
    coordinator.applyPatch(zoneId, {
      ...basePatch,
      mode: 'play',
      clientState: 'on',
      power: 'on',
      duration: typeof item.duration === 'number' ? Math.max(0, Math.round(item.duration)) : undefined,
      queueAuthority: ctx.queue.authority,
      time: 0,
    });
  }
}

export async function handleEndOfTrack(args: {
  coordinator: QueueTransitionCoordinator;
  ctx: ZoneContext;
}): Promise<void> {
  const { coordinator, ctx } = args;
  const queueSize = ctx.queue.items.length;
  if (queueSize === 0) {
    const stopped = ctx.player.stop('queue_empty');
    coordinator.dispatchOutputs(ctx, ctx.outputs, 'stop', stopped);
    return;
  }

  if (!coordinator.isLocalQueueAuthority(ctx.queue.authority)) {
    return;
  }

  const nextIndex = ctx.queueController.nextIndex();

  if (nextIndex < 0) {
    const stopped = ctx.player.stop('queue_end');
    coordinator.dispatchOutputs(ctx, ctx.outputs, 'stop', stopped);
    return;
  }

  ctx.queueController.setCurrentIndex(nextIndex);
  const next = ctx.queueController.current();
  if (!next) {
    const stopped = ctx.player.stop('queue_invalid_next');
    coordinator.dispatchOutputs(ctx, ctx.outputs, 'stop', stopped);
    return;
  }
  const session = await coordinator.startQueuePlayback(ctx, next.audiopath, {
    title: next.title,
    artist: next.artist,
    album: next.album,
    coverurl: next.coverurl,
    audiopath: next.audiopath,
    duration: next.duration,
    station: next.station,
  });
  if (session) {
    const basePatch = buildQueueItemPlaybackPatch(
      ctx,
      next,
      ctx.queueController.currentIndex(),
      coordinator.audioHelpers,
    );
    coordinator.applyPatch(ctx.id, {
      ...basePatch,
      mode: 'play',
      clientState: 'on',
      power: 'on',
      time: 0,
    });
    void coordinator.recentsRecord(ctx.id, next);
    return;
  }

  // If we failed to start the next track, stop cleanly.
  const stopped = ctx.player.stop('queue_next_failed');
  coordinator.dispatchOutputs(ctx, ctx.outputs, 'stop', stopped);
}
