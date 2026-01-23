import type { PlaybackMetadata } from '@/application/playback/audioManager';
import type { PlaybackSource } from '@/ports/EngineTypes';

export type PlaybackSourceResolveArgs = {
  zoneId: number;
  zoneName: string;
  audiopath: string;
};

export type StreamResolution = {
  playbackSource?: PlaybackSource | null;
  outputOnly?: boolean;
  metadata?: Partial<PlaybackMetadata>;
  provider?: string;
  errorReason?: string;
};
