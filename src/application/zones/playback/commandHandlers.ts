import type { ZoneContext } from '@/application/zones/internal/zoneTypes';
import { clamp } from '@/application/zones/helpers/stateHelpers';
import { isQueueDrivenInput } from '@/application/zones/playback/guards';
import { mapZoneCommandToIntent } from '@/application/zones/playback/commandIntents';
import type { VolumeCommandIntent } from '@/application/zones/playback/types';
import type { ComponentLogger } from '@/shared/logging/logger';
import type { LoxoneZoneState } from '@/domain/loxone/types';
import type { ZoneOutput } from '@/ports/OutputsTypes';
import type { QueueAuthority } from '@/application/zones/internal/zoneTypes';
import type { PlaybackMetadata, PlaybackSession } from '@/application/playback/audioManager';
import type { AirplayRemoteCommand, LineInControlCommand } from '@/ports/InputsPort';
import { parseLineInInputId } from '@/application/zones/internal/zoneAudioHelpers';
import type { ZoneAudioHelpers } from '@/application/zones/internal/zoneAudioHelpers';

type CommandCoordinator = {
  log: ComponentLogger;
  applyPatch: (zoneId: number, patch: Partial<LoxoneZoneState>) => void;
  dispatchOutputs: (
    ctx: ZoneContext,
    outputs: ZoneOutput[],
    action: 'play' | 'pause' | 'resume' | 'stop',
    payload: PlaybackSession | null | undefined,
  ) => void;
  dispatchVolume: (ctx: ZoneContext, outputs: ZoneOutput[], volume: number) => void;
  dispatchQueueStep: (ctx: ZoneContext, outputs: ZoneOutput[], delta: 1 | -1) => boolean;
  setInputMode: (ctx: ZoneContext | undefined, mode: ZoneContext['inputMode']) => void;
  setShuffle: (zoneId: number, enabled: boolean) => void;
  stepQueue: (zoneId: number, delta: number) => void;
  isLocalQueueAuthority: (authority: QueueAuthority | undefined | null) => boolean;
  startQueuePlayback: (
    ctx: ZoneContext,
    audiopath: string,
    metadata?: PlaybackMetadata,
    options?: { skipExternalStop?: boolean; startAtSec?: number },
  ) => Promise<PlaybackSession | null>;
  audioHelpers: ZoneAudioHelpers;
  remoteControl: (zoneId: number, command: AirplayRemoteCommand) => void;
  remoteVolume: (zoneId: number, volume: number) => void;
  playerCommand: (zoneId: number, command: string, args?: Record<string, unknown>) => Promise<boolean>;
  requestLineInControl: (inputId: string, command: LineInControlCommand) => void;
  getVolumeOrigin: () => string;
};

export function handleZoneCommand(args: {
  coordinator: CommandCoordinator;
  ctx: ZoneContext;
  zoneId: number;
  command: string;
  payload?: string;
}): void {
  const { coordinator, ctx, zoneId, command, payload } = args;
  const mode = ctx.inputMode ?? null;
  const intent = mapZoneCommandToIntent({
    command,
    payload,
    mode,
    stateVolume: ctx.state.volume ?? 0,
    config: {
      maxVolume: ctx.config.volumes?.maxVolume,
      volstep: ctx.config.volumes?.volstep,
    },
    queueShuffle: ctx.queue.shuffle,
    queueRepeat: ctx.queue.repeat,
  });
  if (!intent) {
    return;
  }
  switch (intent.kind) {
    case 'PlayResume':
      handlePlayResume(coordinator, ctx, zoneId, mode);
      break;
    case 'Pause':
      handlePause(coordinator, ctx, zoneId, mode);
      break;
    case 'StopOff':
      handleStopOff(coordinator, ctx, zoneId, mode);
      break;
    case 'Position':
      handlePosition(coordinator, ctx, zoneId, mode, intent.posSeconds);
      break;
    case 'Volume':
      handleVolume(coordinator, ctx, zoneId, mode, intent.volume);
      break;
    case 'QueueStep':
      handleQueueStep(coordinator, ctx, zoneId, mode, intent.delta);
      break;
    case 'Shuffle':
      handleShuffle(coordinator, ctx, zoneId, intent.enabled);
      break;
    case 'Repeat':
      handleRepeat(coordinator, ctx, zoneId, intent.value);
      break;
    default:
      break;
  }
}

