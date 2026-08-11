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
 * This is the versioned public contract. Keep its names independent from the
 * internal ZoneState and Loxone vocabulary.
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
  animatedCoverUrl?: string;
  /** Colors derived from the cover artwork, or null when not available. */
  colors: ApiArtworkColors | null;
}

export interface ApiArtworkColors {
  primary: [number, number, number];
  accent: [number, number, number];
  backgroundDark: [number, number, number];
  backgroundLight: [number, number, number];
  onDark: [number, number, number];
  onLight: [number, number, number];
}

/** A user-managed playlist in the local library. */
export interface ApiPlaylist {
  /** Opaque playlist container id; hand it back to browse and play. */
  id: string;
  name: string;
  tracks: number;
  coverUrl?: string;
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
  capabilities?: ApiOutputCapabilities | null;
  /**
   * How this zone's audio is timed against the device, for protocols that can say.
   *
   * Null for outputs that just hand bytes to a renderer and have no clock agreement to report —
   * an absent `sync` means "this protocol cannot answer", not "it is out of sync".
   */
  sync?: ApiOutputSync | null;
}

/**
 * The timing relationship with the device.
 *
 * `state` and `delayMs` are the agreement: the device reports whether it locked onto the shared
 * clock, and `delayMs` is the delay its own chain adds after the audio port — settable, see
 * `PUT /zones/{id}/output/delay`. The rest is the measurement of how well the server is holding
 * its end up, and every one of those is null while nothing is streaming, because they describe a
 * stream in flight.
 *
 * Read `leadMs` against the **band** `[targetLeadMs, targetLeadMs + leadMarginMs]`, not against the
 * target alone. The sender only backpressures at the top of that band, so a healthy stream settles
 * near `targetLeadMs + leadMarginMs` — comparing to the target by itself makes a by-design 100 ms
 * look like 100 ms of trouble. What tells you it is *healthy* is `leadMinMs` — the floor holding at or above the target; a `driftMs` that
 * keeps growing is a timeline slipping rather than one bad moment.
 */
export interface ApiOutputSync {
  /**
   * The device's own verdict on its clock. 'unknown' until it has said; 'external_source' means it
   * switched to its own input and is not playing what this zone sends.
   */
  state: 'synchronized' | 'error' | 'external_source' | 'unknown';
  /**
   * Delay this device's chain adds *after* its audio output, in ms — an amplifier or active speaker.
   *
   * Raising it makes that room play **earlier**, not later: the client subtracts it from every
   * timestamp and so compensates for the delay downstream of it. Use it on a room that arrives late.
   * Positive only. See `PUT /zones/{id}/output/delay`.
   *
   * This is what this server asked for; `deviceDelayMs` is what the device says it has.
   */
  delayMs: number;
  /**
   * The delay the device last declared for itself, or null if it never has.
   *
   * Not a confirmation of `delayMs`. A device applies the command immediately — that is how the
   * protocol works — and does not mention the value until the next state message it sends for some
   * other reason, so this trails every write by design; do not build a "not applied yet" indicator
   * on the difference. It is here because a device can hold a value nobody asked it for, persisted
   * locally for the amplifier it is wired to. Whether it accepts the command at all is answered by
   * its advertised `supported_commands`.
   */
  deviceDelayMs: number | null;
  /** The bottom of the band frames are scheduled in: the least lead the sender allows. */
  targetLeadMs: number;
  /** How far above the target the sender may run before it backpressures. See above. */
  leadMarginMs: number;
  /** The lead achieved on the most recent frame, or null when not streaming. */
  leadMs: number | null;
  /**
   * The lowest lead seen in the last couple of seconds — the floor.
   *
   * The health signal, and deliberately not a spread or a send-interval jitter: the sender bursts
   * frames until the lead reaches the top of its band and then waits, so both of those measure a
   * designed oscillation and read as faults on a perfectly steady stream. While this floor stays at
   * or above `targetLeadMs`, the client always has audio in hand; a floor sinking toward zero is
   * audible as dropouts.
   */
  leadMinMs: number | null;
  /** The modelled timeline against the frame clock; a growing value means slipping. */
  driftMs: number | null;
}

