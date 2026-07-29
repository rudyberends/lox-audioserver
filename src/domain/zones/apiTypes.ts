/**
 * -----------------------------------------------------------------------------
 * The server's own zone contract.
 * -----------------------------------------------------------------------------
 * This is the shape the public API speaks. It is a projection of `ZoneState`, as
 * is the Loxone payload — two consumers, two contracts, one source.
 *
 * Everything here has to be usable by someone who has never seen a Loxone
 * installation: readable strings where the internal state uses Loxone's numeric
 * enums, whole seconds, `null` instead of empty-string sentinels, an opaque
 * `source.id`, and no browse or queue internals.
 *
 * Additive only. New fields and new `source.kind` values are not breaking
 * changes; renaming or removing one is.
 * -----------------------------------------------------------------------------
 */

/** Playback state. Replaces Loxone's `mode`. */
export type ApiPlaybackState = 'playing' | 'paused' | 'stopped';

/** Repeat strategy. Replaces Loxone's numeric `plrepeat`. */
export type ApiRepeatMode = 'off' | 'one' | 'all';

/**
 * Where the audio comes from. Mirrors the categories Loxone's numeric
 * `AudioType` already distinguishes, but as names — so the wire format does not
 * require a lookup table to interpret. `unknown` is the deliberate escape hatch:
 * a new source kind must never make a client fail to parse a zone.
 */
export type ApiSourceKind =
  | 'track'
  | 'radio'
  | 'playlist'
  | 'linein'
  | 'airplay'
  | 'spotify'
  | 'bluetooth'
  | 'unknown';

/** What is currently playing. `null` when the zone has nothing loaded. */
export interface ApiTrack {
  title: string;
  artist: string;
  album: string;
  /** Absolute URL, or empty string when the zone has no artwork. */
  coverUrl: string;
}

/** Which source the current audio came from. `null` when nothing is loaded. */
export interface ApiSource {
  kind: ApiSourceKind;
  /** Human-readable source label (station name, service name, input name). */
  name: string;
  /**
   * Opaque provider-native identifier. Clients may pass it back to
   * `POST /api/zones/{id}/play` verbatim, but must not parse it — its
   * internal form is service-specific and not part of this contract.
   */
  id?: string;
}

/** Sync-group membership. `null` when the zone plays on its own. */
export interface ApiGroup {
  /** Zone id of the group leader. */
  leader: number;
  /** Zone ids of all members, leader first. */
  members: number[];
}

/** How the zone reaches its speakers. */
export interface ApiOutput {
  /** e.g. 'sendspin', 'snapcast', 'googlecast', 'dlna', 'sonos', 'airplay'. */
  protocol: string;
  name?: string;
}

/**
 * A zone as the public API presents it. This is the payload of
 * `GET /api/zones`, and of every `zone.changed` event.
 */
export interface ApiZoneState {
  id: number;
  name: string;

  state: ApiPlaybackState;
  power: 'on' | 'off';
  /** Playback position in whole seconds. */
  position: number;
  /** Track length in whole seconds; 0 when open-ended (live radio). */
  duration: number;
  /** 0-100. */
  volume: number;
  repeat: ApiRepeatMode;
  shuffle: boolean;

  track: ApiTrack | null;
  source: ApiSource | null;
  group: ApiGroup | null;
  output: ApiOutput | null;
}

/** Emitted whenever a zone's state changes. Carries the full zone, never a patch. */
export interface ApiZoneChangedEvent {
  type: 'zone.changed';
  zone: ApiZoneState;
}

/** Emitted once per connection, before any `zone.changed`, so clients render immediately. */
export interface ApiServerReadyEvent {
  type: 'server.ready';
  zones: ApiZoneState[];
}

export type ApiEvent = ApiZoneChangedEvent | ApiServerReadyEvent;

/**
 * A zone's 10-band equalizer, in dB per ISO band.
 *
 * Read and written by external equalizer providers as well as our own UI — the
 * LoxBerry Squeezelite Multi-Room plugin pushes here when someone moves a slider in
 * its own web UI (sonn-audio/core#251). Values are clamped to the -6..+6 the Loxone
 * app also uses.
 */
export interface ApiZoneEqualizer {
  zoneId: number;
  /** Ten gains in dB, low band first. */
  bands: number[];
}