function handlePlayResume(
  coordinator: CommandCoordinator,
  ctx: ZoneContext,
  zoneId: number,
  mode: ZoneContext['inputMode'],
): void {
  if (mode === 'linein') {
    requestLineInControl(coordinator, ctx, 'play');
  }
  if (mode === 'airplay') {
    coordinator.remoteControl(zoneId, 'Play');
    return;
  }
  if (mode === 'musicassistant') {
    void coordinator.playerCommand(zoneId, 'play');
    const session = ctx.player.resume();
    coordinator.dispatchOutputs(ctx, ctx.outputs, 'resume', session ?? ctx.player.getSession());
    coordinator.applyPatch(zoneId, { mode: 'play', clientState: 'on', power: 'on' });
    return;
  }
  const session = ctx.player.resume();
  if (!session && isQueueDrivenInput(mode) && coordinator.isLocalQueueAuthority(ctx.queue.authority)) {
    const current = ctx.queueController.current();
    const fallbackAudiopath = current?.audiopath ?? ctx.state.audiopath ?? '';
    if (fallbackAudiopath) {
      const isRadio = current
        ? coordinator.audioHelpers.isRadioAudiopath(current.audiopath, current.audiotype)
        : coordinator.audioHelpers.isRadioAudiopath(fallbackAudiopath, ctx.state.audiotype);
      const rawStartAt = Number.isFinite(ctx.state.time) ? Math.max(0, ctx.state.time) : 0;
      const duration = current?.duration ?? ctx.state.duration ?? 0;
      const boundedStartAt = duration > 0 ? Math.min(rawStartAt, Math.max(0, duration - 1)) : rawStartAt;
      const resumeStartAt = !isRadio && boundedStartAt > 0 ? boundedStartAt : undefined;
      const metadata: PlaybackMetadata = current
        ? {
            title: current.title,
            artist: current.artist,
            album: current.album,
            coverurl: current.coverurl,
            audiopath: current.audiopath,
            duration: current.duration,
            station: current.station,
            isRadio,
          }
        : {
            title: ctx.state.title,
            artist: ctx.state.artist,
            album: ctx.state.album,
            coverurl: ctx.state.coverurl,
            audiopath: fallbackAudiopath,
            duration: ctx.state.duration,
            station: ctx.state.station,
            isRadio,
          };
      void (async () => {
        const restored = await coordinator.startQueuePlayback(ctx, fallbackAudiopath, metadata, {
          startAtSec: resumeStartAt,
        });
        if (!restored) {
          coordinator.log.debug('resume fallback failed', { zoneId, audiopath: fallbackAudiopath });
        }
      })();
    }
  } else {
    coordinator.dispatchOutputs(ctx, ctx.outputs, 'resume', session ?? ctx.player.getSession());
  }
  coordinator.applyPatch(zoneId, { mode: 'play', clientState: 'on', power: 'on' });
}

function handlePause(
  coordinator: CommandCoordinator,
  ctx: ZoneContext,
  zoneId: number,
  mode: ZoneContext['inputMode'],
): void {
  if (mode === 'linein') {
    requestLineInControl(coordinator, ctx, 'pause');
  }
  if (mode === 'airplay') {
    coordinator.remoteControl(zoneId, 'Pause');
    coordinator.applyPatch(zoneId, { mode: 'pause', clientState: 'on', power: 'on' });
    return;
  }
  if (mode === 'musicassistant') {
    void coordinator.playerCommand(zoneId, 'pause');
    const session = ctx.player.pause();
    coordinator.dispatchOutputs(ctx, ctx.outputs, 'pause', session ?? ctx.player.getSession());
    coordinator.applyPatch(zoneId, { mode: 'pause', clientState: 'on', power: 'on' });
    return;
  }
  const session = ctx.player.pause();
  coordinator.dispatchOutputs(ctx, ctx.outputs, 'pause', session ?? ctx.player.getSession());
  coordinator.applyPatch(zoneId, { mode: 'pause', clientState: 'on', power: 'on' });
}

function handleStopOff(
  coordinator: CommandCoordinator,
  ctx: ZoneContext,
  zoneId: number,
  mode: ZoneContext['inputMode'],
): void {
  if (mode === 'airplay') {
    coordinator.remoteControl(zoneId, 'Stop');
    coordinator.setInputMode(ctx, null);
    return;
  }
  if (mode === 'musicassistant') {
    void coordinator.playerCommand(zoneId, 'stop');
    const session = ctx.player.stop('command_stop');
    coordinator.dispatchOutputs(ctx, ctx.outputs, 'stop', session ?? ctx.player.getSession());
    coordinator.setInputMode(ctx, null);
    return;
  }
  const session = ctx.player.stop('command_stop');
  coordinator.dispatchOutputs(ctx, ctx.outputs, 'stop', session ?? ctx.player.getSession());
  coordinator.setInputMode(ctx, null);
}

