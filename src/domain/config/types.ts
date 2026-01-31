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
}

export interface AudioserverConfig {
  ip: string;
  name: string;
  uuid: string;
  macId: string;
  paired: boolean;
  extensions: AudioserverExtensionConfig[];
  /** Optional SlimProto control port (default 3483). */
  slimprotoPort?: number;
  /** Optional LMS-compatible telnet CLI port (default 9090). */
  slimprotoCliPort?: number;
  /** Optional LMS-compatible JSON-RPC port (default 9000). */
  slimprotoJsonPort?: number;
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
}

export interface RadioContentConfig {
  tuneInUsername?: string | null;
}

export interface SpotifyContentConfig {
  clientId?: string;
  accounts: SpotifyAccountConfig[];
  bridges: SpotifyBridgeConfig[];
}

export interface LibraryContentConfig {
  enabled?: boolean;
  autoScan?: boolean;
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
  volumes: ZoneVolumesConfig;
  inputs?: ZoneInputConfig;
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
