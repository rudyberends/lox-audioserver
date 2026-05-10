import type { LoxoneZoneState } from '@/domain/loxone/types';
import {
  clampVolume,
  extractMediaMeta,
  mapPlaybackState,
  mapRepeatMode,
  pickBoolean,
  pickNumber,
  pickRecord,
  pickString,
} from './maHelpers';

export type SnapshotInputs = {
  player: Record<string, unknown> | null;
  queue: Record<string, unknown> | null;
  lastTime: number;
};

export type SnapshotResult = {
  patch: Partial<LoxoneZoneState>;
  /** Derived values the caller should persist on the controller. */
  derived: {
    mode: LoxoneZoneState['mode'];
    volume: number | null;
    duration: number | null;
    /** When mode != play, the ticker's anchor must be cleared. */
    freezeTicker: boolean;
  };
};

/**
 * Project the latest MA player + queue payloads into a Loxone state patch.
 *
 * Pure projection — no side effects. The controller is responsible for
 * persisting `derived` values (lastVolume, lastDuration, lastMode) and for
 * clearing its ticker anchor when `freezeTicker` is set.
 *
 * Intentionally omitted from the patch: `time`, `audiotype`, `qindex`, `qid`.
 * These are owned by other paths (queue-time event + ticker; queue mirror).
 */
export function buildSnapshotPatch(inputs: SnapshotInputs): SnapshotResult | null {
  const { player, queue, lastTime } = inputs;
  const patch: Partial<LoxoneZoneState> = {};
  const current =
    (player ? pickRecord(player.current_media) ?? pickRecord(player.media) ?? pickRecord(player.item) : null) ??
    (queue ? pickRecord(queue.current_item) ?? pickRecord(queue.current_media) : null);

  const stateField = player
    ? pickString(player.state) ?? pickString(player.playback_state)
    : null;
  const mode = mapPlaybackState(stateField);
  patch.mode = mode;
  patch.power = mode === 'stop' ? 'off' : 'on';
  patch.clientState = player && pickBoolean(player.available, true) === false ? 'off' : 'on';

  let derivedVolume: number | null = null;
  if (player) {
    const volume = pickNumber(player.volume_level);
    if (volume !== null) {
      const clamped = clampVolume(volume);
      patch.volume = clamped;
      derivedVolume = clamped;
    }
  }

  if (current) {
    const meta = extractMediaMeta(current);
    patch.title = meta.title;
    patch.artist = meta.artist;
    patch.album = meta.album;
    if (meta.cover) patch.coverurl = meta.cover;
  }

  const sourceName = player
    ? pickString(player.active_source) ?? pickString(player.source) ?? pickString(player.name)
    : null;
  if (sourceName) {
    patch.sourceName = sourceName;
  }

  let derivedDuration: number | null = null;
  const durationRaw =
    (current ? pickNumber(current.duration) : null) ??
    (player ? pickNumber(player.duration) : null) ??
    (queue ? pickNumber(queue.duration) : null);
  if (durationRaw !== null && durationRaw > 0) {
    const dur = Math.max(0, Math.round(durationRaw));
    patch.duration = dur;
    derivedDuration = dur;
  }
  const freezeTicker = mode !== 'play';
  if (freezeTicker) {
    patch.time = lastTime;
  }

  if (queue) {
    const shuffle = pickBoolean(queue.shuffle_enabled, false);
    patch.plshuffle = shuffle ? 1 : 0;
    patch.plrepeat = mapRepeatMode(pickString(queue.repeat_mode));
  }

  return {
    patch,
    derived: {
      mode,
      volume: derivedVolume,
      duration: derivedDuration,
      freezeTicker,
    },
  };
}
