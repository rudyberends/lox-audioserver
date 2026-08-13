export interface AudioServerConfig {
  system: SystemConfig;
  content: ContentConfig;
  zones: ZoneConfig[];
  rawAudioConfig: RawAudioConfig;
  inputs?: InputConfig;
  groups?: GroupConfig;
  /**
   * Publishes zone state to an MQTT broker. Top-level rather than under `content`
   * because it serves nothing — it is an outbound integration, not another way to
   * reach this server's music.
   */
  mqtt?: MqttConfig;
  /**
   * Devices running Sonn Client. Top-level for the same reason `mqtt` is: these are machines this
   * server administers, not another way to reach its music.
   */
  sonnClients?: SonnClientsConfig;
  updatedAt?: string;
}

/**
 * Pushes zone state to an MQTT broker, so home automation can consume it without
 * polling and without speaking our HTTP API.
 *
 * The payload is the same `ApiZoneState` an SSE client receives, published as JSON
 * on retained topics. That is deliberate: an MQTT-shaped vocabulary invented here
 * would be a second contract to keep in step with the first, and the reason this
 * exists at all is that integrators were reimplementing change detection — a full
 * shadow copy of every field, diffed on a one-second poll — for want of a push feed.
 */
export interface MqttConfig {
  /** Master switch. When absent/false nothing connects and nothing is published. */
  enabled?: boolean;
  /** Broker hostname or IP. */
  host?: string;
  /** Defaults to 1883, or 8883 when the protocol is `mqtts`. */
  port?: number;
  protocol?: 'mqtt' | 'mqtts';
  username?: string;
  password?: string;
  /**
   * Prefix every topic sits under, defaulting to `sonn`. Lets two servers share a
   * broker without colliding.
   */
  topicPrefix?: string;
  /**
   * Whether to publish `position` while a track plays.
   *
   * Off by default: it changes every second, and a broker retaining one message per
   * second per zone forever is a cost most consumers did not ask for. Turn it on if
   * you want a progress bar; leave it off and you still get every state change.
   */
  publishProgress?: boolean;
}

export interface SystemConfig {
  miniserver: MiniserverConfig;
  audioserver: AudioserverConfig;
  logging: LoggingConfig;
  adminHttp: AdminHttpConfig;
  /** Accounts this server authenticates itself. See {@link UserAccount}. */
  users?: UserAccount[];
}

/**
 * A server-local account.
 *
 * This is the server's own user store, used everywhere it authenticates someone:
 * the admin UI and the Subsonic API. In Loxone-integrated mode it sits alongside
 * Miniserver accounts (which remain the primary identity); in standalone mode,
 * where there is no Miniserver to ask, it is the only source of authentication.
 */
export interface UserAccount {
  username: string;
  /**
   * Stored in the clear, deliberately.
   *
   * Subsonic's salted-token login sends `md5(password + salt)` with a
   * per-request salt, so the server must be able to compute that same digest —
   * which means holding the original. A one-way hash would make token
   * authentication impossible, and that is the form most clients default to.
   */
  password: string;
  /** Grants admin UI access. Absent/false means the account can stream, not configure. */
  admin?: boolean;
  /** Optional display name for the admin UI. */
  label?: string;
  /**
   * How this account came to exist.
   *
   * `loxone` entries are created automatically when a Miniserver user logs in
   * and their password is verified — that is the only moment the server ever
   * sees it, and holding it is what lets salted-token clients authenticate as
   * them. Such an entry is refreshed on every subsequent login, so it follows a
   * password change in Loxone. `local` entries were created by hand and are
   * never overwritten by a Loxone login.
   */
  source?: 'local' | 'loxone';
  /** When the credential was last verified, ISO 8601. Informational. */
  verifiedAt?: string;
}

export interface MiniserverConfig {
  ip: string;
  serial: string;
  port?: number;
  protocol?: 'http' | 'https';
}

