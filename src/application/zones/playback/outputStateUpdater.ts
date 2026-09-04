import type { ZoneContext } from '@/application/zones/internal/zoneTypes';
import type { ZoneAudioHelpers } from '@/application/zones/internal/zoneAudioHelpers';
import { normalizeSpotifyAudiopath } from '@/application/zones/helpers/queueHelpers';
import type { ZoneState } from '@/domain/zones/zoneState';
import { buildMatchedOutputUriPatch } from '@/application/zones/playback/patchBuilder';
import { findQueueIndexByUri } from '@/application/zones/playback/queueOps';

type OutputStateCoordinator = {
  getZone: (zoneId: number) => ZoneContext | undefined;
  audioHelpers: ZoneAudioHelpers;
  applyPatch: (zoneId: number, patch: Partial<ZoneState>) => void;
};

export function updateOutputState(args: {
  coordinator: OutputStateCoordinator;
  zoneId: number;
  state: {
    status?: 'playing' | 'paused' | 'stopped';
    position?: number;
    duration?: number;
    uri?: string;
  };
}): void {
  const { coordinator, zoneId, state } = args;
  const ctx = coordinator.getZone(zoneId);
  if (!ctx) {
    return;
  }
  if (ctx.alert) {
    // Ignore output updates while an alert is active to avoid clobbering alert metadata.
    return;
  }
  const patch: Partial<ZoneState> = {};
  if (state.status === 'paused' || state.status === 'stopped') {
    ctx.outputTimingActive = false;
    ctx.lastOutputTimingAt = 0;
  }
  if (
    state.status === 'stopped' &&
    typeof state.position === 'number' &&
    typeof state.duration === 'number' &&
    state.duration > 0 &&
    ctx.metadata.radioControllable !== true &&
    ctx.player.getState().mode === 'playing'
  ) {
    const position = Math.round(state.position);
    const duration = Math.round(state.duration);
    if (position >= Math.max(0, duration - 1)) {
      // Force end-of-track even with output latency guard.
      ctx.player.setEndGuardMs(0);
      ctx.player.updateTiming(duration, duration);
    }
  }
  // Which queue entry an output is on is only ever told by an output that is on one. A `stopped`
  // report names the track that has just finished, and the session it comes from is torn down
  // *after* the queue has moved to the next one — so reading it as "this is where the queue is"
  // wound the index back onto the track the room had already left. Everything then disagreed with
  // what was sounding: `next` played the track that was already on (twice in a row, to a listener),
  // and the queue highlighted the wrong line. The end-of-track force above still reads it.
  const matchedIndex = state.uri && state.status !== 'stopped' && ctx.queue.items.length
    ? findQueueIndexByUri(ctx.queue.items, state.uri)
    : -1;
  const session = ctx.player.getSession();
  const normalizedCurrentUri = normalizeSpotifyAudiopath(ctx.queueController.current()?.audiopath ?? '');
  const normalizedIncomingUri = normalizeSpotifyAudiopath(state.uri ?? '');
  const ignoreStartupUriReconcile =
    ctx.queue.authority === 'local' &&
    state.status === 'playing' &&
    session?.state === 'playing' &&
    !session.firstAudioReadyAt &&
    normalizedCurrentUri.length > 0 &&
    normalizedIncomingUri.length > 0 &&
    normalizedCurrentUri !== normalizedIncomingUri;
  if (!ignoreStartupUriReconcile && matchedIndex >= 0 && matchedIndex !== ctx.queue.currentIndex) {
    ctx.queueController.setCurrentIndex(matchedIndex);
    const current = ctx.queueController.current();
    if (current) {
      Object.assign(patch, buildMatchedOutputUriPatch(ctx, current, matchedIndex, coordinator.audioHelpers));
    }
  }
  // Skip output-reported duration when the output reports 'stopped': the value still
  // reflects the last-played track and would overwrite the 0 that buildStoppedPatch
  // wrote to the zone state.
  if (
    state.status !== 'stopped' &&
    ctx.metadata.radioControllable !== true &&
    typeof state.duration === 'number' &&
    state.duration > 0
  ) {
    patch.duration = Math.round(state.duration);
  }
  // Ignore output-provided position ticks; the player already drives timing,
  // and accepting external time updates can create feedback loops and noisy broadcasts.
  if (state.status === 'paused') {
    patch.mode = 'pause';
    patch.clientState = 'on';
    patch.power = 'on';
  } else if (state.status === 'playing') {
    patch.mode = 'play';
    patch.clientState = 'on';
    patch.power = 'on';
  }
  if (Object.keys(patch).length > 0) {
    coordinator.applyPatch(zoneId, patch);
  }
}
