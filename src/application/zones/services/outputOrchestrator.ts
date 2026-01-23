import type { PlaybackSession } from '@/application/playback/audioManager';
import type { ZoneOutput } from '@/ports/OutputsTypes';
import type { ZoneContext } from '@/application/zones/zoneManager';

type OutputAction = 'play' | 'pause' | 'resume' | 'stop';

export function selectPlayOutputs(
  outputs: ZoneOutput[],
): ZoneOutput[] {
  const ready = (output: ZoneOutput): boolean => {
    const maybe = (output as any).isReady;
    if (typeof maybe === 'function') {
      try {
        return maybe.call(output) === true;
      } catch {
        return false;
      }
    }
    return true;
  };
  const readyCandidates = outputs.filter(ready);
  const candidates = readyCandidates.length ? readyCandidates : outputs;
  const sendspin = candidates.find((t) => t.type === 'sendspin');
  if (sendspin) return [sendspin];
  const airplayOut = candidates.find((t) => t.type === 'airplay');
  if (airplayOut) return [airplayOut];
  const dlna = candidates.find((t) => t.type === 'dlna');
  if (dlna) return [dlna];
  if (candidates.length) return [candidates[0]];
  return [];
}

export function dispatchQueueStep(
  ctx: ZoneContext,
  outputs: ZoneOutput[],
  delta: number,
  log: any,
): boolean {
  let handled = false;
  outputs.forEach((output) => {
    if (output.type === 'spotify-input' && ctx.activeInput && ctx.activeInput !== 'spotify') {
      return;
    }
    if (typeof output.stepQueue !== 'function') {
      return;
    }
    handled = true;
    try {
      const result = output.stepQueue(delta);
      if (result instanceof Promise) {
        void result.catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          log.warn('output queue step failed', {
            zoneId: (output as any).zoneId,
            message,
          });
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('output queue step failed', {
        zoneId: (output as any).zoneId,
        message,
      });
    }
  });
  return handled;
}

export function dispatchVolume(
  ctx: ZoneContext,
  outputs: ZoneOutput[],
  volume: number,
  log: any,
): void {
  const isActiveInput = (output: ZoneOutput): boolean => {
    if (!ctx.activeInput) return false;
    const type = (output as any).type as string | undefined;
    if (!type) return false;
    if (type.endsWith('-input')) {
      const inputName = type.slice(0, -'-input'.length);
      return ctx.activeInput === inputName;
    }
    return false;
  };

  outputs.forEach((output) => {
    if (typeof output.setVolume !== 'function') {
      return;
    }
    const isOutput =
      ctx.activeOutput == null ? output.type !== 'spotify-input' : output.type === ctx.activeOutput;
    if (!isOutput && !isActiveInput(output)) {
      return;
    }
    try {
      const result = output.setVolume(volume);
      if (result instanceof Promise) {
        void result.catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          log.warn('output volume update failed', {
            zoneId: ctx.id,
            message,
          });
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('output volume update failed', {
        zoneId: ctx.id,
        message,
      });
    }
  });
}

export function dispatchOutputs(
  ctx: ZoneContext,
  outputs: ZoneOutput[],
  action: OutputAction,
  payload: PlaybackSession | null | undefined,
  log: any,
  notifyOutputError: (zoneId: number, reason?: string) => void,
): void {
  log.debug('dispatchOutputs', {
    zoneId: ctx.id,
    action,
    outputCount: outputs.length,
    outputTypes: outputs.map((t) => t.type),
  });
  if (action === 'play' && (!payload || typeof payload !== 'object')) {
    return;
  }
  const spotifyConnectEnabled = ctx.config.inputs?.spotify?.offload === true;
  const payloadSource =
    action === 'play' && payload && typeof payload === 'object'
      ? (payload as PlaybackSession).source
      : null;
  const allowSpotifyController =
    spotifyConnectEnabled &&
    (ctx.activeInput === 'spotify' || payloadSource === 'spotify');
  const controllers = allowSpotifyController
    ? outputs.filter((t) => t.type === 'spotify-input')
    : [];
  const hasPlaybackSource =
    action === 'play' && payload && typeof payload === 'object'
      ? Boolean((payload as PlaybackSession).playbackSource)
      : true;
  const outputCandidates = outputs.filter((t) => t.type !== 'spotify-input');
  const isReady = (output: ZoneOutput): boolean => {
    const maybe = (output as any).isReady;
    if (typeof maybe === 'function') {
      try {
        return maybe.call(output) === true;
      } catch {
        return false;
      }
    }
    return true;
  };
  const preferredOutputs =
    ctx.activeOutput != null
      ? outputCandidates.filter((t) => t.type === ctx.activeOutput)
      : [];
  const preferredReady = preferredOutputs.filter(isReady);
  const preferredTargets =
    preferredReady.length > 0
      ? preferredReady
      : preferredOutputs.length > 0 && !outputCandidates.some(isReady)
        ? preferredOutputs
        : [];
  const targetOutputs =
    action === 'play' && payload && typeof payload === 'object'
      ? hasPlaybackSource
        ? preferredTargets.length
          ? [preferredTargets[0]]
          : selectPlayOutputs(outputCandidates)
        : []
      : ctx.activeOutput
        ? outputCandidates.filter((t) => t.type === ctx.activeOutput)
        : [];

  if (action === 'play' && targetOutputs.length) {
    const nextOutputType = targetOutputs[0]?.type ?? null;
    const previousOutputType = ctx.activeOutput;
    if (nextOutputType && previousOutputType && previousOutputType !== nextOutputType) {
      outputs
        .filter((t) => t.type === previousOutputType)
        .forEach((t) => {
          try {
            void t.stop((payload as PlaybackSession) ?? null);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.debug('failed to stop previous output', {
              zoneId: ctx.id,
              type: previousOutputType,
              message,
            });
          }
        });
    }
    ctx.activeOutput = targetOutputs[0]?.type ?? null;
    ctx.activeOutputTypes = new Set(ctx.activeOutput ? [ctx.activeOutput] : []);
  }

  const targets = [...controllers, ...targetOutputs];
  targets.forEach((output) => {
    try {
      let result: void | Promise<void> | undefined;
      switch (action) {
        case 'play':
          if (payload && typeof payload === 'object') {
            result = output.play(payload as PlaybackSession);
          }
          break;
        case 'pause':
          result = output.pause((payload as PlaybackSession) ?? null);
          break;
        case 'resume':
          result = output.resume((payload as PlaybackSession) ?? null);
          break;
        case 'stop':
          result = output.stop((payload as PlaybackSession) ?? null);
          break;
        default:
          break;
      }
      if (result instanceof Promise) {
        void result.catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          const zoneIdPayload =
            payload && typeof payload === 'object' ? (payload as any).zoneId : undefined;
          log.warn('output action failed', {
            zoneId: zoneIdPayload,
            action,
            message,
          });
          if (typeof zoneIdPayload === 'number') {
            notifyOutputError(zoneIdPayload, message);
          }
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const zoneIdPayload =
        payload && typeof payload === 'object' ? (payload as any).zoneId : undefined;
      log.warn('output action failed', {
        zoneId: zoneIdPayload,
        action,
        message,
      });
      if (typeof zoneIdPayload === 'number') {
        notifyOutputError(zoneIdPayload, message);
      }
    }
  });
}