export interface AudioserverConfig {
  ip: string;
  name: string;
  uuid: string;
  macId: string;
  paired: boolean;
  /**
   * @deprecated Retired in favour of `loxoneEnabled` + `setupComplete`. Still read
   * once by config migration to seed those flags for existing installs, then never
   * written again. There is no deployment "mode" anymore — the server is just a
   * server, and Loxone is a connection you opt into (see `loxoneEnabled`).
   */
  mode?: 'loxone' | 'standalone';
  /**
   * Whether the Loxone integration is connected. When true the server runs the
   * Loxone protocol stack (Miniserver/native-app servers + discovery) and players
   * are pushed by the Miniserver; when false/absent it is a plain audio server and
   * players are managed locally. Toggled from the Players screen's Loxone modal;
   * a change is applied by a soft restart. The stack must run before a Miniserver
   * can pair, so connecting sets this true, then pairing sets `paired`.
   */
  loxoneEnabled?: boolean;
  /**
   * Set once the first-run welcome has been dismissed. Absent/false shows the
   * minimal welcome intro; true drops straight into the admin shell. Not a mode —
   * purely "has the user gotten started".
   */
  setupComplete?: boolean;
  /**
   * Opt-in for the local player layer when Loxone is not connected. Absent = treat
   * as enabled if any zones already exist, off otherwise — so a fresh box is a pure
   * content/access server (DLNA/Subsonic) until players are turned on. Ignored when
   * `loxoneEnabled` is true, where zones are always pushed by the Miniserver.
   */
  managedPlayers?: boolean;
  /** When false, admin UI is accessible without authentication even if paired (default true). */
  authEnabled?: boolean;
  extensions: AudioserverExtensionConfig[];
  /** Optional SlimProto control port (default 3483). */
  slimprotoPort?: number;
  /** Optional LMS-compatible telnet CLI port (default 9090). */
  slimprotoCliPort?: number;
  /** Optional LMS-compatible JSON-RPC port (default 9000). */
  slimprotoJsonPort?: number;
  /** Global crossfade duration in seconds between songs (0 or absent = disabled). */
  crossfadeSec?: number;
}

export interface AudioserverExtensionConfig {
  mac: string;
  name: string;
}

export interface LoggingConfig {
  consoleLevel: 'spam' | 'debug' | 'info' | 'warn' | 'error' | 'none';
  fileLevel: 'spam' | 'debug' | 'info' | 'warn' | 'error' | 'none';
}

export interface AdminHttpConfig {
  enabled: boolean;
}

export interface ContentConfig {
  radio: RadioContentConfig;
  spotify: SpotifyContentConfig;
  /**
   * First-class accounts for the non-Spotify streaming services (Apple Music,
   * Tidal, Deezer, SoundCloud, YouTube/Music, Music Assistant). Each is a
   * neutral service account — the "bridge" framing (disguising them as Spotify)
   * exists only in the Loxone adapter, which needs it because Loxone knows just
   * Spotify natively. Migrated once from the legacy `spotify.bridges` location.
   */
  streamingServices?: StreamingServiceConfig[];
  library?: LibraryContentConfig | null;
  tts?: TtsContentConfig;
  appleMusic?: AppleMusicContentConfig;
  mediaServer?: MediaServerContentConfig;
  subsonic?: SubsonicContentConfig;
  webdav?: WebdavContentConfig;
}

/**
 * Serves the music folder as a mountable WebDAV drive at `/dav`.
 *
 * Complements the JSON upload endpoint, which can only take one base64-encoded
 * file per request: mounting the share lets a whole album be dragged in with the
 * file manager. Writes are indexed incrementally rather than by full rescan.
 *
 * Authenticates with the same local accounts over HTTP Basic, because Finder and
 * Explorer have no way to carry the admin session cookie.
 */
export interface WebdavContentConfig {
  /** Master switch. When absent/false `/dav` is not served at all. */
  enabled?: boolean;
}

/**
 * Exposes all browsable content (local library, radio and the streaming bridges)
 * as a UPnP/DLNA MediaServer so third-party renderers can pull it directly.
 *
 * This is the inverse of the per-zone DLNA *output*: instead of pushing a stream
 * to a renderer we advertise a ContentDirectory and serve tracks statelessly at
 * `/dlna/track/<id>` off the main gateway.
 */
export interface MediaServerContentConfig {
  /** Master switch. When absent/false the MediaServer is not advertised or served. */
  enabled?: boolean;
  /** Friendly name shown to DLNA clients (defaults to the audioserver name). */
  friendlyName?: string;
  /**
   * Optional provider allowlist restricting which top-level services are exposed
   * (e.g. ['library','radio','soundcloud']). Absent = expose every browsable
   * service the content layer offers. `outputOnly` providers (pure Spotify
   * Connect offload) can never be exposed regardless of this list.
   */
  providers?: string[];
}

