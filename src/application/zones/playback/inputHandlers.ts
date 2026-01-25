import type { PlaybackMetadata, PlaybackSource, CoverArtPayload } from '@/application/playback/audioManager';
import type { ZoneAudioHelpers } from '@/application/zones/internal/zoneAudioHelpers';
import type { ZoneContext } from '@/application/zones/internal/zoneTypes';
import { clampVolumeForZone } from '@/application/zones/helpers/stateHelpers';
import { AudioType, FileType } from '@/domain/loxone/enums';
import type { LoxoneZoneState } from '@/domain/loxone/types';
import type { ComponentLogger } from '@/shared/logging/logger';
import { allowsInputCover, allowsInputMetadata, allowsInputVolume, isActiveInputMode } from '@/application/zones/playback/guards';
import { resolveInputStartDecision } from '@/application/zones/playback/commandMapping';
import { computeQueueItemMetadataUpdate } from '@/application/zones/playback/metadata';
import { buildInputMetadataPatch } from '@/application/zones/playback/patchBuilder';
import { handleRadioMetadataUpdate } from '@/application/zones/playback/providerHandlers/radio';
import { isSameAudiopath } from '@/application/zones/playback/targetResolution';

type InputCoordinator = {
  getZone: (zoneId: number) => ZoneContext | undefined;
  log: ComponentLogger;
  audioHelpers: ZoneAudioHelpers;
  applyPatch: (zoneId: number, patch: Partial<LoxoneZoneState>) => void;
  setInputMode: (ctx: ZoneContext | undefined, mode: ZoneContext['inputMode']) => void;
  stopExternalInputSessions: (
    zoneId: number,
    prevInput: ZoneContext['inputMode'],
    nextInput: ZoneContext['inputMode'],
  ) => void;
  stopSpotifyOutputs: (outputs: ZoneContext['outputs']) => void;
  requestLineInStop: (inputId: string) => void;
  seekExistingQueueInternal: (ctx: ZoneContext, target: string) => boolean;
  recentsRecord: (zoneId: number, item: ZoneContext['queue']['items'][number]) => Promise<void>;
  buildAbsoluteCoverUrl: (pathname: string) => string;
  updateInputMetadata: (zoneId: number, metadata: Partial<PlaybackMetadata>) => void;
};

export function playInputSource(args: {
  coordinator: InputCoordinator;
  zoneId: number;
  label: string;
  playbackSource: PlaybackSource;
  metadata?: PlaybackMetadata;
}): void {
  const { coordinator, zoneId, label, playbackSource, metadata } = args;
  const ctx = coordinator.getZone(zoneId);
  if (!ctx) {
    return;
  }
  const decision = resolveInputStartDecision(label);
  if (!decision) {
    return;
  }
  const mode = decision.mode;
  // Avoid re-dispatching outputs when the same input/track is already playing.
  const currentAudiopath = ctx.queueController.current()?.audiopath ?? ctx.state.audiopath ?? '';
  if (metadata?.audiopath && isActiveInputMode(ctx, mode) && isSameAudiopath(currentAudiopath, metadata.audiopath)) {
    const nextPipe = playbackSource?.kind === 'pipe'
      ? (playbackSource as { stream?: NodeJS.ReadableStream }).stream
      : null;
    const currentState = ctx.player.getState();
    const currentPipe =
      currentState.playbackSource?.kind === 'pipe'
        ? (currentState.playbackSource as { stream?: NodeJS.ReadableStream }).stream
        : null;
    if (nextPipe && nextPipe !== currentPipe) {
      // New pipe stream for the same audiopath (e.g., line-in reconnect): restart input.
    } else {
      coordinator.updateInputMetadata(zoneId, metadata);
      return;
    }
  }
  const prevInput = ctx.inputMode;
  const prevAudiopath = ctx.state.audiopath;
  coordinator.setInputMode(ctx, mode);
  if (prevInput === 'linein' && mode !== 'linein') {
    const inputId = coordinator.audioHelpers.parseLineInInputId(prevAudiopath);
    if (inputId) {
      coordinator.log.info('line-in input cleared on input switch', {
        zoneId: ctx.id,
        from: prevInput,
        to: mode,
        inputId,
      });
      coordinator.requestLineInStop(inputId);
    }
  }
  coordinator.stopExternalInputSessions(zoneId, prevInput, mode);
  if (mode !== 'spotify') {
    coordinator.stopSpotifyOutputs(ctx.outputs);
  }
  ctx.queue.authority = decision.queueAuthority;
  ctx.inputAdapter.playInput(label, playbackSource, metadata);
}

export function stopInputSource(args: { coordinator: InputCoordinator; zoneId: number }): void {
  const { coordinator, zoneId } = args;
  const ctx = coordinator.getZone(zoneId);
  if (!ctx) {
    return;
  }
  coordinator.setInputMode(ctx, null);
  ctx.player.stop('input_stop');
}

export function pauseInputSource(args: { coordinator: InputCoordinator; zoneId: number }): void {
  const { coordinator, zoneId } = args;
  const ctx = coordinator.getZone(zoneId);
  if (!ctx) {
    return;
  }
  if (ctx.activeInput && ctx.activeInput !== 'spotify') {
    coordinator.stopSpotifyOutputs(ctx.outputs);
  }
  ctx.player.pause();
}

