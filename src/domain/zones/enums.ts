/**
 * -----------------------------------------------------------------------------
 * Categories the server uses to describe what a zone is playing.
 * -----------------------------------------------------------------------------
 * These are domain concepts — source kind, media kind, repeat strategy, power
 * state — used throughout the application layer, not just by one consumer.
 *
 * Their *numeric values* are Loxone's, mirroring the official Audio Server UI
 * (assets/www/scripts/AppHub.js) so the state can go onto that wire unchanged.
 * That is a wire-compatibility detail, not a reason to treat them as Loxone
 * types: reading `AudioType.Radio` is what makes the surrounding code legible,
 * and `1` is only how it happens to serialise. The public API projects these
 * onto readable strings (`ApiSourceKind`) so no integrator has to know the
 * numbers at all.
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