/**
 * Exposes the same browsable content as a Subsonic server, so any Subsonic client
 * (Symfonium, DSub, play:Sub, Amperfy, Feishin, …) can browse and stream it over
 * `/rest/*`.
 *
 * Sits alongside the DLNA MediaServer rather than replacing it: DLNA is pull-based
 * device discovery on the LAN, Subsonic is an authenticated app-facing API that
 * also works off-LAN when the gateway is reachable.
 *
 * Accounts are deliberately absent here: the API authenticates against the
 * server's shared user store ({@link SystemConfig.users}) and, in
 * Loxone-integrated mode, against Miniserver accounts.
 */
export interface SubsonicContentConfig {
  /** Master switch. When absent/false the API answers "not authorized" and nothing else. */
  enabled?: boolean;
  /**
   * Optional provider allowlist restricting which services are exposed
   * (e.g. ['library','radio','applemusic']). Absent = every browsable service.
   */
  providers?: string[];
  /**
   * Ceiling on how many children one directory returns.
   *
   * `getMusicDirectory` has no paging in the protocol — the whole directory must
   * fit in a single response — so a huge provider container (a 5000-track
   * playlist, a full "Liked Songs") is materialised by walking the content
   * layer's pages. This caps that walk; listings that hit it are logged as
   * truncated. Defaults to 1000.
   */
  directoryLimit?: number;
}

export interface AppleMusicContentConfig {
  /**
   * Default MusicKit developer token (ES256 JWT). Used to bootstrap the browser sign-in flow and
   * as the Apple Music API bearer (a per-bridge `developerToken` overrides it). Expires (~6 months)
   * — regenerate from the Apple Developer MusicKit key and replace it before `exp`.
   */
  developerToken?: string;
}

export interface RadioContentConfig {
  tuneInUsername?: string | null;
  /**
   * Radio Paradise as a toggleable provider (like a streaming service). Absent
   * or true = available; false = its folders return empty so it disappears from
   * our own consumers (player/DLNA) and the native Loxone Radio tile alike.
   */
  radioParadise?: { enabled?: boolean };
}

export interface SpotifyContentConfig {
  clientId?: string;
  accounts: SpotifyAccountConfig[];
  /**
   * @deprecated Non-Spotify accounts moved to `content.streamingServices`. This
   * field is only read once by the config migration, then cleared. Nothing
   * writes it anymore.
   */
  bridges?: StreamingServiceConfig[];
  /** Cache decoded audio files to disk. Defaults to true. */
  cacheEnabled?: boolean;
  /** Maximum size of the audio cache in megabytes. Defaults to 1024. */
  cacheSizeMb?: number;
}

export interface LibraryContentConfig {
  enabled?: boolean;
  autoScan?: boolean;
}

export interface TtsContentConfig {
  provider?: TtsProviderConfig;
  /** When true, fall back to the internal provider if an external provider cannot create audio. */
  fallbackToInternal?: boolean;
}

export type TtsProviderConfig = InternalTtsProviderConfig | LoxBerryTtsProviderConfig;

export interface InternalTtsProviderConfig {
  type: 'internal';
}

export interface LoxBerryTtsProviderConfig {
  type: 'loxberry-tts';
  enabled?: boolean;
  host?: string;
  mqttPort?: number;
  protocol?: 'mqtt' | 'mqtts';
  username?: string;
  password?: string;
  clientId?: string;
  requestTopicPrefix?: string;
  responseTopicPrefix?: string;
  timeoutMs?: number;
  /** Optional HTTP base URL used when LoxBerry returns hostless URLs like http:///plugins/... */
  httpBaseUrl?: string;
  nocache?: boolean;
  logging?: boolean;
  mp3files?: boolean;
  function?: string;
}

export interface SpotifyAccountConfig {
  id?: string;
  spotifyId?: string;
  user?: string;
  email?: string;
  clientId?: string;
  product?: string;
  country?: string;
  name?: string;
  displayName?: string;
  refreshToken?: string;
  /** Optional librespot credentials blob (base64 encoded credentials.json). */
  credentialsBlob?: string;
  /** Raw contents of a librespot credentials.json blob for this account. */
  librespotCredentials?: any;
  /** Optional default device id to advertise for this account. */
  deviceId?: string;
}

