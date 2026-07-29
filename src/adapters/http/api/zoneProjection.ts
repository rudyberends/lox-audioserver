/**
 * Projects the server's zone state onto the public API contract.
 *
 * Its counterpart is `src/adapters/loxone/ws/zoneStateProjection.ts`: both take
 * the same internal state and shape it for one consumer. This one exists even
 * though the internal state is no longer Loxone-shaped, because a public contract
 * wants its own vocabulary regardless — readable enums for the numeric ones
 * (`audiotype` -> `source.kind`), whole seconds, `null` instead of empty-string
 * sentinels, and an opaque `source.id` so nobody comes to depend on the internal
 * form of an audiopath.
 */
import type { ZoneState } from '@/domain/zones/zoneState';
import { AudioType } from '@/domain/zones/enums';
import type {
  ApiGroup,
  ApiOutput,
  ApiPlaybackState,
  ApiRepeatMode,
  ApiSource,
  ApiSourceKind,
  ApiTrack,
  ApiZoneState,
} from '@/domain/zones/apiTypes';

/**
 * The internal `mode` is already a closed set; anything unexpected reads as stopped.
 * Exported so the admin API's diagnostics route reports playback the same way,
 * rather than shipping the internal spelling to a second consumer.
 */
export function toPlaybackState(mode: ZoneState['mode']): ApiPlaybackState {
  switch (mode) {
    case 'play':
      return 'playing';
    case 'pause':
      return 'paused';
    default:
      return 'stopped';
  }
}

/**
 * Loxone encodes repeat as a number whose meaning comes from its app:
 * 0 = off, 1 = repeat one, 3 = repeat all (2 is unused in practice).
 */
function toRepeatMode(plrepeat: number | undefined): ApiRepeatMode {
  switch (plrepeat) {
    case 1:
      return 'one';
    case 3:
      return 'all';
    default:
      return 'off';
  }
}

/**
 * `audiotype` is the closest thing the internal state has to a source category,
 * so it drives the mapping. `File`/`Playlist` collapse into the caller-facing
 * distinction between a single track and a queue-of-tracks source.
 */
function toSourceKind(audiotype: number | undefined): ApiSourceKind {
  switch (audiotype) {
    case AudioType.File:
      return 'track';
    case AudioType.Radio:
      return 'radio';
    case AudioType.Playlist:
      return 'playlist';
    case AudioType.LineIn:
      return 'linein';
    case AudioType.AirPlay:
      return 'airplay';
    case AudioType.Spotify:
      return 'spotify';
    case AudioType.Bluetooth:
      return 'bluetooth';
    default:
      return 'unknown';
  }
}

/**
 * A zone with nothing loaded still carries empty strings in Loxone's state
 * (the native app has no null), so treat "no title and no artist" as no track.
 */
function toTrack(state: ZoneState): ApiTrack | null {
  const title = state.title ?? '';
  const artist = state.artist ?? '';
  const album = state.album ?? '';
  if (!title && !artist && !album) {
    return null;
  }
  return { title, artist, album, coverUrl: state.coverurl ?? '' };
}

/**
 * `station` carries the label for radio, `sourceName` for everything else.
 * The raw `audiopath` is passed through as an opaque id — documented as
 * unparseable, precisely so callers cannot come to depend on its shape.
 *
 * A zone with no audiopath has nothing loaded, and reports no source. Two
 * internal details make that check necessary rather than cosmetic: a fresh zone
 * is seeded with `audiotype: 0` (which means File, not "none"), and its
 * `sourceName` holds the audioserver's MAC as an internal routing tag — the
 * native Loxone app ignores both while idle, so neither was ever user-visible
 * before this API existed. Emitting them would surface a MAC address as a
 * human-readable source name.
 */
function toSource(state: ZoneState): ApiSource | null {
  const id = (state.audiopath ?? '').trim();
  if (!id) {
    return null;
  }
  const kind = toSourceKind(state.audiotype);
  const name = (kind === 'radio' ? state.station : state.sourceName) || '';
  return { kind, name, id };
}

/** Loxone leaves `syncedzones` empty (or absent) for an ungrouped zone. */
function toGroup(state: ZoneState): ApiGroup | null {
  const members = state.syncedzones ?? [];
  if (members.length === 0) {
    return null;
  }
  return { leader: members[0]!, members: [...members] };
}

/**
 * The device identity is not in ZoneState — it comes from the zone's output config
 * plus whichever backend tracks connections — so it is passed in rather than derived.
 */
export type OutputDeviceLookup = (zoneId: number) => ApiOutput['device'] | undefined;

function toOutput(state: ZoneState, deviceLookup?: OutputDeviceLookup): ApiOutput | null {
  if (!state.outputProtocol) {
    return null;
  }
  const device = deviceLookup?.(state.id);
  return device ? { protocol: state.outputProtocol, device } : { protocol: state.outputProtocol };
}

/**
 * Loxone reports position and duration in seconds already, but as floats for
 * position — the API promises whole seconds.
 */
function toWholeSeconds(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value as number)) : 0;
}

export function toApiZoneState(state: ZoneState, deviceLookup?: OutputDeviceLookup): ApiZoneState {
  return {
    id: state.id,
    name: state.name ?? '',
    state: toPlaybackState(state.mode),
    power: state.power === 'on' ? 'on' : 'off',
    position: toWholeSeconds(state.time),
    duration: toWholeSeconds(state.duration),
    volume: toWholeSeconds(state.volume),
    repeat: toRepeatMode(state.plrepeat),
    shuffle: Boolean(state.plshuffle),
    track: toTrack(state),
    source: toSource(state),
    group: toGroup(state),
    output: toOutput(state, deviceLookup),
  };
}
