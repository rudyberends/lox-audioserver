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
  /**
   * Whether `PUT /zones/{id}/position` will do anything. False for a live stream,
   * which has no position to seek to — inferring that from `duration === 0` works
   * today but is an assumption the server should not make you repeat.
   */
  seekable: boolean;
  /** Human-readable source label (station name, service name, input name). */
  name: string;
  /**
   * Opaque provider-native identifier. Clients may pass it back to
   * `POST /api/zones/{id}/play` verbatim, but must not parse it — its
   * internal form is service-specific and not part of this contract.
   */
  id?: string;
}

/**
 * What a zone's volume will actually accept. Reported so a client can render a slider
 * that matches, instead of discovering the ceiling by writing past it.
 */
export interface ApiVolumeLimits {
  /** Highest volume this zone will go to, 0-100. */
  max: number;
  /** Volume the zone returns to when it powers on. */
  default: number;
  /** How much a single step should move, for remote-style up/down. */
  step: number;
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
  /**
   * Which device this zone plays to, when the protocol identifies one.
   *
   * Present whether or not the zone is playing, and whether or not the device is
   * currently reachable, so a caller can map its own devices onto zones from a single
   * read (sonn-audio/core#247). `id` is the protocol's own identifier — for
   * squeezelite the SlimProto MAC, which is what its `-m` is set to.
   */
  device?: {
    id: string | null;
    name: string | null;
    /** Whether the device is connected right now. */
    connected: boolean;
  };
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
  /**
   * Current volume, 0-100 — but see `volumeLimits.max`: a zone can be capped, and a
   * write above the cap lands on the cap rather than where you asked.
   */
  volume: number;
  volumeLimits: ApiVolumeLimits;
  repeat: ApiRepeatMode;
  shuffle: boolean;

  track: ApiTrack | null;
  source: ApiSource | null;
  group: ApiGroup | null;
  output: ApiOutput | null;
}

/**
 * Emitted while a track plays and nothing but the position moved.
 *
 * The only event that is not a whole zone. A `zone.changed` is ~550 bytes and a
 * progress tick fires every second per playing zone, so sending the lot to say the
 * clock advanced costs ten times what it says. Every other change still arrives as a
 * full `zone.changed`, so a client that ignores this type stays correct — it just
 * updates its progress bar a beat later.
 */