export interface StreamingServiceConfig {
  id: string;
  label: string;
  provider: string;
  accountId?: string;
  enabled?: boolean;
  host?: string;
  port?: number;
  apiKey?: string;
  /** Optional YouTube Music cookie header string when provider === 'ytmusic' (e.g. "SID=...; HSID=..."). */
  ytmusicCookie?: string;
  /** Optional YouTube Data API v3 key when provider === 'youtube'. Enables better search and trending. */
  youtubeApiKey?: string;
  /** Optional Apple Music tokens if provider === 'applemusic' */
  developerToken?: string;
  userToken?: string;
  /** Optional Deezer ARL cookie if provider === 'deezer' */
  deezerArl?: string;
  /** Optional Tidal access token if provider === 'tidal' */
  tidalAccessToken?: string;
  /** Optional Tidal country code if provider === 'tidal' */
  tidalCountryCode?: string;
  /**
   * Optional SoundCloud OAuth token if provider === 'soundcloud'. Public
   * browse/search/charts and preview playback work without it; a token unlocks
   * full-length tracks plus the user's likes, followings and playlists.
   */
  soundcloudOauthToken?: string;
  /**
   * Optional pre-scraped SoundCloud web client_id. Normally resolved and cached
   * automatically from the public web player; set this only to pin a value.
   */
  soundcloudClientId?: string;
  /** Optional Apple Music input pacing toggle (true keeps ffmpeg -re; false disables pacing). */
  appleMusicPaceInput?: boolean;
  /** When true, register all zones as players up front; otherwise register on-demand. */
  registerAll?: boolean;
  /**
   * Music Assistant integration mode.
   * - 'source' (default, current behaviour): we register virtual sendspin players per Loxone zone and stream MA audio back to our outputs.
   * - 'sink': MA players are external sinks; zone outputs reference an MA player by id and we proxy commands/state via RPC instead of streaming audio.
   * Only meaningful when provider === 'musicassistant'.
   */
  mode?: 'source' | 'sink';
}

export interface ZoneOutputConfig {
  id: string;
  [key: string]: unknown;
}

export type ZoneTransportConfig = ZoneOutputConfig;

export interface ZoneConfig {
  id: number;
  name: string;
  source?: string;
  sourceSerial?: string;
  sourceMac: string;
  output?: ZoneOutputConfig | null;
  transports?: ZoneTransportConfig[];
  equalizer?: ZoneEqualizerConfig | null;
  playback?: ZonePlaybackConfig | null;
  powerManager?: ZonePowerManagerConfig | null;
  state?: ZoneStateConfig;
  volumes: ZoneVolumesConfig;
  inputs?: ZoneInputConfig;
}

export interface ZoneEqualizerConfig {
  /** Loxone App 10-band EQ values in dB, one integer per band (-6..+6). */
  bands?: number[];
  /**
   * How App-originated EQ writes are handled.
   * - 'off' (default): writes are stored only; no equalizer is applied.
   * - 'builtin': bands are applied locally inside the audioserver's ffmpeg pipeline.
   * - 'squeezelite-mr': bands are forwarded to the LoxBerry Squeezelite Multi-Room plugin.
   */
  provider?: ZoneEqualizerProvider;
  /** Provider-specific callback URL. Used by 'squeezelite-mr'. */
  callbackUrl?: string;
}

export type ZoneEqualizerProvider = 'off' | 'builtin' | 'squeezelite-mr';

export interface ZonePlaybackConfig {
  /**
   * When true, pausing the zone immediately resets the runtime volume to the
   * configured default volume (matches the reference Loxone Audio Server's
   * behavior). Defaults to false.
   */
  resetVolumeOnPause?: boolean;
}

export interface ZonePowerManagerConfig {
  /** Optional shared power group id for aggregate amp/PSU switching across zones. */
  powerGroupId?: string;
  /**
   * Zone modes that should keep power ON.
   * Defaults to ['play'] so paused/stopped states turn power OFF.
   */
  activeModes?: Array<'play' | 'pause'>;
  /**
   * Optional audio pre-delay (ms) inserted before playback starts for this zone.
   * Useful to let amplifiers/speakers wake up before audible content begins.
   */
  playbackPreDelayMs?: number;
  /** Enable delayed OFF behavior; when false, OFF is immediate. */
  offDelayEnabled?: boolean;
  /** Delay before applying OFF actions (zone exits play mode). Defaults to 300000 ms. */
  offDelayMs?: number;
  gpio?: ZoneGpioPowerConfig | null;
  url?: ZoneUrlPowerConfig | null;
  udp?: ZoneUdpPowerConfig | null;
  crelay?: ZoneCrelayPowerConfig | null;
}

