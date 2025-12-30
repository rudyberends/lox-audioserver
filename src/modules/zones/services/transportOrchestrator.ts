import type { PlaybackSession } from '@/modules/audio';
import type { ZoneTransport } from '@/modules/audio/outputs/types';
import { notifyTransportError } from '@/modules/audio/outputs/queueUpdater';
import type { ZoneContext } from '@/modules/zones/zoneManager';

type TransportAction = 'play' | 'pause' | 'resume' | 'stop';

export function selectPlayOutputs(
  transports: ZoneTransport[],
): ZoneTransport[] {
  const ready = (t: ZoneTransport): boolean => {
    const maybe = (t as any).isReady;
    if (typeof maybe === 'function') {
      try {
        return maybe.call(t) === true;
      } catch {
        return false;
      }
    }
    return true;
  };
  const readyCandidates = transports.filter(ready);
  const candidates = readyCandidates.length ? readyCandidates : transports;
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
  transports: ZoneTransport[],
  delta: number,
  log: any,
): boolean {
  let handled = false;
  transports.forEach((transport) => {
    if (transport.type === 'spotify-input' && ctx.activeInput && ctx.activeInput !== 'spotify') {
      return;
    }
    if (typeof transport.stepQueue !== 'function') {
      return;
    }
    handled = true;
    try {
      const result = transport.stepQueue(delta);
      if (result instanceof Promise) {
        void result.catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          log.warn('transport queue step failed', {
            zoneId: (transport as any).zoneId,
            message,
          });
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('transport queue step failed', {
        zoneId: (transport as any).zoneId,
        message,
      });
    }
  });
  return handled;
}

export function dispatchVolume(
  ctx: ZoneContext,
  transports: ZoneTransport[],
  volume: number,
  log: any,
): void {
  const isActiveInput = (transport: ZoneTransport): boolean => {
    if (!ctx.activeInput) return false;
    const type = (transport as any).type as string | undefined;
    if (!type) return false;
    if (type.endsWith('-input')) {
      const inputName = type.slice(0, -'-input'.length);
      return ctx.activeInput === inputName;
    }
    return false;
  };

  transports.forEach((transport) => {
    if (typeof transport.setVolume !== 'function') {
      return;
    }
    const isOutput =
      ctx.activeOutput == null ? transport.type !== 'spotify-input' : transport.type === ctx.activeOutput;
    if (!isOutput && !isActiveInput(transport)) {
      return;
    }
    try {
      const result = transport.setVolume(volume);
      if (result instanceof Promise) {
        void result.catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          log.warn('transport volume update failed', {
            zoneId: ctx.id,
            message,
          });
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('transport volume update failed', {
        zoneId: ctx.id,
        message,
      });
    }
  });
}

export function dispatchTransports(
  ctx: ZoneContext,
  transports: ZoneTransport[],
  action: TransportAction,
  payload: PlaybackSession | null | undefined,
  log: any,
): void {
  log.debug('dispatchTransports', {
    zoneId: ctx.id,
    action,
    transportCount: transports.length,
    transportTypes: transports.map((t) => t.type),
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
    ? transports.filter((t) => t.type === 'spotify-input')
    : [];
  const hasPlaybackSource =
    action === 'play' && payload && typeof payload === 'object'
      ? Boolean((payload as PlaybackSession).playbackSource)
      : true;
  const outputCandidates = transports.filter((t) => t.type !== 'spotify-input');
  const isReady = (transport: ZoneTransport): boolean => {
    const maybe = (transport as any).isReady;
    if (typeof maybe === 'function') {
      try {
        return maybe.call(transport) === true;
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
      transports
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
    ctx.activeTransportTypes = new Set(ctx.activeOutput ? [ctx.activeOutput] : []);
  }

  const targets = [...controllers, ...targetOutputs];
  targets.forEach((transport) => {
    try {
      let result: void | Promise<void> | undefined;
      switch (action) {
        case 'play':
          if (payload && typeof payload === 'object') {
            result = transport.play(payload as PlaybackSession);
          }
          break;
        case 'pause':
          result = transport.pause((payload as PlaybackSession) ?? null);
          break;
        case 'resume':
          result = transport.resume((payload as PlaybackSession) ?? null);
          break;
        case 'stop':
          result = transport.stop((payload as PlaybackSession) ?? null);
          break;
        default:
          break;
      }
      if (result instanceof Promise) {
        void result.catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          const zoneIdPayload =
            payload && typeof payload === 'object' ? (payload as any).zoneId : undefined;
          log.warn('transport action failed', {
            zoneId: zoneIdPayload,
            action,
            message,
          });
          if (typeof zoneIdPayload === 'number') {
            notifyTransportError(zoneIdPayload, message);
          }
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const zoneIdPayload =
        payload && typeof payload === 'object' ? (payload as any).zoneId : undefined;
      log.warn('transport action failed', {
        zoneId: zoneIdPayload,
        action,
        message,
      });
      if (typeof zoneIdPayload === 'number') {
        notifyTransportError(zoneIdPayload, message);
      }
    }
  });
}
