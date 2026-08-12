import type { ZoneContext } from '@/application/zones/internal/zoneTypes';
import {
  clamp,
  clampVolumeForZone,
  getZoneDefaultVolume,
} from '@/application/zones/helpers/stateHelpers';
import { isQueueDrivenInput } from '@/application/zones/playback/guards';
import { mapZoneCommandToIntent } from '@/application/zones/playback/commandIntents';
import type { VolumeCommandIntent } from '@/application/zones/playback/types';
import type { ComponentLogger } from '@/shared/logging/logger';
import type { ZoneState } from '@/domain/zones/zoneState';
import type { ZoneOutput } from '@/ports/OutputsTypes';
import type { QueueAuthority } from '@/application/zones/internal/zoneTypes';
import type { PlaybackMetadata, PlaybackSession } from '@/application/playback/audioManager';
import type { AirplayRemoteCommand, LineInControlCommand } from '@/ports/InputsPort';
import { parseLineInInputId } from '@/application/zones/internal/zoneAudioHelpers';
import type { ZoneAudioHelpers } from '@/application/zones/internal/zoneAudioHelpers';

type CommandCoordinator = {
  log: ComponentLogger;
  applyPatch: (zoneId: number, patch: Partial<ZoneState>) => void;
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
  requestLineInStop: (inputId: string) => void;
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
    case 'Mute':
      handleMute(coordinator, ctx, zoneId, mode, intent.muted);
      break;
    case 'QueueStep':
      handleQueueStep(coordinator, ctx, zoneId, mode, intent.delta);
      break;
    case 'QueuePlayCurrent':
      handleQueuePlayCurrent(coordinator, ctx, zoneId);
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
  // Keyed off the audiopath, not inputMode: a line-in that was selected but has not started
  // streaming yet (hardware still coming up) never reached inputMode 'linein', and it is exactly
  // then that a transport command has to reach the source rather than the local queue.
  if (routeLineInCommand(coordinator, ctx, 'play')) {
    return;
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
    // Don't synchronously set mode='play' here: onPlayerStarted relies on
    // ctx.state.mode === 'stop' to detect a fresh start and apply the
    // configured default volume. The 'started' event from startQueuePlayback
    // runs buildStartedPatch which sets mode='play' itself.
    return;
  }
  coordinator.dispatchOutputs(ctx, ctx.outputs, 'resume', session ?? ctx.player.getSession());
  coordinator.applyPatch(zoneId, { mode: 'play', clientState: 'on', power: 'on' });
}

