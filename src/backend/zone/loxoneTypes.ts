/**
 * Strong typings for Loxone-compatible audio status and event payloads.
 *
 * Every definition mirrors the shapes used by the official Audio Server UI
 * (`assets/www/scripts/AppHub.js`). Keeping them centralised lets the
 * backend generate the exact payloads the Loxone client expects while still
 * working with type-safe enums in our own code.
 */

/**
 * Source category for the currently playing item. Matches the
 * `AudioEvent.audiotype` enum used by the client.
 */
export enum AudioType {
  File = 0,
  Radio = 1,
  Playlist = 2,
  LineIn = 3,
  AirPlay = 4,
  Spotify = 5,
  Bluetooth = 6,
  Soundsuit = 7,
}

/**
 * Special "audio events" triggered by the server (bells, alarms, etc.).
 */
export enum AudioEventType {
  Unknown = -1,
  None = 0,
  Bell = 1,
  Buzzer = 2,
  TTS = 3,
  ErrorTTS = 4,
  CustomFile = 5,
  CustomPlaylist = 6,
  UploadedFile = 7,
  Identify = 8,
  UpnpBell = 9,
  Alarm = 100,
  Fire = 101,
}

/** Playback repeat strategy applied to the queue. */
export enum RepeatMode {
  NoRepeat = 0,
  Queue = 1,
  Track = 3,
}

/** Kind of media object currently addressed (file, playlist, favourite, ...). */
export enum FileType {
  Unknown = 0,
  Folder = 1,
  File = 2,
  Playlist = 3,
  Favorite = 4,
  SpotifyConnect = 5,
  LineIn = 6,
  PlaylistBrowsable = 7,
  Search = 8,
  PlaylistEditable = 11,
  PlaylistFollowable = 12,
}

/** Icon to display for line-in sources within the client UI. */
export enum LineInIconType {
  LineIn = 0,
  CdPlayer = 1,
  Computer = 2,
  IMac = 3,
  IPod = 4,
  Mobile = 5,
  Radio = 6,
  Screen = 7,
  TurnTable = 8,
}

export type AudioPowerState =
  | 'rebooting'
  | 'updating'
  | 'starting'
  | 'on'
  | 'off'
  | 'offline';

export type AudioPlaybackMode = 'play' | 'resume' | 'stop' | 'pause';

/** Minimal descriptor for players/zones participating in a sync group. */
export interface SyncedPlayerEntry {
  playerid: number;
  name?: string;
}

/**
 * Snapshot of a single Loxone zone/player.
 *
 * Values are intentionally permissive (`| number`) where the real server was
 * observed to fall back to raw numbers instead of enum strings.
 */
export interface PlayerStatus {
  playerid: number;
  coverurl: string;
  station?: string;
  audiotype: AudioType | number;
  audiopath: string;
  mode: AudioPlaybackMode;
  plrepeat: RepeatMode | number;
  plshuffle: boolean;
  duration: number;
  duration_ms?: number;
  time: number;
  power: AudioPowerState;
  volume: number;
  title: string;
  artist: string;
  album: string;
  qid?: string;
  qindex: number;
  sourceName?: string;
  type?: FileType | number;
  name?: string;
  clientState?: string;
  eventype?: AudioEventType | number;
  players?: SyncedPlayerEntry[];
  syncedzones?: SyncedPlayerEntry[];
  syncedcolor?: string;
  enableAirPlay?: boolean;
  enableSpotifyConnect?: boolean;
  alarmVolume?: number;
  bellVolume?: number;
  buzzerVolume?: number;
  ttsVolume?: number;
  defaultVolume?: number;
  maxVolume?: number;
  equalizerSettings?: string | number[];
  max_volume_locked?: boolean;
  default_volume_locked?: boolean;
  position_ms?: number;
  parent?: { id: string; name: string } | null;
  icontype?: LineInIconType;
  [key: string]: unknown;
}

/** Wire-format for the `/audio/{id}/status` HTTP response. */
export interface StatusResponse {
  command: `audio/${number}/status`;
  status_result: PlayerStatus[];
}

/**
 * Payload broadcast via the websocket `audio_event` push channel.
 * Values mirror the Loxone Audio Server client schema exactly.
 */
export interface AudioEvent {
  album: string;
  artist: string;
  audiopath: string;
  audiotype: AudioType | number;
  coverurl: string;
  duration: number;
  duration_ms?: number;
  eventype?: AudioEventType | number;
  mode: AudioPlaybackMode;
  name: string;
  parent?: { id: string; name: string } | null;
  playerid: number;
  plrepeat: RepeatMode | number;
  plshuffle: boolean;
  position_ms?: number;
  power: AudioPowerState;
  qid?: string;
  qindex: number;
  sourceName?: string;
  station?: string;
  time: number;
  title: string;
  type: FileType | number;
  icontype?: LineInIconType;
  volume: number;
}