export interface ZoneGpioPowerConfig {
  /** Enable GPIO power switching for this zone. */
  enabled?: boolean;
  /** GPIO line offset within the selected gpiochip. */
  pin?: number;
  /** true => ON writes 1, false => ON writes 0. */
  activeHigh?: boolean;
  /** GPIO line-based backend (libgpiod). */
  driver?: 'gpioset';
  /** gpioset chip path or chip name (default: gpiochip0). */
  chip?: string;
  /** Optional custom gpioset binary path. */
  gpiosetPath?: string;
}

export interface ZoneUrlPowerConfig {
  /** Enable HTTP URL on/off calls for this zone. */
  enabled?: boolean;
  /** URL to call when zone starts playing. */
  onUrl?: string;
  /** HTTP method for the ON request; defaults to GET. */
  onMethod?: string;
  /** Optional request body for the ON request. Objects/arrays are JSON encoded. */
  onBody?: unknown;
  /** URL to call when zone stops/pauses. */
  offUrl?: string;
  /** HTTP method for the OFF request; defaults to GET. */
  offMethod?: string;
  /** Optional request body for the OFF request. Objects/arrays are JSON encoded. */
  offBody?: unknown;
  /** Optional custom curl binary path. */
  curlPath?: string;
  /** Use --insecure for HTTPS calls (default true to match MS4L behavior). */
  insecure?: boolean;
}

export interface ZoneUdpPowerConfig {
  /** Enable UDP message based power control for this zone. */
  enabled?: boolean;
  host?: string;
  port?: number;
  onPayload?: string;
  offPayload?: string;
}

export interface ZoneCrelayPowerConfig {
  /** Enable CRelay switching for this zone. */
  enabled?: boolean;
  /** Relay card serial identifier passed via -s (optional, first detected card when omitted). */
  serial?: string;
  /** Relay identifier/channel passed to crelay binary. */
  relay?: string;
  /** Optional custom crelay binary path (default: /usr/local/bin/crelay). */
  binaryPath?: string;
}

export interface ZoneStateConfig {
  /** State authority for this zone. "internal" means current behavior (no external state ingest). */
  controller?: string;
  [key: string]: unknown;
}

export interface ZoneVolumesConfig {
  default: number;
  alarm: number;
  fire: number;
  bell: number;
  buzzer: number;
  tts: number;
  volstep: number;
  fading: number;
  maxVolume: number;
}

export interface ZoneInputConfig {
  airplay?: ZoneAirplayConfig | null;
  spotify?: ZoneSpotifyConfig | null;
  musicassistant?: ZoneMusicAssistantConfig | null;
  lineIn?: ZoneLineInConfig | null;
  dlna?: ZoneDlnaConfig | null;
  beoremote?: ZoneBeoremoteConfig | null;
  bluetooth?: ZoneBluetoothConfig | null;
}

/**
 * Beoremote One control for this zone.
 *
 * What the remote shows and what its keys do, and — since Sonn Clients — *which* remote. A device
 * screen is where a remote is paired, because that is a fact about the box its radio talks to; a
 * room is where it is put to work, because that is a fact about the room. Naming the zone from the
 * device was the wrong way round: it made assigning a remote something you did on the hardware page
 * rather than beside the output it belongs with.
 */
export interface ZoneBeoremoteConfig {
  enabled: boolean;
  /**
   * Sonn Client device whose paired remote drives this zone.
   *
   * Absent means any bridge that names this zone itself, which is how the standalone Python bridge
   * works and how this behaved before a device could be claimed here.
   */
  deviceId?: string;
  /** Volume points per key press, on the 0-100 scale. Absent leaves the device's own default. */
  volumeStep?: number;
  /**
   * What fills the single submenu the remote's firmware allows. See
   * {@link BeoremoteSubmenuSource}; omitted means no submenu.
   */
  submenuSource?: BeoremoteSubmenuSource | null;
  /** Include this zone's favorites as sources. Defaults to true. */
  includeFavorites?: boolean;
  /** Include line-in inputs (turntable, CD player) as sources. Defaults to true. */
  includeLineIns?: boolean;
  /**
   * What the coloured and dot keys do, keyed by button name (`red`, `green`,
   * `yellow`, `blue`, `dot1`…`dot4`). A button with no entry falls back to the
   * favorite in the slot it sits at; an entry of `{kind:'none'}` disables it.
   *
   * Which HID code is which button stays in the server — that is a property of the
   * remote. This is only what each button should mean here.
   */
  keys?: Record<string, BeoremoteKeyBinding> | null;
}

