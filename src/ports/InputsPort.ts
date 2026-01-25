import type { PlaybackSource } from '@/ports/EngineTypes';
import type { PlaybackMetadata, CoverArtPayload } from '@/application/playback/audioManager';
import type { ZoneConfig, GlobalAirplayConfig, GlobalSpotifyConfig } from '@/domain/config/types';
import type { ZonePlayer } from '@/application/playback/zonePlayer';

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

export type AirplayController = {
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

export type SpotifyConnectController = {
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
  syncAirplayZones(zones: ZoneConfig[], airplayConfig?: GlobalAirplayConfig | null): void;
  renameAirplayZone(zoneId: number, name: string): Promise<void>;
  shutdownAirplay(): Promise<void>;
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
}