export interface ApiOutputCapabilities {
  formats: Array<{
    codec: string;
    sampleRate: number;
    bitDepth: number;
    channels: number;
  }>;
  roles: string[];
  visualizer: {
    types: string[];
    rateMax: number;
    spectrum: {
      bins: number;
      scale: string;
      fMin: number;
      fMax: number;
    } | null;
  } | null;
}

/**
 * A zone as the public API presents it. This is the payload of
 * `GET /api/zones`, and of every `zone.changed` event.
 */
/**
 * The audio format a zone is streaming.
 *
 * Sendspin already shows its client exactly this, and the admin UI has had it in `tech` all
 * along — but a player built on the public API could not tell a listener what they were
 * hearing. Diagnostics stay out: buffer sizes, restart counts and subscriber drops describe
 * the engine's health, not the audio, and belong in the admin surface.
 */
export interface ApiStreamFormat {
  /** `pcm`, `flac`, `mp3` — the encoding on the wire to the device. */
  codec: string;
  /** Hz, e.g. 44100 or 192000. */
  sampleRate: number;
  /** Bits per sample, e.g. 16 or 24. */
  bitDepth: number | null;
  channels: number;
  /** Bits per second, when known; PCM is derived from its sample format. */
  bitrate: number | null;
  /** True for sample rate above 48 kHz or bit depth above 16 bits. */
  highRes: boolean;
}

/**
 * Every way this server can alter the audio, named.
 *
 * `dspApplied` says *whether* something happened; this says what. Every field is a fact the engine
 * already had — it is produced by the object that builds the ffmpeg command line, from the same inputs,
 * so a stage cannot claim to be absent while its filter is on the command line.
 *
 * All of it is **additive and optional**: a client that ignores `processing` keeps working, and an older
 * server that does not send it is indistinguishable from one whose chain is empty *except* by its
 * absence — which is why the field is `null`-able rather than defaulted to a chain of `false`.
 *
 * Deliberately not here: the zone's volume. That is applied at the device, not in this pipeline, so
 * listing it as processing would claim an alteration this server did not make.
 */
export interface ApiProcessingChain {
  /** The resampler ran: rate, channels or depth changed, or a filter forced the path. */
  resampled: boolean;
  /** Which resampler and how it was configured, when it ran. */
  resampler: { name: string; precision: number; cutoff: number } | null;
  /** The sample depth changed — the source declared one and the output carries another. */
  requantised: boolean;
  /** The channel count changed: a downmix or an upmix. */
  channelsRemapped: boolean;
  /** The output codec re-encodes rather than carrying samples (`aac`, `mp3`, `opus`). */
  reencoded: boolean;
  /** The zone's 10-band equalizer, when any band is off zero. Gains in dB, low band first. */
  equalizer: { bands: number[] } | null;
  /**
   * Gain in dB by origin: the source's own loudness normalisation (Spotify sends one) and the output's
   * fixed trim. Absent when both are zero.
   */
  gainDb: { source: number; output: number } | null;
  /** Pre-delay in ms, for aligning this source against another output. Absent when none. */
  delayMs: number | null;
  /**
   * The dither used where samples lose width — the conversion into a 16-bit output. Null when nothing
   * narrowed, so a `resampled` chain with `dither: null` is a rate change that kept its precision.
   */
  dither: string | null;
  /**
   * Attenuation applied ahead of a boosting equalizer so its boost cannot clip, in dB (negative). This
   * is where the level goes when an EQ preset sounds quieter than the same track without it: exactly the
   * peak of the curve, and no more. Null when the curve needed none.
   */
  headroomDb: number | null;
  /** True while a crossfade is blending, which requantises by definition. */
  crossfading: boolean;
}

export interface ApiAudioFormat {
  /** True when a lossless source reaches the output without conversion or DSP. */
  bitPerfect: boolean;
  /** True when this server performs conversion, filtering, gain, delay or re-encoding. */
  dspApplied: boolean;
  source: ApiStreamFormat | null;
  output: ApiStreamFormat | null;
  /** What was done to the audio, stage by stage. Null when the engine cannot say. */
  processing: ApiProcessingChain | null;
}

export interface ApiZoneState {
  id: number;
  name: string;

