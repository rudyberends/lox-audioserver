export interface AudioServerConfig {
  system: SystemConfig;
  content: ContentConfig;
  zones: ZoneConfig[];
  rawAudioConfig: RawAudioConfig;
  inputs?: InputConfig;
  groups?: GroupConfig;
  updatedAt?: string;
}

export interface SystemConfig {
  miniserver: MiniserverConfig;
  audioserver: AudioserverConfig;
  logging: LoggingConfig;
  adminHttp: AdminHttpConfig;
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
  library?: LibraryContentConfig | null;
  tts?: TtsContentConfig;
  appleMusic?: AppleMusicContentConfig;
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
}

export interface SpotifyContentConfig {
  clientId?: string;
  accounts: SpotifyAccountConfig[];
  bridges: SpotifyBridgeConfig[];
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

export interface SpotifyBridgeConfig {
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
  /** URL to call when zone stops/pauses. */
  offUrl?: string;
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
}

export interface InputConfig {
  airplay?: GlobalAirplayConfig | null;
  spotify?: GlobalSpotifyConfig | null;
  bluetooth?: GlobalBluetoothConfig | null;
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

export interface GlobalAirplayConfig {
  enabled: boolean;
}

export interface GlobalSpotifyConfig {
  enabled: boolean;
  clientId?: string;
  accounts?: SpotifyAccountConfig[];
}

export interface GlobalBluetoothConfig {
  enabled: boolean;
}

export interface GlobalLineInConfig {
  inputs?: LineInInputConfig[] | null;
  bridges?: LineInBridgeConfig[] | null;
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
}

export interface LineInBridgeConfig {
  bridge_id: string;
  hostname?: string;
  version?: string;
  ip?: string;
  mac?: string;
  capture_devices?: Array<{
    id: string;
    name?: string;
    channels?: number;
    sample_rates?: number[];
  }>;
  last_seen?: string;
}

export interface RawAudioConfig {
  raw: unknown;
  rawString: string | null;
  crc32: string | null;
}
