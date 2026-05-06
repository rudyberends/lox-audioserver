import type { PlaybackMetadata, PlaybackSession } from '@/application/playback/audioManager';
import type { ZoneAudioHelpers } from '@/application/zones/internal/zoneAudioHelpers';
import type { ZoneContext } from '@/application/zones/internal/zoneTypes';
import { clampVolumeForZone, getZoneDefaultVolume } from '@/application/zones/helpers/stateHelpers';
import type { LoxoneZoneState } from '@/domain/loxone/types';
import type { ZoneOutput } from '@/ports/OutputsTypes';
import {
  buildMetadataPatch,
  buildPositionPatch,
  buildResumedPatch,
  buildStartedPatch,
  buildStoppedPatch,
  buildVolumePatch,
} from '@/application/zones/playback/patchBuilder';
import { resolveZoneStateControllerId } from '@/application/zones/state/types';

type PlayerListenerCoordinator = {
  getZone: (zoneId: number) => ZoneContext | undefined;
  applyPatch: (zoneId: number, patch: Partial<LoxoneZoneState>) => void;
  dispatchOutputs: (
    ctx: ZoneContext,
    outputs: ZoneOutput[],
    action: 'play' | 'pause' | 'resume' | 'stop',
    payload: PlaybackSession | null | undefined,
  ) => void;
  dispatchVolume: (ctx: ZoneContext, outputs: ZoneOutput[], volume: number) => void;
  buildAbsoluteCoverUrl: (pathname: string) => string;
  audioHelpers: ZoneAudioHelpers;
  stopAlert: (zoneId: number) => Promise<void>;
  handleEndOfTrack: (ctx: ZoneContext) => Promise<void>;
  handlePlaybackError: (
    zoneId: number,
    reason: string | undefined,
    source: 'player',
    extra: { zone: string; sourceMac: string },
  ) => void;
};

export function attachPlayerListeners(args: {
  coordinator: PlayerListenerCoordinator;
  player: ZoneContext['player'];
  outputs: ZoneOutput[];
  zoneId: number;
  zoneName: string;
  sourceMac: string;
}): void {
  const { coordinator, player, outputs, zoneId, zoneName, sourceMac } = args;
  player.on('paused', (session) => onPlayerPaused(coordinator, zoneId, outputs, session));
  player.on('started', (session) => onPlayerStarted(coordinator, zoneId, outputs, session));
  player.on('resumed', (session) => onPlayerResumed(coordinator, zoneId, outputs, session));
  player.on('stopped', (session) => onPlayerStopped(coordinator, zoneId, outputs, session));
  player.on('position', (time, duration) => onPlayerPosition(coordinator, zoneId, time, duration));
  player.on('metadata', (metadata) => onPlayerMetadata(coordinator, zoneId, metadata));
  player.on('cover', (relative) => onPlayerCover(coordinator, zoneId, relative));
  player.on('volume', (level) => onPlayerVolume(coordinator, zoneId, outputs, level));
  player.on('ended', () => onPlayerEnded(coordinator, zoneId));
  player.on('error', (reason) => onPlayerError(coordinator, zoneId, reason, zoneName, sourceMac));
}

function onPlayerPaused(
  coordinator: PlayerListenerCoordinator,
  zoneId: number,
  outputs: ZoneOutput[],
  session: PlaybackSession | null | undefined,
): void {
  const ctxLocal = coordinator.getZone(zoneId);
  if (ctxLocal) {
    coordinator.dispatchOutputs(ctxLocal, outputs, 'pause', session);
  }
  coordinator.applyPatch(zoneId, { mode: 'pause', clientState: 'on', power: 'on' });
}

function onPlayerStarted(
  coordinator: PlayerListenerCoordinator,
  zoneId: number,
  outputs: ZoneOutput[],
  session: PlaybackSession | null | undefined,
): void {
  const ctxReset = coordinator.getZone(zoneId);
  if (ctxReset) {
    ctxReset.outputTimingActive = false;
    ctxReset.lastOutputTimingAt = 0;
  }
  const ctxLocal = coordinator.getZone(zoneId);
  if (ctxLocal) {
    coordinator.dispatchOutputs(ctxLocal, outputs, 'play', session);
  }
  const ctx = coordinator.getZone(zoneId);
  if (ctx) {
    const volume =
      ctx.state.mode === 'stop'
        ? getZoneDefaultVolume(ctx.config)
        : clampVolumeForZone(ctx.config, ctx.state.volume);
    coordinator.dispatchVolume(ctx, outputs, volume);
    const patch = {
      ...buildStartedPatch({ ctx, session, audioHelpers: coordinator.audioHelpers }),
      volume,
    };
    coordinator.applyPatch(zoneId, patch);
  }
}

function onPlayerResumed(
  coordinator: PlayerListenerCoordinator,
  zoneId: number,
  outputs: ZoneOutput[],
  session: PlaybackSession | null | undefined,
): void {
  const ctxReset = coordinator.getZone(zoneId);
  if (ctxReset) {
    ctxReset.outputTimingActive = false;
    ctxReset.lastOutputTimingAt = 0;
  }
  const ctxLocal = coordinator.getZone(zoneId);
  if (ctxLocal) {
    coordinator.dispatchOutputs(ctxLocal, outputs, 'resume', session);
  }
  const ctx = coordinator.getZone(zoneId);
  if (ctx) {
    coordinator.applyPatch(zoneId, buildResumedPatch({ ctx, audioHelpers: coordinator.audioHelpers }));
  }
}

