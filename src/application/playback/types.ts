import type { PlaybackMetadata, PlaybackSession, PlaybackSource } from '@/application/playback/audioManager';

export type PlayerMode = 'stopped' | 'playing' | 'paused';

export interface PlayerState {
  mode: PlayerMode;
  time: number;
  duration: number;
  metadata?: PlaybackMetadata;
  sourceLabel?: string;
  playbackSource?: PlaybackSource | null;
}

export type PlayerEventMap = {
  started: (session: PlaybackSession) => void;
  paused: (session: PlaybackSession | null) => void;
  resumed: (session: PlaybackSession | null) => void;
  stopped: (session: PlaybackSession | null) => void;
  ended: (session: PlaybackSession | null) => void;
  metadata: (metadata: PlaybackMetadata) => void;
  position: (time: number, duration: number) => void;
  cover: (url: string | undefined) => void;
  volume: (level: number) => void;
  error: (reason: string) => void;
};

export type PlayerEvent = keyof PlayerEventMap;
