/**
 * -----------------------------------------------------------------------------
 * Strong typings for Loxone-compatible audio status and event payloads.
 * -----------------------------------------------------------------------------
 * Every definition mirrors the shapes used by the official Audio Server UI
 * (assets/www/scripts/AppHub.js), but is implemented as enums so they can
 * be used as both types and runtime values.
 * -----------------------------------------------------------------------------
 */

/** Source category for the currently playing item. */
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

/** Special "audio events" triggered by the server (bells, alarms, etc.). */
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
  PlaylistFollowable = 13,
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

/** Playback mode. */
export enum AudioPlaybackMode {
  Play = 'play',
  Resume = 'resume',
  Stop = 'stop',
  Pause = 'pause',
}

/** Player power state. */
export enum AudioPowerState {
  Rebooting = 'rebooting',
  Updating = 'updating',
  Starting = 'starting',
  On = 'on',
  Off = 'off',
  Offline = 'offline',
}
