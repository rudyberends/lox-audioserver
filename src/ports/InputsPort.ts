import type { PassThrough } from 'node:stream';
import type { PlaybackSource } from '@/ports/EngineTypes';
import type { PlaybackMetadata, CoverArtPayload } from '@/ports/types/playback';
import type { ZoneConfig, GlobalSpotifyConfig } from '@/domain/config/types';
import type { ZonePlayer } from '@/ports/types/zonePlayer';

export type InputStreamOptions = {
  flow?: boolean;
  parentAudiopath?: string;
  startItem?: string;
  startIndex?: number;
  metadata?: PlaybackMetadata;
  zoneConfig?: ZoneConfig;
};

export type InputStreamResult = {
  playbackSource: PlaybackSource | null;
  outputOnly?: boolean;
};

export type AirplayRemoteCommand =
  | 'Play'
  | 'Pause'
  | 'PlayPause'
  | 'Stop'
  | 'Next'
  | 'Previous'
  | 'ToggleMute';

export type LineInControlCommand =
  | 'play'
  | 'pause'
  | 'next'
  | 'previous'
  | 'activate'
  | 'deactivate';

/**
 * What an input tells a zone about playback.
 *
 * Nothing here is protocol-specific: AirPlay, the DLNA renderer input, Bluetooth and Spotify all
 * say the same things about a session they have taken over. The controllers below are this plus
 * whatever their own protocol can additionally report.
 */
export type InputPlaybackController = {
  startPlayback(
    zoneId: number,
    label: string,
    source: PlaybackSource,
    metadata?: PlaybackMetadata,
  ): void;
  updateMetadata(zoneId: number, metadata: Partial<PlaybackMetadata>): void;
  updateCover(zoneId: number, cover?: CoverArtPayload): string | void;
  updateVolume(zoneId: number, volume: number): void;
  updateTiming(zoneId: number, elapsed: number, duration: number): void;
  pausePlayback(zoneId: number): void;
  resumePlayback(zoneId: number): void;
  stopPlayback(zoneId: number): void;
};

export type AirplayController = InputPlaybackController;

/** A transport button, pressed somewhere other than on the zone itself. */
export type SpotifyTransportCommand = 'pause' | 'resume' | 'next' | 'previous';

/**
 * One track of a queue this server did not build.
 *
 * Deliberately the plain facts about a track rather than a `QueueItem`: turning these into the
 * queue's own shape is the application's business, and an input adapter has no way to know what
 * that shape wants.
 */
export type SpotifyQueueTrack = {
  uri: string;
  /** The queue's own handle on this entry, which a track appearing twice does not share. */
  uid?: string;
  title?: string;
  artist?: string;
  album?: string;
  coverUrl?: string;
  durationSec?: number;
};

export type SpotifyConnectController = InputPlaybackController & {
  /**
   * A transport button pressed on the Spotify app, for a zone this server is driving.
   *
   * The app shows whatever the room is playing and offers its own buttons for it, so those are
   * often the ones nearest to hand. They mean exactly what the zone's own buttons mean and are
   * routed the same way — this is not the app taking the zone over.
   */
  transport(zoneId: number, command: SpotifyTransportCommand): void;
  /**
   * The queue as the Spotify app has it, for a zone the app is driving.
   *
   * Only while the app owns the zone: it is a mirror of someone else's list, and applying it to a
   * queue this server built would replace what the listener chose here.
   */
  updateQueue(zoneId: number, tracks: SpotifyQueueTrack[], currentIndex: number): void;
};

export type MusicAssistantInputHandlers = {
  startPlayback?: (zoneId: number, label: string, source: PlaybackSource, metadata?: PlaybackMetadata) => void;
  stopPlayback?: (zoneId: number) => void;
  updateVolume?: (zoneId: number, volume: number) => void;
  updateMetadata?: (zoneId: number, metadata: Partial<PlaybackMetadata>) => void;
  updateTiming?: (zoneId: number, elapsed: number, duration: number) => void;
};

export type MusicAssistantSwitchAwayHandlers = {
  onSwitchAway?: (zoneId: number) => void;
};

export interface InputsPort {
  configureAirplay(controller: AirplayController): void;
  setAirplayPlayerResolver(resolver: (zoneId: number) => ZonePlayer | null): void;
  syncAirplayZones(zones: ZoneConfig[]): void;
  renameAirplayZone(zoneId: number, name: string): Promise<void>;
  shutdownAirplay(): Promise<void>;
  configureDlna(controller: AirplayController): void;
  syncDlnaZones(zones: ZoneConfig[]): void;
  shutdownDlna(): void;
  configureBluetooth(controller: AirplayController): void;
  syncBluetoothZones(zones: ZoneConfig[]): void;
  shutdownBluetooth(): void;
  configureSpotify(controller: SpotifyConnectController): void;
  syncSpotifyZones(zones: ZoneConfig[], spotifyConfig?: GlobalSpotifyConfig | null): void;
  renameSpotifyZone(zoneId: number, name: string): Promise<void>;
  shutdownSpotify(): Promise<void>;
  configureMusicAssistant(
    handlers?: MusicAssistantInputHandlers,
    switchAwayHandlers?: MusicAssistantSwitchAwayHandlers,
  ): void;
  syncMusicAssistantZones(zones: ZoneConfig[]): Promise<void>;
  shutdownMusicAssistant(): void;
  getMusicAssistantProviderId(): string;
  startStreamForAudiopath(
    zoneId: number,
    zoneName: string,
    audiopath: string,
    options?: InputStreamOptions,
  ): Promise<InputStreamResult>;
  getPlaybackSourceForUri(
    zoneId: number,
    uri: string,
    seekPositionMs?: number,
    accountId?: string,
  ): Promise<PlaybackSource | null>;
  /** Warm the next track's playback source ahead of time (gapless prefetch). Best-effort. */
  prefetchPlaybackSourceForUri(zoneId: number, uri: string, accountId?: string): Promise<void>;
  getPlaybackSource(zoneId: number): PlaybackSource | null;
  markSessionActive(zoneId: number, metadata?: PlaybackMetadata | null): void;
  stopAirplaySession(zoneId: number, reason?: string): void;
  stopSpotifySession(zoneId: number, reason?: string): void;
  switchAway(zoneId: number): Promise<void>;
  remoteControl(zoneId: number, command: AirplayRemoteCommand): void;
  remoteVolume(zoneId: number, volumePercent: number): void;
  playerCommand(zoneId: number, command: string, args?: Record<string, unknown>): Promise<boolean>;
  requestLineInStop(inputId: string): void;
  requestLineInControl(inputId: string, command: LineInControlCommand): void;
  startCrossfadeStream(
    zoneId: number,
    uri: string,
  ): Promise<{ stream: PassThrough; sampleRate: number; channels: number; stop: () => void } | null>;
  stopCrossfadeStream(zoneId: number): void;
  /** After a successful crossfade the stream is owned by the audio session; clear the ref without stopping.
   *  Pass the new track's metadata so the input service can suppress stale Connect-host events. */
  releaseCrossfadeStream(zoneId: number, metadata?: PlaybackMetadata): void;
}