export function resumeInputSource(args: { coordinator: InputCoordinator; zoneId: number }): void {
  const { coordinator, zoneId } = args;
  const ctx = coordinator.getZone(zoneId);
  if (!ctx) {
    return;
  }
  if (ctx.activeInput && ctx.activeInput !== 'spotify') {
    coordinator.stopSpotifyOutputs(ctx.outputs);
  }
  ctx.player.resume();
}

export function updateInputMetadata(args: {
  coordinator: InputCoordinator;
  zoneId: number;
  metadata: Partial<PlaybackMetadata>;
}): void {
  const { coordinator, zoneId, metadata } = args;
  const ctx = coordinator.getZone(zoneId);
  if (!ctx) {
    return;
  }
  if (!allowsInputMetadata(ctx.activeInput)) {
    return;
  }
  ctx.player.updateMetadata(metadata as PlaybackMetadata);
  const didSeek =
    ctx.inputMode === 'musicassistant' && metadata.audiopath
      ? coordinator.seekExistingQueueInternal(ctx, metadata.audiopath)
      : false;

  // Propagate richer metadata into the current queue item so recents/queue
  // can retain album/artist/cover details (especially for Music Assistant streams).
  const current = ctx.queueController.current();
  if (current) {
    const { changed, updates } = computeQueueItemMetadataUpdate(current, metadata);
    if (changed) {
      Object.assign(current, updates);
      void coordinator.recentsRecord(zoneId, current);
    }
  }

  const patch = buildInputMetadataPatch({
    metadata,
    stateTitle: ctx.state.title,
    zoneName: ctx.name,
    currentItem: current,
    currentIndex: ctx.queueController.currentIndex(),
    didSeek,
    queueAuthority: ctx.queue.authority,
    stateIcontype: ctx.state.icontype,
  });
  if (ctx.inputMode === 'linein') {
    const hasMetadata = Boolean(metadata.title || metadata.artist || metadata.album || metadata.coverurl);
    const prefersFile =
      hasMetadata ||
      ctx.state.audiotype === AudioType.File ||
      ctx.state.audiotype === AudioType.Playlist;
    if (prefersFile) {
      patch.audiotype = AudioType.File;
      patch.type = FileType.File;
    } else {
      if (typeof ctx.state.audiotype === 'number') {
        patch.audiotype = ctx.state.audiotype;
      }
      if (typeof ctx.state.type === 'number') {
        patch.type = ctx.state.type;
      }
    }
  }
  if (Object.keys(patch).length > 0) {
    coordinator.applyPatch(zoneId, patch);
  }
}

export function updateRadioMetadata(args: {
  coordinator: InputCoordinator;
  zoneId: number;
  metadata: { title: string; artist: string };
}): void {
  const { coordinator, zoneId, metadata } = args;
  const ctx = coordinator.getZone(zoneId);
  if (!ctx) {
    return;
  }
  const result = handleRadioMetadataUpdate({
    state: ctx.state,
    zoneName: ctx.name,
    metadata,
    audioHelpers: coordinator.audioHelpers,
    radioStationFallback: typeof ctx.metadata.radioStationFallback === 'string'
      ? ctx.metadata.radioStationFallback
      : undefined,
  });
  if (!result) {
    return;
  }
  if (result.actions) {
    for (const action of result.actions) {
      if (action.type === 'setRadioStationFallback') {
        ctx.metadata.radioStationFallback = action.value;
      }
    }
  }
  if (Object.keys(result.patch).length > 0) {
    coordinator.applyPatch(zoneId, result.patch);
  }
}

export function updateInputCover(args: {
  coordinator: InputCoordinator;
  zoneId: number;
  cover?: CoverArtPayload;
}): string | undefined {
  const { coordinator, zoneId, cover } = args;
  const ctx = coordinator.getZone(zoneId);
  if (!ctx) {
    return undefined;
  }
  if (!allowsInputCover(ctx.activeInput)) {
    return undefined;
  }
  const relativePath = ctx.player.updateCover(cover) ?? '';
  const baseUrl =
    relativePath && cover ? coordinator.buildAbsoluteCoverUrl(relativePath) : '';
  const coverUrl = baseUrl ? `${baseUrl}?t=${Date.now()}` : '';
  const current = ctx.queueController.current();
  if (current) {
    current.coverurl = coverUrl;
  }
  return coverUrl || undefined;
}

export function updateInputVolume(args: {
  coordinator: InputCoordinator;
  zoneId: number;
  volume: number;
}): void {
  const { coordinator, zoneId, volume } = args;
  const ctx = coordinator.getZone(zoneId);
  if (!ctx) {
    return;
  }
  if (!allowsInputVolume(ctx.activeInput)) {
    return;
  }
  const level = clampVolumeForZone(ctx.config, volume);
  ctx.player.setVolume(level);
}

export function updateInputTiming(args: {
  coordinator: InputCoordinator;
  zoneId: number;
  elapsed: number;
  duration: number;
}): void {
  const { coordinator, zoneId, elapsed, duration } = args;
  const ctx = coordinator.getZone(zoneId);
  if (!ctx) {
    return;
  }
  const safeDuration = Math.max(0, Math.round(duration));
  const safeElapsed = Math.max(0, Math.round(elapsed));
  const boundedElapsed =
    safeDuration > 0 ? Math.min(safeElapsed, safeDuration) : safeElapsed;
  ctx.player.updateTiming(boundedElapsed, safeDuration);
}