/** What a configurable Beoremote button does when pressed. */
export type BeoremoteKeyBinding =
  /** Deliberately dead: the key answers 404 and the bridge logs it. */
  | { kind: 'none' }
  /** Start one of this zone's favorites, by its slot number. */
  | { kind: 'favorite'; slot: number }
  /** Switch the zone to a line-in input. */
  | { kind: 'lineIn'; inputId: string }
  /** Start a radio station by its audiopath, with the name to show in the UI. */
  | { kind: 'radio'; audiopath: string; name?: string };

/**
 * Bluetooth audio into this zone: a phone pairs with a Sonn Client and plays to the room.
 *
 * The radio is on the device, so which device carries this zone's Bluetooth is a fact about the
 * hardware; that the room accepts it is a fact about the room. Same split as the remote — paired on
 * the device's screen, put to work here.
 *
 * Unlike AirPlay or DLNA, nothing is received by the server: the client terminates A2DP and streams
 * the audio in as an ordinary source, so this is a switch and a name, not a receiver.
 */
export interface ZoneBluetoothConfig {
  /** Accept Bluetooth audio in this zone. */
  enabled: boolean;
  /** Sonn Client whose radio this zone uses. */
  deviceId?: string;
  /** What a phone sees when it looks for something to pair with. Defaults to the zone name. */
  publishName?: string;
  /**
   * How long the device stays visible after someone asks it to be, in seconds.
   *
   * Visible forever is an invitation; visible never is unusable. The window is opened from the UI
   * and closes by itself, the way every consumer device does it.
   */
  discoverableSeconds?: number;
  /**
   * A fixed passkey to show, for phones that ask for one.
   *
   * Most modern pairings are Just Works and show a confirmation on both screens instead. This is
   * for the ones that do not, and for installations that want a code on the wall.
   */
  pin?: string;
  /** Let a paired phone's transport keys and metadata reach the zone (AVRCP). */
  control?: boolean;
}

export interface ZoneDlnaConfig {
  /** Expose this zone as a DLNA/UPnP MediaRenderer that apps can cast to. */
  enabled: boolean;
  /** Optional friendly name shown to casting apps (defaults to the zone name). */
  publishName?: string;
}

/**
 * Server-wide input configuration. Receivers (AirPlay / Spotify Connect / DLNA) are
 * configured per player on `zone.inputs` — there is no global on/off for them, so
 * only genuinely server-wide input settings live here.
 */
export interface InputConfig {
  spotify?: GlobalSpotifyConfig | null;
  lineIn?: GlobalLineInConfig | null;
}

export interface GroupConfig {
  /** Allow grouping zones across different output protocols (best effort). */
  mixedGroupEnabled?: boolean;
  /** Optional shared power groups driven by aggregate zone activity. */
  powerGroups?: PowerGroupConfig[];
  /** Persisted user-created audio sync groups (restored on startup). */
  audioGroups?: PersistedAudioGroup[];
}

export interface PersistedAudioGroup {
  leader: number;
  members: number[];
  externalId: string;
}

export interface PowerGroupConfig {
  /** Stable identifier referenced by zone.powerManager.powerGroupId. */
  id: string;
  /** Optional friendly name used for logs/admin visibility. */
  name?: string;
  /** Power switching behavior for the shared group output. */
  powerManager?: ZonePowerManagerConfig | null;
}

export interface GlobalSpotifyConfig {
  clientId?: string;
  accounts?: SpotifyAccountConfig[];
}

export interface GlobalLineInConfig {
  inputs?: LineInInputConfig[] | null;
}

export interface ZoneAirplayConfig {
  model?: string;
  enabled: boolean;
  port?: number;
  native?: NativeInputBinding | null;
}

