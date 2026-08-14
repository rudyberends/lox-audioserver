import type { PlaybackSession } from '@/application/playback/audioManager';
import type { ZoneOutput } from '@/ports/OutputsTypes';
import type { ZoneContext } from '@/application/zones/zoneManager';
import type { ComponentLogger } from '@/shared/logging/logger';

type OutputAction = 'play' | 'pause' | 'resume' | 'stop';

export function selectPlayOutputs(
  outputs: ZoneOutput[],
): ZoneOutput[] {
  const ready = (output: ZoneOutput): boolean => {
    const maybe = (output as { isReady?: () => boolean }).isReady;
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
  if (candidates.length) return [candidates[0]!];
  return [];
}

export function dispatchVolume(
  ctx: ZoneContext,
  outputs: ZoneOutput[],
  volume: number,
  log: ComponentLogger,
): void {
  outputs.forEach((output) => {
    if (typeof output.setVolume !== 'function') {
      return;
    }
    if (ctx.activeOutput != null && output.type !== ctx.activeOutput) {
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
  log: ComponentLogger,
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
  const hasPlaybackSource =
    action === 'play' && payload && typeof payload === 'object'
      ? Boolean((payload as PlaybackSession).playbackSource)
      : true;
  const isReady = (output: ZoneOutput): boolean => {
    const maybe = (output as { isReady?: () => boolean }).isReady;
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
      ? outputs.filter((t) => t.type === ctx.activeOutput)
      : [];
  const preferredReady = preferredOutputs.filter(isReady);
  const preferredTargets =
    preferredReady.length > 0
      ? preferredReady
      : preferredOutputs.length > 0 && !outputs.some(isReady)
        ? preferredOutputs
        : [];
  const targetOutputs =
    action === 'play' && payload && typeof payload === 'object'
      ? hasPlaybackSource
        ? preferredTargets.length
          ? [preferredTargets[0]!]
          : selectPlayOutputs(outputs)
        : []
      : ctx.activeOutput
        ? outputs.filter((t) => t.type === ctx.activeOutput)
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

  const targets = targetOutputs;
  // Only a failed `play` means the listener is left with silence, so only that one is escalated
  // to a playback error (which tears the session down and shows "Playback unavailable"). A
  // pause/resume/stop that did not reach the speaker leaves a valid session behind, and killing
  // it made the zone unresumable: play then routed to a state controller with nothing to
  // resume, so the command vanished (issue #327).
  const isFatal = action === 'play';
  const reportFailure = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    const zoneIdPayload =
      payload && typeof payload === 'object' ? (payload as { zoneId?: number }).zoneId : undefined;
    log.warn('output action failed', { zoneId: zoneIdPayload, action, message, fatal: isFatal });
    if (isFatal && typeof zoneIdPayload === 'number') {
      notifyOutputError(zoneIdPayload, message);
    }
  };
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
        void result.catch(reportFailure);
      }
    } catch (error) {
      reportFailure(error);
    }
  });
}