function handlePause(
  coordinator: CommandCoordinator,
  ctx: ZoneContext,
  zoneId: number,
  mode: ZoneContext['inputMode'],
): void {
  if (routeLineInCommand(coordinator, ctx, 'pause')) {
    return;
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
  // Live radio has no resumable position, so "pause" tears the stream down instead
  // of freezing it: keeping the stalled engine + the output's retained buffer around
  // only replays stale pause-point audio on resume (#299). Play restarts the station
  // live via the fresh-play fallback in handlePlayResume — a radio start is fast. Only
  // do this when the local queue can actually restart it; otherwise pause normally.
  const pauseCurrent = ctx.queueController.current();
  const pauseAudiopath = pauseCurrent?.audiopath ?? ctx.state.audiopath ?? '';
  const isLiveRadio =
    isQueueDrivenInput(mode) &&
    coordinator.isLocalQueueAuthority(ctx.queue.authority) &&
    Boolean(pauseAudiopath) &&
    (pauseCurrent
      ? coordinator.audioHelpers.isRadioAudiopath(pauseCurrent.audiopath, pauseCurrent.audiotype)
      : coordinator.audioHelpers.isRadioAudiopath(pauseAudiopath, ctx.state.audiotype));
  if (isLiveRadio) {
    // Stop the engine and tear down the output (RTSP), but keep the input + queue so
    // play can restart the station. Report 'pause' to the client so the play/pause
    // toggle keeps working normally.
    const stopped = ctx.player.stop('command_stop');
    coordinator.dispatchOutputs(ctx, ctx.outputs, 'stop', stopped ?? ctx.player.getSession());
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
  // Keyed off the audiopath rather than inputMode: a selected line-in that never produced audio
  // (a source still waiting to be switched on) never reached inputMode 'linein', and it is exactly
  // that case which must be released here -- otherwise the source stays powered after the zone is
  // off, with nothing left to turn it back down.
  releaseLineInOnStop(coordinator, ctx);
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
  if (!isQueueDrivenInput(mode)) {
    return;
  }
  if (mode === 'musicassistant') {
    void coordinator.playerCommand(zoneId, 'seek', { position: posSeconds });
    return;
  }
  const current = ctx.queueController.current();
  const audiopath = current?.audiopath ?? ctx.state.audiopath ?? '';
  if (!audiopath || coordinator.audioHelpers.isRadioAudiopath(audiopath, current?.audiotype ?? ctx.state.audiotype)) {
    return;
  }
  const duration = current?.duration ?? ctx.player.getSession()?.duration ?? ctx.state.duration ?? 0;
  const clamped = Math.max(0, duration > 0 ? Math.min(posSeconds, duration) : posSeconds);
  const metadata: PlaybackMetadata = {
    title: current?.title || ctx.state.title || ctx.name,
    artist: current?.artist || ctx.state.artist || '',
    album: current?.album || ctx.state.album || '',
    coverurl: current?.coverurl || ctx.state.coverurl,
    duration: current?.duration ?? ctx.state.duration,
    audiopath,
    station: current?.station || ctx.state.station,
    stationIndex: ctx.queueController.currentIndex(),
    isRadio: false,
  };
  void coordinator.startQueuePlayback(ctx, audiopath, metadata, {
    skipExternalStop: true,
    startAtSec: clamped,
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    coordinator.log.warn('position seek failed', {
      zoneId,
      audiopath,
      requestedSeconds: posSeconds,
      clampedSeconds: clamped,
      message,
    });
  });
  coordinator.log.debug('position seek requested', {
    zoneId,
    audiopath,
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
  coordinator.log.spam('zone volume command', {
    zoneId,
    command: volume.command,
    payload: volume.rawPayload,
    target,
  });
  applyVolumeLevel(coordinator, ctx, zoneId, mode, target);
}

/**
 * Silence the zone while remembering what to come back to, or hand that level back.
 *
 * Mute is not a separate signal to the outputs — an output that is handed zero is
 * silent, which is the whole of it. What mute adds is the reason and the way back,
 * so a client can draw a crossed-out speaker and pressing it again returns the zone
 * to the level it had rather than to some default.
 */
function handleMute(
  coordinator: CommandCoordinator,
  ctx: ZoneContext,
  zoneId: number,
  mode: ZoneContext['inputMode'],
  requested: boolean | null,
): void {
  const currentlyMuted = ctx.state.muted === true;
  const muted = requested ?? !currentlyMuted;
  if (muted === currentlyMuted) {
    return;
  }
  if (muted) {
    // A zone already at zero has nothing worth remembering, and remembering it would
    // make unmute restore silence. Unmute falls back to the configured default there.
    const level = ctx.state.volume ?? 0;
    ctx.volumeBeforeMute = level > 0 ? level : undefined;
    applyVolumeLevel(coordinator, ctx, zoneId, mode, 0, { muted: true });
    coordinator.log.debug('zone muted', { zoneId, restoreTo: ctx.volumeBeforeMute ?? null });
    return;
  }
  const restore = clampVolumeForZone(
    ctx.config,
    ctx.volumeBeforeMute ?? getZoneDefaultVolume(ctx.config),
  );
  ctx.volumeBeforeMute = undefined;
  applyVolumeLevel(coordinator, ctx, zoneId, mode, restore, { muted: false });
  coordinator.log.debug('zone unmuted', { zoneId, volume: restore });
}

/**
 * Put a level on the zone: the input that owns its volume, the local player, the
 * state and the outputs. Shared by the volume command and by mute, so silencing a
 * zone travels exactly as far as turning it down to zero by hand does.
 */
function applyVolumeLevel(
  coordinator: CommandCoordinator,
  ctx: ZoneContext,
  zoneId: number,
  mode: ZoneContext['inputMode'],
  target: number,
  extraPatch?: Partial<ZoneState>,
): void {
  if (mode === 'airplay') {
    coordinator.remoteVolume(zoneId, target);
  }
  if (mode === 'musicassistant') {
    void coordinator.playerCommand(zoneId, 'volume_set', {
      volume_level: target,
    });
  }
  /*
   * `player.setVolume` is the whole dispatch: it is a synchronous `emit`, so
   * `onPlayerVolume` runs before this line returns and already applies the volume
   * patch and pushes to `ctx.outputs` — the very same array the listener closed
   * over. Dispatching again here sent every volume change to every output twice,
   * which on a sendspin client meant two encrypted round trips and two mixer
   * writes per change.
   *
   * The follow-up patch is only needed when there is something the listener's
   * volume-only patch cannot carry — the mute flag. For a plain volume change it
   * was a second patch of a value already applied, and so a second state
   * notification to every consumer.
   */
  ctx.player.setVolume(target);
  if (extraPatch && Object.keys(extraPatch).length > 0) {
    coordinator.applyPatch(zoneId, { volume: target, ...extraPatch });
  }
}

function handleQueueStep(
  coordinator: CommandCoordinator,
  ctx: ZoneContext,
  zoneId: number,
  mode: ZoneContext['inputMode'],
  delta: 1 | -1,
): void {
  if (routeLineInCommand(coordinator, ctx, delta === 1 ? 'next' : 'previous')) {
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
    coordinator.log.debug('queue step ignored; mode not queue-driven', { zoneId, mode, delta });
    return;
  }
  const dispatched = coordinator.dispatchQueueStep(ctx, ctx.outputs, delta);
  coordinator.log.debug('queue step', {
    zoneId,
    delta,
    mode,
    authority: ctx.queue.authority,
    queueSize: ctx.queue.items.length,
    currentIndex: ctx.queue.items.length > 0 ? ctx.queueController.currentIndex() : -1,
    dispatched,
    outputTypes: ctx.outputs.map((o) => o.type),
  });
  if (!dispatched) {
    if (coordinator.isLocalQueueAuthority(ctx.queue.authority)) {
      coordinator.stepQueue(zoneId, delta);
    } else {
      coordinator.log.debug('queue step skipped; non-local authority and no dispatched output', { zoneId, authority: ctx.queue.authority });
    }
  }
}

function handleQueuePlayCurrent(
  coordinator: CommandCoordinator,
  ctx: ZoneContext,
  zoneId: number,
): void {
  const current = ctx.queueController.current();
  if (!current?.audiopath) {
    coordinator.log.debug('queue play-current ignored; no current item', { zoneId });
    return;
  }
  const isRadio = coordinator.audioHelpers.isRadioAudiopath(current.audiopath, current.audiotype);
  const metadata: PlaybackMetadata = {
    title: current.title,
    artist: current.artist,
    album: current.album,
    coverurl: current.coverurl,
    audiopath: current.audiopath,
    duration: current.duration,
    station: current.station,
    stationIndex: ctx.queueController.currentIndex(),
    isRadio,
  };
  void coordinator.startQueuePlayback(ctx, current.audiopath, metadata).catch((error) => {
    coordinator.log.warn('queue play-current failed', {
      zoneId,
      audiopath: current.audiopath,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

function releaseLineInOnStop(coordinator: CommandCoordinator, ctx: ZoneContext): void {
  const inputId = parseLineInInputId(ctx.state.audiopath);
  if (!inputId) {
    return;
  }
  coordinator.requestLineInStop(inputId);
}

/**
 * Send a transport command to the line-in source when the zone is on one, and report whether it was
 * handled so the caller stops instead of also driving the local queue.
 *
 * The server is the only place that knows which source a zone is on, so this is where the decision
 * belongs. Previously the play branch fell through to the queue as well, which is why pressing play
 * in the app moved the queue while the source itself heard nothing.
 */
function routeLineInCommand(
  coordinator: CommandCoordinator,
  ctx: ZoneContext,
  command: LineInControlCommand,
): boolean {
  const audiopath = ctx.queueController.current()?.audiopath ?? ctx.state.audiopath ?? '';
  if (!parseLineInInputId(audiopath)) {
    return false;
  }
  requestLineInControl(coordinator, ctx, command);
  return true;
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
