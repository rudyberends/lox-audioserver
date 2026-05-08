import type { ComponentLogger } from '@/shared/logging/logger';
import type { AudioManager, PlaybackMetadata, PlaybackSession } from '@/application/playback/audioManager';
import type { LoxoneZoneState } from '@/domain/loxone/types';
import type { QueueAuthority, ZoneContext } from '@/application/zones/internal/zoneTypes';
import type { ZoneOutput } from '@/ports/OutputsTypes';
import type { ZoneRepository } from '@/application/zones/ZoneRepository';
import type { ZoneAudioHelpers } from '@/application/zones/internal/zoneAudioHelpers';
import type { RecentsManager } from '@/application/zones/recents/recentsManager';
import { stepQueueAsync as stepQueueAsyncTransition } from '@/application/zones/playback/queueTransitions';

export type QueueStepDispatcherDeps = {
  zoneRepo: ZoneRepository;
  audioManager: AudioManager;
  audioHelpers: ZoneAudioHelpers;
  recentsManager: RecentsManager;
  log: ComponentLogger;
  applyPatch: (zoneId: number, patch: Partial<LoxoneZoneState>, force?: boolean) => void;
  dispatchOutputs: (
    ctx: ZoneContext,
    outputs: ZoneOutput[],
    action: 'play' | 'pause' | 'resume' | 'stop',
    payload: PlaybackSession | null | undefined,
  ) => void;
  isLocalQueueAuthority: (authority: QueueAuthority | undefined | null) => boolean;
  startQueuePlayback: (
    ctx: ZoneContext,
    audiopath: string,
    metadata?: PlaybackMetadata,
    options?: { skipExternalStop?: boolean; startAtSec?: number },
  ) => Promise<PlaybackSession | null>;
  prefetchPlaybackSource: (ctx: ZoneContext, audiopath: string) => void;
  advanceTrack: (ctx: ZoneContext) => Promise<void>;
};

export class QueueStepDispatcher {
  private readonly queueStepState = new Map<
    number,
    { pending: number; running: boolean; timer?: NodeJS.Timeout }
  >();
  private readonly endOfTrackAdvanceState = new Map<
    number,
    { key: string; at: number; cooldownUntil: number; inFlight: boolean }
  >();
  public queueStepCoalesceMs = 25;

  constructor(private readonly deps: QueueStepDispatcherDeps) {}

  public stepQueue(zoneId: number, delta: number): void {
    void this.enqueueQueueStep(zoneId, delta);
  }

  public async handleEndOfTrack(ctx: ZoneContext): Promise<void> {
    const currentAudiopath = ctx.queueController.current()?.audiopath ?? ctx.state.audiopath ?? '';
    const currentKey = `${ctx.queueController.currentIndex()}::${currentAudiopath}`;
    const previous = this.endOfTrackAdvanceState.get(ctx.id);
    const now = Date.now();
    if (previous?.inFlight) {
      this.deps.log.debug('ignoring end_of_track while queue advance is in flight', {
        zoneId: ctx.id,
        key: previous.key,
      });
      return;
    }
    if (previous && now < previous.cooldownUntil) {
      this.deps.log.debug('ignoring end_of_track during queue advance cooldown', {
        zoneId: ctx.id,
        key: currentKey,
        previousKey: previous.key,
      });
      return;
    }
    if (previous && previous.key === currentKey && now - previous.at < 1500) {
      this.deps.log.debug('ignoring duplicate end_of_track queue advance', {
        zoneId: ctx.id,
        key: currentKey,
      });
      return;
    }
    this.endOfTrackAdvanceState.set(ctx.id, {
      key: currentKey,
      at: now,
      cooldownUntil: now + 1500,
      inFlight: true,
    });
    try {
      await this.deps.advanceTrack(ctx);
    } finally {
      const latest = this.endOfTrackAdvanceState.get(ctx.id);
      if (latest) {
        this.endOfTrackAdvanceState.set(ctx.id, {
          ...latest,
          inFlight: false,
        });
      }
    }
  }

  private async enqueueQueueStep(zoneId: number, delta: number): Promise<void> {
    const state = this.queueStepState.get(zoneId) ?? { pending: 0, running: false };
    state.pending += delta;
    this.queueStepState.set(zoneId, state);
    if (state.running) {
      return;
    }
    if (!state.timer && Math.abs(state.pending) === 1) {
      void this.runQueuedSteps(zoneId);
      return;
    }
    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.timer = setTimeout(() => {
      void this.runQueuedSteps(zoneId);
    }, this.queueStepCoalesceMs);
  }

  private async runQueuedSteps(zoneId: number): Promise<void> {
    const state = this.queueStepState.get(zoneId);
    if (!state || state.running) {
      return;
    }
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    state.running = true;
    try {
      while (state.pending !== 0) {
        const step = state.pending > 0 ? 1 : -1;
        state.pending -= step;
        await stepQueueAsyncTransition({
          coordinator: {
            getZone: (id) => this.deps.zoneRepo.get(id),
            isLocalQueueAuthority: this.deps.isLocalQueueAuthority,
            startQueuePlayback: this.deps.startQueuePlayback,
            prefetchPlaybackSource: this.deps.prefetchPlaybackSource,
            applyPatch: this.deps.applyPatch,
            dispatchOutputs: this.deps.dispatchOutputs,
            recentsRecord: this.deps.recentsManager.record.bind(this.deps.recentsManager),
            audioHelpers: this.deps.audioHelpers,
          },
          zoneId,
          delta: step as 1 | -1,
        });
        const ready = await this.deps.audioManager.waitForFirstChunk(zoneId, 'pcm', 1500);
        if (!ready) {
          break;
        }
      }
    } finally {
      state.running = false;
      if (state.pending === 0) {
        this.queueStepState.delete(zoneId);
      } else {
        this.queueStepState.set(zoneId, state);
        if (!state.timer) {
          state.timer = setTimeout(() => {
            void this.runQueuedSteps(zoneId);
          }, this.queueStepCoalesceMs);
        }
      }
    }
  }
}