  state: ApiPlaybackState;
  powerState: ApiPowerState;
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
  /**
   * What this zone is actually streaming right now, or null when nothing is.
   *
   * The audio as it leaves this server, which is not the same as the file's own format: a
   * zone whose output cannot take 192 kHz gets it resampled, and this reports what the
   * device is really receiving.
   */
  format: ApiAudioFormat | null;
  /**
   * Why the last thing this zone was asked to play did not play, or absent when nothing
   * went wrong.
   *
   * `POST /play` answers `204` for a uri the server cannot resolve, because resolution is
   * asynchronous — the call is accepted before anything has been looked up. So a failure has
   * to surface here, and it arrives as a `zone.changed` like any other state.
   *
   * Before this the only trace was the failure message sitting in `track.title`, which made
   * `if (zone.track)` — the idle check this contract offers — true for a zone playing nothing,
   * so a UI rendered an error as a song title. It clears on the next successful play.
   */
  error?: string;
}

export interface ApiPowerState {
  /** Last confirmed physical power signal. */
  power: 'on' | 'off';
  /** Desired signal after playback rules and explicit commands are applied. */
  target: 'on' | 'off';
  /** Whether this zone has one or more configured physical power actions. */
  managed: boolean;
  /** Automatic idle timeout before switching off, in milliseconds, or null when unmanaged. */
  idleTimeoutMs: number | null;
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

/**
 * A zone's queue changed — someone added, removed, reordered or cleared something.
 *
 * Carries the size, not the queue. A queue is paged and can hold thousands of entries, so
 * putting it in an event that fires on every edit would be the wrong trade; re-read
 * `GET /zones/{id}/queue` for the page you are showing.
 *
 * This exists because without it a client cannot know a queue changed at all — including
 * when *another* client changes it. Our own player worked around that by re-reading after
 * its own edits, which left a second tab stale indefinitely. The Loxone protocol has had
 * this event all along (`audio_queue_event`); it simply was not forwarded here.
 */
export interface ApiQueueChangedEvent {
  type: 'queue.changed';
  id: number;
  /** How many entries the queue now holds. */
  size: number;
}

/** A zone's favourites changed. Carries the count for the same reason the queue does. */
export interface ApiFavoritesChangedEvent {
  type: 'favorites.changed';
  id: number;
  count: number;
}

/** A zone played something new, so its recently-played list moved. */
export interface ApiRecentsChangedEvent {
  type: 'recents.changed';
  id: number;
}

export type ApiEvent =
  | ApiZoneChangedEvent
  | ApiZoneProgressEvent
  | ApiServerReadyEvent
  | ApiQueueChangedEvent
  | ApiFavoritesChangedEvent
  | ApiRecentsChangedEvent;

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
  animatedCoverUrl?: string;
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
 * Somewhere audio can be sent.
 *
 * A zone is one kind of destination, but not the only one, and this server does not require
 * zones at all: it can run as a DLNA source with a streaming account and nothing else. The
 * zone concept exists because the Loxone clients need everything to be one — a browser tab
 * playing locally was given a synthetic zone in the reserved 9000 range purely so it would
 * be visible. That is a translation artefact, not a fact about audio.
 *
 * So a destination is the smaller, honest idea: an id you can play to. Zones are destinations
 * with more attached — grouping, favourites, a queue — and keep their own routes.
 *
 * Called `destinations` rather than `outputs` because a zone already *has* an `output`
 * (its protocol and device), and rather than `players` because that already means this
 * server's own app, `tech.player`, and the `managedPlayers` setting.
 */
export interface ApiDestination {
  /** Opaque; use it in `/destinations/{id}/…`. */
  id: string;
  name: string;
  /**
   * What kind of thing this is.
   *
   * `zone` is a configured zone, addressable through `/zones/{id}` as well. `local` is a
   * client playing the audio itself — a browser tab — which exists only while it is
   * connected.
   */
  kind: 'zone' | 'local';
  /** How audio reaches it: `sendspin`, `snapcast`, `googlecast`, and so on. */
  protocol: string;
  /** Whether it is reachable right now. */
  available: boolean;
}

/** An audioserver known through the installation configuration. */
export interface ApiAudioServer {
  id: string;
  name: string | null;
  host: string | null;
  self: boolean;
  kind: 'sonn-core' | 'loxone';
}

export interface ApiAudioServers {
  selfId: string | null;
  servers: ApiAudioServer[];
}

/** What a client needs to start receiving audio itself. */
export interface ApiLocalDestination extends ApiDestination {
  kind: 'local';
  /** The client id to announce on the audio socket, so the server knows which one you are. */
  clientId: string;
  /** The WebSocket to connect to. Absolute, so it works from any origin. */
  streamUrl: string;
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

/**
 * What a browsable or playable thing is.
 *
 * The field that makes this model better than the Loxone one, whose `type` number collapses
 * album, artist, playlist and show onto a single value — so its clients cannot tell them
 * apart and neither could ours.
 *
 * **Treat the list as open.** New kinds will be added; a client must not fail on one it does
 * not recognise, and `unknown` is the placeholder for exactly that.
 */
export type ApiItemKind =
  | 'track'
  | 'album'
  | 'artist'
  | 'playlist'
  | 'radio'
  | 'show'
  | 'episode'
  | 'category'
  | 'folder'
  | 'unknown';

/** One row in a browse listing or a search result. */
export interface ApiBrowseItem {
  /** Opaque. Feed it back to browse, to items, or to play. Never parse it. */
  id: string;
  name: string;
  kind: ApiItemKind;
  /** Whether `GET /browse/{id}` will list anything inside it. */
  browsable: boolean;
  /** Whether it can be handed to `POST /zones/{id}/play`. */
  playable: boolean;
  /** The provider under its own name — `applemusic`, never a Spotify disguise. */
  service: string;
  artist?: string;
  album?: string;
  /** Seconds, when known. */
  duration?: number;
  coverUrl?: string;
  /** Optional animated artwork URL; clients should fall back to coverUrl. */
  animatedCoverUrl?: string;
}

/** A page of children. */
export interface ApiBrowseResult {
  /** The container that was listed, or null for the root, which has no id. */
  container: ApiBrowseItem | null;
  items: ApiBrowseItem[];
  /** Optional grouped content, used by feed-style services such as Apple Music Home. */
  sections?: ApiBrowseSection[];
  start: number;
  /**
   * How many children the container holds, or **null when the provider cannot say**.
   *
   * Null is the honest answer rather than a guess: several providers page without reporting
   * a count. When it is null, page until you get fewer items than you asked for.
   */
  total: number | null;
}

export interface ApiBrowseSection {
  id: string;
  name: string;
  items: ApiBrowseItem[];
}

/** Search results, grouped by kind. */
export interface ApiSearchResult {
  query: string;
  /**
   * One bucket per kind that was searched. A kind absent here was not searched — check
   * `GET /services` to see what a provider can actually search for, rather than assuming
   * every provider serves every kind.
   */
  items: Partial<Record<ApiItemKind, ApiBrowseItem[]>>;
  /** Which services answered, and which of them failed. */
  services: Array<{ service: string; failed?: boolean }>;
}

/**
 * The story around an item: who this is, and who stands next to them.
 *
 * Answered by `GET /items/{id}/about`, and **404 is the ordinary answer** — an item nobody has
 * written about, a kind nobody writes about, or a story not assembled yet. Clients render nothing
 * on 404 rather than treating it as an error.
 */
export interface ApiItemAbout {
  /** Plain text, paragraphs separated by blank lines. Null when there is prose for neither. */
  description: string | null;
  /**
   * Related items — real ones. Every entry is browsable or playable through this same API, which
   * is why a related act this server has no copy of is absent rather than listed as a name.
   */
  similar: ApiBrowseItem[];
  /** Where the prose came from. Free sources require the credit, so it travels with the text. */
  source: { name: string; url: string | null } | null;
}

/** A content service, with what it can actually do. */
export interface ApiService {
  /** Provider name, as used in `service` on every item. */
  id: string;
  name: string;
  /** The id to browse this service's top level. */
  rootId: string;
  /** Which kinds its search returns. Empty means it cannot search. */
  searchableKinds: ApiItemKind[];
}
