import type { PlaybackMetadata } from '@/ports/types/playback';
import type { PlaybackSource } from '@/ports/EngineTypes';

export type PlaybackSourceResolveArgs = {
  zoneId: number;
  zoneName: string;
  audiopath: string;
  prefetch?: boolean;
};

export type StreamResolution = {
  playbackSource?: PlaybackSource | null;
  outputOnly?: boolean;
  metadata?: Partial<PlaybackMetadata>;
  provider?: string;
  errorReason?: string;
};
