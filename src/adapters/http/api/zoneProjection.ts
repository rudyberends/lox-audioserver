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
import { AudioType, RepeatMode } from '@/domain/zones/enums';
import { parseServiceNativeAudiopath } from '@/domain/zones/audiopath';
import type {
  ApiGroup,
  ApiAudioFormat,
  ApiPowerState,
  ApiVolumeLimits,
  ApiOutput,
  ApiOutputCapabilities,
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

/** Repeat is stored as a `RepeatMode`; 2 is unused. */
function toRepeatMode(plrepeat: number | undefined): ApiRepeatMode {
  switch (plrepeat) {
    case RepeatMode.Queue:
      return 'all';
    case RepeatMode.Track:
      return 'one';
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
 * The kind a service-native audiopath states outright — `applemusic:track:…` is a
 * track whatever `audiotype` says. Returns null for anything that does not carry one,
 * leaving `audiotype` as the fallback.
 */
function kindFromAudiopath(audiopath: string): ApiSourceKind | null {
  const parsed = parseServiceNativeAudiopath(audiopath);
  if (!parsed) {
    return null;
  }
  switch (parsed.kind) {
    case 'track':
      return 'track';
    case 'playlist':
      return 'playlist';
    case 'album':
    case 'artist':
      // Neither is a source kind of its own: playing one queues its tracks.
      return 'playlist';
    default:
      return null;
  }
}

/**
 * A zone with nothing loaded still carries empty strings in Loxone's state
 * (the native app has no null), so treat "no title and no artist" as no track.
 */
function toTrack(state: ZoneState): ApiTrack | null {
  // A title equal to the zone's own name is not a title. Playback fills the field with the
  // zone name when a track has no metadata, because the Loxone app must show *something* there
  // — but reporting "Audio Player 1" as a song name is worse than reporting nothing, and it
  // propagated: recents copied it out of the live state and stored it.
  const raw = (state.title ?? '').trim();
  const title = raw && raw === (state.name ?? '').trim() ? '' : (state.title ?? '');
  const artist = state.artist ?? '';
  const album = state.album ?? '';
  if (!title && !artist && !album) {
    return null;
  }
  // A failure message is not a track. It is written into `title` because the Loxone app has
  // nowhere else to show it, but reporting it here made `if (zone.track)` true for a zone
  // playing nothing — so a UI rendered an error as a song title. It travels as `error`.
  if (playbackError(state)) {
    return null;
  }
  const colors = state.artworkColors
    ? {
        primary: state.artworkColors.primary,
        accent: state.artworkColors.accent,
        backgroundDark: state.artworkColors.background_dark,
        backgroundLight: state.artworkColors.background_light,
        onDark: state.artworkColors.on_dark,
        onLight: state.artworkColors.on_light,
      }
    : null;
  return { title, artist, album, coverUrl: state.coverurl ?? '', colors };
}

/**
 * The failure message a zone is carrying, if any.
 *
 * There is no error field in the internal state: a failed play writes a user-facing title and
 * clears everything else, which is what the Loxone app renders. That combination — stopped,
 * a title, no artist or album, and nothing loaded — is the signature, and it cannot be
 * produced by an actual track.
 */
function playbackError(state: ZoneState): string | null {
  const title = (state.title ?? '').trim();
  if (!title || state.mode !== 'stop') {
    return null;
  }
  const loaded = (state.audiopath ?? '').trim() || (state.artist ?? '').trim() || (state.album ?? '').trim();
  return loaded ? null : title;
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
function toSource(
  state: ZoneState,
  serviceLabel?: ServiceLabelLookup,
  inputLabel?: InputLabelLookup,
): ApiSource | null {
  const id = (state.audiopath ?? '').trim();
  if (!id) {
    return null;
  }
  // Prefer the audiopath's own kind: `audiotype` is shaped for the Loxone clients, so a
  // bridged service is reported as Spotify and then downgraded to Playlist whenever the
  // queue is not Spotify-owned — which labels a single Apple Music track a playlist.
  const kind = kindFromAudiopath(id) ?? toSourceKind(state.audiotype);
  if (kind === 'linein') {
    // A line-in identifies itself by the configured input's own id, so what you read here
    // is what `PUT /zones/{id}/input` accepts. The stored audiopath prefixes it and
    // `sourceName` holds the server's MAC — neither is usable by a caller.
    const inputId = id.startsWith(LINEIN_PREFIX) ? id.slice(LINEIN_PREFIX.length) : id;
    return {
      kind,
      name: inputLabel?.(inputId) || '',
      id: inputId,
      // Nothing to seek in a live input.
      seekable: false,
    };
  }
  // `sourceName` carries the name the Loxone clients need, and for a bridged service
  // that is the disguise: an Apple Music track reports "Spotify", because Spotify is
  // the only streaming service those clients know. Name the real service here, from the
  // audiopath, which is service-native by then.
  const name =
    kind === 'radio'
      ? state.station || ''
      : serviceLabel?.(id) || withoutRoutingTag(state.sourceName);
  // A live stream has no length, so there is nowhere to seek to. Same rule the
  // Snapcast metadata bridge already applies.
  const seekable = Number.isFinite(state.duration) && state.duration > 0;
  return { kind, name, id, seekable };
}

/** How a selected line-in is stored in `audiopath`. */
const LINEIN_PREFIX = 'linein:';

/** The configured name of an input, so a line-in reports it rather than the server's MAC. */
export type InputLabelLookup = (inputId: string) => string | null;

/**
 * `sourceName` with the server's internal routing tag removed.
 *
 * For anything with no service to name — a local file — the field holds this audioserver's own
 * MAC, which it uses to route between its parts. The native Loxone app ignores it, so it was
 * never user-visible there; reported here it looked like the source was called `000C290E5497`.
 */
function withoutRoutingTag(sourceName: string | undefined): string {
  const raw = (sourceName ?? '').trim();
  // Twelve hex characters and nothing else is a MAC, not a name anyone chose.
  return /^[0-9a-f]{12}$/i.test(raw) ? '' : raw;
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

/** Which protocol a zone currently plays over; see toOutput. */
export type OutputProtocolLookup = (zoneId: number) => string | null;

/** The configured, user-facing name of the service an audiopath belongs to. */
export type ServiceLabelLookup = (audiopath: string) => string | null;

function toOutput(
  state: ZoneState,
  deviceLookup?: OutputDeviceLookup,
  protocolLookup?: OutputProtocolLookup,
  capabilitiesLookup?: (zoneId: number) => ApiOutputCapabilities | null,
): ApiOutput | null {
  // `state.outputProtocol` is only ever filled in by the Loxone notifier at emit time,
  // never stored, so reading it here reported no output at all — even mid-playback.
  // Resolve it the same way that notifier does instead.
  const protocol = protocolLookup?.(state.id) ?? state.outputProtocol;
  if (!protocol) {
    return null;
  }
  const device = deviceLookup?.(state.id);
  const capabilities = capabilitiesLookup?.(state.id) ?? null;
  const output = device ? { protocol, device } : { protocol };
  return capabilitiesLookup ? { ...output, capabilities } : output;
}

/**
 * Loxone reports position and duration in seconds already, but as floats for
 * position — the API promises whole seconds.
 */
function toWholeSeconds(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value as number)) : 0;
}

export type ZoneProjectionLookups = {
  powerState?: (zoneId: number) => ApiPowerState | null;
  device?: OutputDeviceLookup;
  outputProtocol?: OutputProtocolLookup;
  outputCapabilities?: (zoneId: number) => ApiOutputCapabilities | null;
  serviceLabel?: ServiceLabelLookup;
  /** Names a configured line-in, so `source.name` is its name and not the server's MAC. */
  inputLabel?: InputLabelLookup;
  /**
   * What the zone is streaming. Not derivable from `ZoneState` — the format belongs to the
   * engine session, not the zone — so it is passed in like the device and volume lookups.
   */
  streamFormat?: (zoneId: number) => ApiAudioFormat | null;
  volumeLimits?: ApiVolumeLimits;
};

export function toApiZoneState(state: ZoneState, lookups: ZoneProjectionLookups = {}): ApiZoneState {
  const error = playbackError(state);
  return {
    id: state.id,
    name: state.name ?? '',
    state: toPlaybackState(state.mode),
    powerState: lookups.powerState?.(state.id) ?? {
      power: state.power === 'on' ? 'on' : 'off',
      target: state.power === 'on' ? 'on' : 'off',
      managed: false,
      idleTimeoutMs: null,
    },
    position: toWholeSeconds(state.time),
    duration: toWholeSeconds(state.duration),
    volume: toWholeSeconds(state.volume),
    volumeLimits: lookups.volumeLimits ?? { max: 100, default: 0, step: 1 },
    repeat: toRepeatMode(state.plrepeat),
    shuffle: Boolean(state.plshuffle),
    track: toTrack(state),
    source: toSource(state, lookups.serviceLabel, lookups.inputLabel),
    group: toGroup(state),
    output: toOutput(state, lookups.device, lookups.outputProtocol, lookups.outputCapabilities),
    format: lookups.streamFormat?.(state.id) ?? null,
    // Only present when something went wrong, so `if (zone.error)` is the whole check.
    ...(error ? { error } : {}),
  };
}