function onPlayerStopped(
  coordinator: PlayerListenerCoordinator,
  zoneId: number,
  outputs: ZoneOutput[],
  session: PlaybackSession | null | undefined,
): void {
  const ctxReset = coordinator.getZone(zoneId);
  if (ctxReset) {
    ctxReset.outputTimingActive = false;
    ctxReset.lastOutputTimingAt = 0;
  }
  const ctxLocal = coordinator.getZone(zoneId);
  if (ctxLocal) {
    coordinator.dispatchOutputs(ctxLocal, outputs, 'stop', session);
  }
  coordinator.applyPatch(zoneId, buildStoppedPatch());
}

function onPlayerPosition(
  coordinator: PlayerListenerCoordinator,
  zoneId: number,
  time: number,
  duration: number,
): void {
  const ctx = coordinator.getZone(zoneId);
  if (!ctx) {
    return;
  }
  const controllerId = resolveZoneStateControllerId(ctx.config);
  const stateAudiopath = typeof ctx.state.audiopath === 'string' ? ctx.state.audiopath.trim() : '';
  if (controllerId !== 'internal' && !stateAudiopath) {
    // External state controller owns progress when no local audiopath is active.
    return;
  }
  if (coordinator.audioHelpers.isRadioAudiopath(ctx.state.audiopath, ctx.state.audiotype)) {
    if (ctx.state.time !== 0 || ctx.state.duration !== 0) {
      coordinator.applyPatch(
        zoneId,
        buildPositionPatch({ time: 0, duration: 0, forceDurationZero: true }),
      );
    }
    return;
  }
  // For controllable radio (e.g. Radio Paradise), duration is owned by metadata updates.
  // Timing updates may carry block/stream durations and should not override the current track duration.
  const suppressDuration = ctx.metadata.radioControllable === true;
  const alertDurationOverride =
    ctx.alert && typeof ctx.alert.reportedDurationSec === 'number' && ctx.alert.reportedDurationSec > 0
      ? Math.round(ctx.alert.reportedDurationSec)
      : null;
  const now = Date.now();
  const safeDuration = suppressDuration
    ? 0
    : Math.max(0, alertDurationOverride ?? duration);
  const safeTime = Math.max(0, Math.min(time, safeDuration || Number.MAX_SAFE_INTEGER));
  const durationChanged =
    safeDuration > 0 &&
    (typeof ctx.state.duration !== 'number' || Math.round(ctx.state.duration) !== safeDuration);
  const withinThrottle =
    now - ctx.lastPositionUpdateAt < 1000 && safeTime === ctx.lastPositionValue && !durationChanged;
  if (withinThrottle) {
    return;
  }
  ctx.lastPositionUpdateAt = now;
  ctx.lastPositionValue = safeTime;
  if (suppressDuration) {
    coordinator.applyPatch(zoneId, { time: safeTime });
  } else {
    coordinator.applyPatch(zoneId, buildPositionPatch({ time: safeTime, duration: safeDuration }));
  }
  if (ctx.outputTimingActive && now - ctx.lastOutputTimingAt < 8000) {
    return;
  }
  if (ctx.outputTimingActive && now - ctx.lastOutputTimingAt >= 8000) {
    ctx.outputTimingActive = false;
  }
}

function onPlayerMetadata(
  coordinator: PlayerListenerCoordinator,
  zoneId: number,
  metadata: PlaybackMetadata,
): void {
  const patch = buildMetadataPatch(metadata);
  applyPatchIfNonEmpty(coordinator.applyPatch, zoneId, patch);
}

function onPlayerCover(
  coordinator: PlayerListenerCoordinator,
  zoneId: number,
  relative: string | null | undefined,
): void {
  const coverurl = relative ? `${coordinator.buildAbsoluteCoverUrl(relative)}?t=${Date.now()}` : '';
  if (coverurl) {
    coordinator.applyPatch(zoneId, { coverurl });
  }
}

function onPlayerVolume(
  coordinator: PlayerListenerCoordinator,
  zoneId: number,
  outputs: ZoneOutput[],
  level: number,
): void {
  const ctx = coordinator.getZone(zoneId);
  if (!ctx) {
    return;
  }
  const clamped = clampVolumeForZone(ctx.config, level);
  coordinator.applyPatch(zoneId, buildVolumePatch(clamped));
  coordinator.dispatchVolume(ctx, outputs, clamped);
}

function onPlayerEnded(coordinator: PlayerListenerCoordinator, zoneId: number): void {
  const ctx = coordinator.getZone(zoneId);
  if (!ctx) {
    return;
  }
  if (ctx.alert) {
    void coordinator.stopAlert(zoneId);
    return;
  }
  void coordinator.handleEndOfTrack(ctx);
}

function onPlayerError(
  coordinator: PlayerListenerCoordinator,
  zoneId: number,
  reason: string | undefined,
  zoneName: string,
  sourceMac: string,
): void {
  coordinator.handlePlaybackError(zoneId, reason, 'player', { zone: zoneName, sourceMac });
}

function applyPatchIfNonEmpty(
  applyPatch: (zoneId: number, patch: Partial<LoxoneZoneState>) => void,
  zoneId: number,
  patch: Partial<LoxoneZoneState>,
): void {
  if (Object.keys(patch).length > 0) {
    applyPatch(zoneId, patch);
  }
}
