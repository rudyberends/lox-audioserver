import type { OutputProfile, PlaybackSource } from '@/ports/EngineTypes';
import type { AudioOutputSettings } from '@/ports/types/audioFormat';

export interface PlaybackMetadata {
  title: string;
  artist: string;
  album: string;
  coverurl?: string;
  duration?: number;
  isRadio?: boolean;
  /** Optional absolute audiopath/uri (e.g. spotify:track:abc123) to preserve in queue. */
  audiopath?: string;
  /** Optional provider-specific track id (e.g. spotify track id). */
  trackId?: string;
  /** Optional playback context (e.g. spotify album/playlist URI). */
  station?: string;
  /** Optional index into the station/context (e.g. playlist position). */
  stationIndex?: number;
  /** Optional full queue of URIs for output/controller to use (e.g. Spotify Connect). */
  queue?: string[];
  /** Optional index within the provided queue. */
  queueIndex?: number;
}

export interface AudioStreamHandle {
  id: string;
  url: string;
  coverUrl: string;
  createdAt: number;
}

export interface CoverArtPayload {
  data: Buffer;
  mime: string;
}

export interface PlaybackSession {
  zoneId: number;
  source: string;
  metadata?: PlaybackMetadata;
  stream: AudioStreamHandle;
  pcmStream?: AudioStreamHandle;
  state: 'playing' | 'paused' | 'stopped';
  elapsed: number;
  duration: number;
  startedAt: number;
  updatedAt: number;
  playbackSource: PlaybackSource | null;
  cover?: CoverArtPayload;
  profiles?: OutputProfile[];
  outputSettings?: Pick<AudioOutputSettings, 'sampleRate' | 'channels' | 'pcmBitDepth'>;
  playRequestAt?: number;
  playRequestUri?: string;
  playRequestType?: string;
  playbackStartedAt?: number;
  firstAudioReadyAt?: number;
}