function handlePosition(
  coordinator: CommandCoordinator,
  ctx: ZoneContext,
  zoneId: number,
  mode: ZoneContext['inputMode'],
  posSeconds: number,
): void {
  // Do not drive outputs from here; seeking is handled via dedicated HTTP endpoints.
  if (!isQueueDrivenInput(mode)) {
    return;
  }
  if (mode === 'musicassistant') {
    void coordinator.playerCommand(zoneId, 'seek', { position: posSeconds });
    return;
  }
  const session = ctx.player.getSession();
  const duration = session?.duration ?? ctx.state.duration ?? 0;
  const clamped = duration > 0 ? Math.min(posSeconds, duration) : posSeconds;
  ctx.player.updateTiming(Math.round(clamped), duration);
  coordinator.log.debug('position command ignored for outputs (manual seek endpoint only)', {
    zoneId,
    requestedSeconds: posSeconds,
    clampedSeconds: clamped,
  });
}

function handleVolume(
  coordinator: CommandCoordinator,
  ctx: ZoneContext,
  zoneId: number,
  mode: ZoneContext['inputMode'],
  volume: VolumeCommandIntent,
): void {
  const current = ctx.state.volume ?? 0;
  const maxVol =
    typeof ctx.config.volumes?.maxVolume === 'number' && ctx.config.volumes.maxVolume > 0
      ? ctx.config.volumes.maxVolume
      : 100;
  const step =
    typeof ctx.config.volumes?.volstep === 'number' && ctx.config.volumes.volstep > 0
      ? ctx.config.volumes.volstep
      : null;
  let target = clamp(volume.isRelative ? current + volume.parsed : volume.parsed, 0, maxVol);
  if (step) {
    if (volume.isRelative) {
      if (target > current) {
        target = Math.min(maxVol, Math.ceil(target / step) * step);
      } else if (target < current) {
        target = Math.max(0, Math.floor(target / step) * step);
      } else {
        target = current;
      }
    } else {
      target = clamp(Math.round(target / step) * step, 0, maxVol);
    }
  }
  const logContext: Record<string, unknown> = {
    zoneId,
    command: volume.command,
    payload: volume.rawPayload,
    target,
  };
  if (coordinator.log.isEnabled('spam')) {
    logContext.origin = coordinator.getVolumeOrigin();
  }
  coordinator.log.spam('zone volume command', logContext);
  if (mode === 'airplay') {
    coordinator.remoteVolume(zoneId, target);
  }
  if (mode === 'musicassistant') {
    void coordinator.playerCommand(zoneId, 'volume_set', {
      volume_level: target,
    });
  }
  // Apply locally and push to outputs immediately so repeated relative commands
  // use the updated level even if input callbacks lag.
  ctx.player.setVolume(target);
  coordinator.applyPatch(zoneId, { volume: target });
  coordinator.dispatchVolume(ctx, ctx.outputs, target);
}

function handleQueueStep(
  coordinator: CommandCoordinator,
  ctx: ZoneContext,
  zoneId: number,
  mode: ZoneContext['inputMode'],
  delta: 1 | -1,
): void {
  if (mode === 'linein') {
    requestLineInControl(coordinator, ctx, delta === 1 ? 'next' : 'previous');
    return;
  }
  if (mode === 'airplay') {
    coordinator.remoteControl(zoneId, delta === 1 ? 'Next' : 'Previous');
    return;
  }
  if (mode === 'musicassistant') {
    void coordinator.playerCommand(zoneId, delta === 1 ? 'next' : 'previous');
    return;
  }
  if (!isQueueDrivenInput(mode)) {
    return;
  }
  if (!coordinator.dispatchQueueStep(ctx, ctx.outputs, delta)) {
    if (coordinator.isLocalQueueAuthority(ctx.queue.authority)) {
      coordinator.stepQueue(zoneId, delta);
    }
  }
}

function requestLineInControl(
  coordinator: CommandCoordinator,
  ctx: ZoneContext,
  command: LineInControlCommand,
): void {
  const audiopath = ctx.queueController.current()?.audiopath ?? ctx.state.audiopath ?? '';
  const inputId = parseLineInInputId(audiopath);
  if (!inputId) {
    return;
  }
  coordinator.requestLineInControl(inputId, command);
}

function handleShuffle(
  coordinator: CommandCoordinator,
  ctx: ZoneContext,
  zoneId: number,
  enabled: boolean | null,
): void {
  const next = enabled ?? !ctx.queue.shuffle;
  coordinator.setShuffle(zoneId, next);
}

function handleRepeat(
  coordinator: CommandCoordinator,
  ctx: ZoneContext,
  zoneId: number,
  next: number | null,
): void {
  let resolved = next;
  if (resolved === null) {
    const current = ctx.queue.repeat ?? 0;
    if (current === 0) {
      resolved = 1;
    } else if (current === 1) {
      resolved = 3;
    } else {
      resolved = 0;
    }
  }
  coordinator.applyPatch(zoneId, { plrepeat: resolved });
  ctx.queue.repeat = resolved;
}