export interface ZoneSpotifyConfig {
  enabled: boolean;
  publishName?: string;
  port?: number;
  /** Enable offloading playback to a Spotify Connect device/controller. */
  offload?: boolean;
  /** Link this zone to a Spotify account id from the global config. */
  accountId?: string;
  deviceId?: string;
  /** Optional librespot username to force login (disables discovery when set with password). */
  username?: string;
  /** Optional librespot password to force login (disables discovery when set). */
  password?: string;
  /** Explicitly disable discovery; useful when forcing credentials. */
  disableDiscovery?: boolean;
}

export interface ZoneMusicAssistantConfig {
  enabled: boolean;
  /** Optional friendly name to expose for the built-in MA player. */
  publishName?: string;
  /** Offload playback to an existing MA player instead of the built-in one. */
  offload?: boolean;
  /** Target MA player id when offloading. */
  deviceId?: string;
}

export interface NativeInputBinding {
  enabled: boolean;
  instanceId?: string;
  description?: string;
  deviceId?: string;
}

export interface ZoneLineInConfig {
  enabled: boolean;
  device?: string;
  format?: string;
}

export interface LineInInputConfig {
  id?: string;
  name?: string;
  iconType?: number;
  source?: Record<string, unknown> | null;
  metadataEnabled?: boolean;
  /**
   * Whether this source can be driven at all.
   *
   * A turntable or a bare jack hears nothing we say: selecting it is the whole
   * interaction. A BeoSound 9000 on a MasterLink bus is the opposite — it will
   * switch on but sit idle until told to play, and it can be stopped again when the
   * zone moves on.
   *
   * Saying yes here is what opens the command path: the server sends `start` on
   * selection and `stop` when the zone leaves, plus transport keys as they arrive.
   * Saying no means nothing is ever sent, so nothing waits on hardware that was
   * never going to answer.
   *
   * The device's own hook maps each verb onto whatever the hardware speaks, so adding
   * a verb is a change to that script rather than to this server.
   */
  controllable?: boolean;
}

/**
 * What fills the one available submenu.
 *
 * The remote reads only SOURCE_CONTENT_1 and never reports which submenu it
 * opened, so a second flagged source would just show the first one's contents.
 * Exactly one source may carry it, and the menu builder enforces that — this
 * setting only chooses what goes in it.
 */
export type BeoremoteSubmenuSource =
  | { kind: 'none' }
  | { kind: 'radio' }
  | { kind: 'favorites' }
  /** A folder from a browsable service, flattened to its first page of entries. */
  | { kind: 'serviceFolder'; service: string; user?: string; folderId: string; title?: string };

/**
 * Devices running Sonn Client — a Pi (or comparable) that speaks nothing but Sendspin and takes its
 * entire configuration from here.
 *
 * The point of this section is that the device holds no settings of its own beyond its identity.
 * Which sound card it plays through, what the room is called, its output delay, whether volume is
 * done in software or by an amplifier: all of it lives here and is pushed down on the device's next
 * poll. Nobody has to open a terminal on a speaker to change something.
 */
export interface SonnClientsConfig {
  /** How often a device should poll for its desired state. Defaults to 5s, clamped 1-60s. */
  pollIntervalMs?: number;
  /** Per-device configuration, keyed by the device's own stable id. */
  devices?: SonnClientDeviceConfig[];
  /**
   * Software the client installs on request — currently only B&O's patched BlueZ, which is what
   * makes a Beoremote One serve menus. Declared once and offered to whichever devices ask for the
   * features that need it.
   */
  components?: SonnClientComponentConfig[];
}

export interface SonnClientDeviceConfig {
  /** The device's stable id, as it registers itself. */
  deviceId: string;
  /** Friendly name for the device as a whole; a player without a name of its own inherits it. */
  name?: string;
  /** False stops this device playing anything without forgetting how it was set up. */
  enabled?: boolean;
  /** Sendspin players, one per sound card. A device with two DACs serves two rooms. */
  players?: SonnClientPlayerConfig[];
  /** Capture devices offered to the server as selectable line-in sources. */
  sources?: SonnClientSourceConfig[];
  /** Beoremote One support for this device. */
  beoremote?: SonnClientBeoremoteConfig | null;
  /** Components this device should have installed. Names must exist in `components`. */
  requiredComponents?: string[];
  /** Last registration, recorded so the admin UI can show a device that is currently offline. */
  lastSeen?: string;
  hostname?: string;
  ip?: string;
  mac?: string;
  model?: string;
  version?: string;
}