export interface ApiZoneProgressEvent {
  type: 'zone.progress';
  id: number;
  /** Seconds into the current track. */
  position: number;
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

export type ApiEvent = ApiZoneChangedEvent | ApiZoneProgressEvent | ApiServerReadyEvent;

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

/**
 * One entry in a zone's queue.
 *
 * `id` is this entry's handle — the value you pass back to play, move or remove it.
 * It identifies the entry, not the track: the same track queued twice has two ids.
 */
export interface ApiQueueItem {
  id: string;
  title: string;
  artist: string;
  album: string;
  /** Seconds; 0 when unknown. */
  duration: number;
  coverUrl: string;
  /** Opaque provider-native id, as on `ApiSource.id`. */
  source: string;
}

/**
 * A page of a zone's queue.
 *
 * Paged because a queue can hold thousands of entries and a client usually shows a
 * screenful. `total` is the whole queue, so a caller knows whether to ask for more.
 */
export interface ApiQueue {
  zoneId: number;
  items: ApiQueueItem[];
  /** Offset of the first returned item. */
  start: number;
  /** Length of the whole queue, not of this page. */
  total: number;
  /** Index of the entry currently playing, or null when nothing is. */
  currentIndex: number | null;
}

/**
 * One of a zone's favourites.
 *
 * `id` is the handle: pass it to play, rename or remove this favourite. The Loxone
 * clients also carry a `slot` and a `plus` flag — a fixed position in their own grid and
 * whether the plus button maps to it — which are properties of that UI rather than of
 * the favourite, so neither appears here. Reordering is expressed as the order you send.
 */
export interface ApiFavorite {
  id: number;
  name: string;
  /** Opaque provider-native id, as on `ApiSource.id`. */
  source: string;
  coverUrl: string;
}

/** A page of a zone's favourites. */
export interface ApiFavorites {
  zoneId: number;
  items: ApiFavorite[];
  start: number;
  total: number;
}

/**
 * Something a zone played before, most recent first.
 *
 * Deliberately not a favourite: there is no handle to rename or reorder, only enough to
 * show it and play it again. `source` is what you hand back to `play`.
 */
export interface ApiRecentItem {
  source: string;
  title: string;
  artist: string;
  album: string;
  coverUrl: string;
  /** Which service it came from, e.g. `applemusic`; empty when local. */
  service: string;
}

/** A page of a zone's recently played. */
export interface ApiRecents {
  zoneId: number;
  items: ApiRecentItem[];
  start: number;
  total: number;
}

/**
 * The result of changing a zone's group.
 *
 * `members` is what the group ended up as, which is not always what was asked for:
 * grouping needs matching output protocols unless the server allows mixed groups, so a
 * member on a different protocol is reported in `rejected` rather than silently dropped.
 */
export interface ApiGroupResult {
  leader: number;
  members: number[];
  /** Zones that were asked for but could not join, with why. */
  rejected: Array<{ id: number; reason: 'protocol-mismatch' | 'zone-not-found' }>;
}

/**
 * A sound or spoken message played over whatever a zone was doing, then handed back.
 *
 * The reason this is a resource and not a `play` with a special uri: an alert is an
 * interruption, not a queue entry. The zone's own playback is ducked and resumed around it,
 * the volume comes from that zone's per-alert setting rather than its current level, and
 * several zones can be interrupted together as one announcement.
 */
export type ApiAlertKind = 'tts' | 'bell' | 'alarm' | 'fire' | 'buzzer' | 'url';

export interface ApiAlertRequest {
  kind: ApiAlertKind;
  /** What to say. Required for `tts`, ignored otherwise. */
  text?: string;
  /** BCP-47-ish language hint for `tts`, e.g. `nl` or `en`. Defaults to the server's. */
  language?: string;
  /** What to play. Required for `url`, ignored otherwise. */
  url?: string;
  /**
   * Extra zones to announce in at the same time. The zone in the path leads; a group is
   * formed for the announcement and taken apart again afterwards.
   */
  zones?: number[];
  /** Overrides the zone's configured alert volume for this announcement only, 0-100. */
  volume?: number;
}

export interface ApiAlertResult {
  /** The zone that led the announcement. */
  zoneId: number;
  kind: string;
  /** `on` while it plays, `off` once it has been stopped. */
  action: 'on' | 'off';
  /** Every zone it was played in, leader first. */
  zones: number[];
}

/**
 * A configured physical input a zone can be switched to.
 *
 * Server-level rather than per zone: an input is a configured source with a capture
 * bridge behind it, selectable from any zone, so listing them under one zone would imply
 * each has its own.
 *
 * Read-only. Adding an input, naming it or pointing it at a capture device is
 * configuration and lives in the admin UI; this is here so an integration can see what
 * exists and switch to it.
 */
export interface ApiInput {
  /** Opaque. Hand it back to `PUT /zones/{id}/input`; also what `source.id` reports. */
  id: string;
  name: string;
  /**
   * What is plugged in, as a hint for choosing an icon — `line-in` when nothing was set.
   *
   * **Treat the list as open**: new values may be added, and a client must not fail on
   * one it does not recognise.
   */
  icon: ApiInputIcon;
  /**
   * Whether this input answers transport commands once a zone is on it.
   *
   * False for a turntable or a bare jack: selecting it is the whole interaction, and
   * `pause` on that zone changes nothing audible. True for something like a BeoSound on a
   * MasterLink bus, which switches on but sits idle until told to play — for those, the
   * ordinary `POST /zones/{id}/pause` and friends reach the device.
   */
  controllable: boolean;
  /** Whether the input reports what is playing, so `track` can be more than blank. */
  reportsMetadata: boolean;
}

export type ApiInputIcon =
  | 'line-in'
  | 'cd-player'
  | 'computer'
  | 'imac'
  | 'ipod'
  | 'mobile'
  | 'radio'
  | 'screen'
  | 'turntable';
