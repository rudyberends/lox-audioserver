import type { ComponentLogger } from '@/shared/logging/logger';
import type { AudioManager, PlaybackSession } from '@/application/playback/audioManager';
import type { ZoneOutput } from '@/ports/OutputsTypes';
import {
  dispatchQueueStep,
  dispatchOutputs,
  dispatchVolume,
  selectPlayOutputs,
} from '@/application/zones/services/outputOrchestrator';
import type { LoxoneZoneState } from '@/domain/loxone/types';
import type { ZoneContext } from '@/application/zones/internal/zoneTypes';
import { clearPlayers } from '@/application/playback/playerRegistry';
import { ZoneRepository } from '@/application/zones/ZoneRepository';

export class OutputRouter {
  constructor(
    private readonly log: ComponentLogger,
    private readonly outputErrorNotifier: (zoneId: number, reason?: string) => void,
    private readonly audioManager: AudioManager,
  ) {}

  public dispatchQueueStep(ctx: ZoneContext, outputs: ZoneOutput[], delta: number): boolean {
    return dispatchQueueStep(ctx, outputs, delta, this.log);
  }

  public dispatchOutputs(
    ctx: ZoneContext,
    outputs: ZoneOutput[],
    action: 'play' | 'pause' | 'resume' | 'stop',
    payload: PlaybackSession | null | undefined,
  ): void {
    dispatchOutputs(ctx, outputs, action, payload, this.log, this.outputErrorNotifier);
  }

  public dispatchVolume(ctx: ZoneContext, outputs: ZoneOutput[], volume: number): void {
    dispatchVolume(ctx, outputs, volume, this.log);
  }

  public selectPlayOutputs(outputs: ZoneOutput[], _session: PlaybackSession | null): ZoneOutput[] {
    return selectPlayOutputs(outputs);
  }

  public notifyOutputMetadata(
    zoneId: number,
    ctx: ZoneContext,
    patch: Partial<LoxoneZoneState>,
  ): void {
    // Only trigger when metadata-relevant fields change.
    const touchesMeta =
      'title' in patch ||
      'artist' in patch ||
      'album' in patch ||
      'coverurl' in patch ||
      'duration' in patch ||
      'station' in patch ||
      'sourceName' in patch;
    if (!touchesMeta) {
      return;
    }
    const now = Date.now();
    const patchKeys = Object.keys(patch);
    const isTimeOnly = patchKeys.length === 1 && patchKeys[0] === 'time';
    // Limit pure time ticks to once per second to avoid noisy metadata spam.
    if (isTimeOnly && now - ctx.lastMetadataDispatchAt < 1000) {
      return;
    }
    ctx.lastMetadataDispatchAt = now;
    const session = this.audioManager.getSession(zoneId);
    const outputTargets =
      ctx.activeOutput !== null
        ? ctx.outputs.filter((t) => t.type === ctx.activeOutput)
        : ctx.outputs.filter((t) => t.type !== 'spotify-input');
    const controllerTargets = ctx.outputs.filter((t) => t.type === 'spotify-input');
    const targets = [...outputTargets, ...controllerTargets];

    this.log.spam('dispatch output metadata', {
      zoneId,
      activeOutput: ctx.activeOutput,
      targetCount: targets.length,
    });

    for (const output of targets) {
      if (typeof output.updateMetadata === 'function') {
        try {
          const result = output.updateMetadata(session);
          if (result instanceof Promise) {
            void result.catch((err) =>
              this.log.debug('output metadata update failed', {
                zoneId,
                type: output.type,
                message: (err as Error)?.message ?? String(err),
              }),
            );
          }
        } catch (err) {
          this.log.debug('output metadata update failed', {
            zoneId,
            type: output.type,
            message: (err as Error)?.message ?? String(err),
          });
        }
      }
    }
  }

  public async stopOutputs(
    outputs: ZoneOutput[],
    session: PlaybackSession | null | undefined,
  ): Promise<void> {
    await Promise.all(
      outputs.map(async (output) => {
        try {
          await output.stop(session ?? null);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log.warn('output stop failed', { zoneId: session?.zoneId, message });
        }
      }),
    );
  }

  public disposeAllOutputs(zoneRepo: ZoneRepository): void {
    for (const ctx of zoneRepo.list()) {
      for (const output of ctx.outputs ?? []) {
        try {
          const result = output.dispose();
          if (result instanceof Promise) {
            void result.catch((error) => {
              this.log.warn('output dispose failed', {
                zoneId: ctx.id,
                message: (error as Error).message,
              });
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log.warn('output dispose failed', { zoneId: ctx.id, message });
        }
      }
    }
    clearPlayers();
  }
}