export interface SonnClientPlayerConfig {
  /**
   * Sendspin client id. This is what a zone's output configuration points at, so it has to stay
   * stable for as long as the room is expected to keep working.
   */
  clientId: string;
  name?: string;
  /** Output device id as the client reported it; absent means the host default. */
  output?: string;
  enabled?: boolean;
  /** Delay the speaker's own chain adds after its audio port, in ms. */
  delayMs?: number;
  /** Starting volume. A seed, not a setpoint: live volume travels over Sendspin. */
  volume?: number;
  muted?: boolean;
  /**
   * Drive volume through this command on the device instead of attenuating in software. For a
   * speaker with real volume of its own; the client leaves its own mixer at unity.
   */
  volumeHook?: string;
  /**
   * Where the speaker applies volume.
   *
   * `auto` (the default) uses the sound card's own mixer when it has one and software gain when it
   * does not — a speaker with real volume of its own should use it, and attenuating in software
   * costs resolution the card would not have cost. The rest are for the exceptions: a card with a
   * mixer nobody wants driven (`software`), or one where the script is the real control (`hook`).
   */
  volumeControl?: 'auto' | 'software' | 'alsa' | 'hook';
  /** ALSA mixer element to drive. Absent means the device picks one. */
  mixerElement?: string;
  /**
   * Whether volume percentages are spread perceptually across the mixer's range.
   *
   * Absent means the device works it out by reading the mixer, which is right for both kinds of
   * hardware: a mixer that is linear in register steps needs the mapping, one already calibrated in
   * dB (a B&O BeoLab reports 0-90 spanning -90..0 dB) must be addressed directly, or the percentage
   * no longer corresponds to a known attenuation. Set it only for a card that reads wrongly.
   */
  mixerMapped?: boolean;
  /** Codec preference order. Absent means everything the client can decode. */
  codecs?: string[];
  /** Pin the advertised format. Only for hardware that genuinely accepts one rate. */
  sampleRate?: number;
  bitDepth?: number;
  channels?: number;
  bufferMs?: number;
  requiredLeadTimeMs?: number;
}

export interface SonnClientSourceConfig {
  /** Sendspin client id, which the line-in input's `source.clientId` must match. */
  clientId: string;
  name?: string;
  /** Capture device id as the client reported it. */
  input?: string;
  enabled?: boolean;
  /**
   * Capture format. Normally set on the line-in this source feeds, which is where someone is
   * thinking about the input; these are the fallback for a source that feeds nothing yet.
   */
  codec?: string;
  sampleRate?: number;
  bitDepth?: number;
  channels?: number;
  frameMs?: number;
  /** Level below which the input counts as silent, in dBFS. */
  thresholdDb?: number;
  /** How long a level change must persist before it is reported. */
  holdMs?: number;
  /** Transport controls this input's hardware accepts. */
  controls?: string[];
  /**
   * Script on the device that turns a control into something the hardware understands — a
   * MasterLink telegram, a relay, an IR blast. Without it an input that has to be switched on
   * stays silent, because nothing produces audio until it is on.
   */
  controlHook?: string;
  /** Capture continuously instead of waiting to be asked. */
  alwaysOn?: boolean;
}

export interface SonnClientBeoremoteConfig {
  enabled?: boolean;
  /** Zone whose menu the remote shows and whose keys it drives. */
  zoneId?: number;
  /** How often the device re-reads the menu, in ms. */
  menuPollMs?: number;
  /** Player whose volume the remote's volume keys move. Absent means the device's first. */
  volumePlayer?: string;
  /** Volume points per key press, on the 0-100 scale. */
  volumeStep?: number;
}

export interface SonnClientComponentConfig {
  /**
   * Known name: `sonn-beoremote` for our build of B&O's patched BlueZ, or `sonn-client` for the
   * client's own build — a device updates itself through the same mechanism it installs anything
   * else with.
   */
  name: string;
  version?: string;
  /** Where the device fetches it. One per architecture, keyed by the client's target triple. */
  urls?: Record<string, string>;
  /** Hex sha256 per architecture. Required: this installs a daemon that owns the Bluetooth adapter. */
  sha256?: Record<string, string>;
}

export interface RawAudioConfig {
  raw: unknown;
  rawString: string | null;
  crc32: string | null;
}
