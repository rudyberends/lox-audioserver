import type { ZoneState } from '@/domain/zones/zoneState';
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
  patch: Partial<ZoneState>;
  /** Derived values the caller should persist on the controller. */
  derived: {
    mode: ZoneState['mode'];
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
  const patch: Partial<ZoneState> = {};
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
    // Only apply non-empty fields: MA can emit transient frames with partial
    // metadata (e.g. cover/audiopath populated but title/artist/album blank).
    // Overwriting would clobber the previous good state in the Loxone audio_event.
    if (meta.title) patch.title = meta.title;
    if (meta.artist) patch.artist = meta.artist;
    if (meta.album) patch.album = meta.album;
    if (meta.cover) patch.coverurl = meta.cover;
  }

  // In sink + MA-output mode the bridge is the user-visible source. MA's own
  // `active_source` / `source` / `name` fields resolve to the underlying player
  // id (e.g. a Spotify Connect device name like "up501e2d2c8584"), which leaks
  // into the Loxone UI as the source label. Always report "Music Assistant"
  // here so the bridge is shown, consistent with other service bridges.
  patch.sourceName = 'Music Assistant';

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
