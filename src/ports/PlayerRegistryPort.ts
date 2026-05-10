import type { CoverArtPayload, PlaybackMetadata } from '@/ports/types/playback';
import type { PlaybackSource } from '@/ports/EngineTypes';

export type ZonePlayerMode = 'stopped' | 'playing' | 'paused';

export interface ZonePlayerStateView {
  mode: ZonePlayerMode;
  time: number;
  duration: number;
  metadata?: PlaybackMetadata;
  sourceLabel?: string;
  playbackSource?: PlaybackSource | null;
}

/**
 * Subset of ZonePlayer used by input adapters. Exposed via PlayerRegistryPort
 * so adapters depend on the port abstraction instead of importing the
 * application's playerRegistry singleton or ZonePlayer class directly.
 */
export interface ZonePlayerHandle {
  resume(): void;
  pause(): void;
  stop(reason?: string): void;
  setVolume(volume: number): void;
  updateTiming(elapsedSec: number, durationSec?: number): void;
  updateMetadata(metadata: PlaybackMetadata): void;
  updateCover(cover: CoverArtPayload | undefined): void;
  getState(): ZonePlayerStateView;
}

export interface PlayerRegistryPort {
  getPlayer(zoneId: number): ZonePlayerHandle | null;
}
