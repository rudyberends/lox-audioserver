import { createLogger } from '@/core/logging/logger';
import type { ZoneConfig } from '@/domain/config/types';
import type { PlaybackSource } from '@/modules/audio/engine/audioSession';
import type { PlaybackMetadata } from '@/modules/audio';
import { musicAssistantStreamService } from '@/modules/content/providers/musicassistant/musicAssistantStreamService';

export type MusicAssistantInputHandlers = {
  startPlayback?: (zoneId: number, label: string, source: PlaybackSource, metadata?: PlaybackMetadata) => void;
  stopPlayback?: (zoneId: number) => void;
  updateVolume?: (zoneId: number, volume: number) => void;
  updateMetadata?: (zoneId: number, metadata: Partial<PlaybackMetadata>) => void;
  updateTiming?: (zoneId: number, elapsed: number, duration: number) => void;
};

/**
 * Thin input wrapper around MusicAssistantStreamService so zoneManager can treat
 * Music Assistant similar to other inputs (Spotify/AirPlay).
 *
 * StreamService still handles registerAll/on-demand based on bridge config.
 */
export class MusicAssistantInputService {
  private readonly log = createLogger('Audio', 'MAInput');

  public configure(handlers?: MusicAssistantInputHandlers): void {
    musicAssistantStreamService.setInputHandlers(handlers ?? null);
    musicAssistantStreamService.configureFromConfig();
  }

  public async syncZones(zones: ZoneConfig[]): Promise<void> {
    try {
      await musicAssistantStreamService.registerZones(zones);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('music assistant zone registration failed', { message });
    }
  }

  public getPlaybackSource(zoneId: number): PlaybackSource | null {
    return musicAssistantStreamService.getPlaybackSource(zoneId);
  }

  public getProviderId(): string {
    return musicAssistantStreamService.getProviderId();
  }

  public async startStreamForAudiopath(
    zoneId: number,
    zoneName: string,
    audiopath: string,
    options?: {
      flow?: boolean;
      parentAudiopath?: string;
      startItem?: string;
      startIndex?: number;
      metadata?: PlaybackMetadata;
      zoneConfig?: ZoneConfig;
    },
  ): Promise<{ playbackSource: PlaybackSource | null; transportOnly?: boolean }> {
    return musicAssistantStreamService.startStreamForAudiopath(zoneId, zoneName, audiopath, options);
  }

  public async playerCommand(
    zoneId: number,
    command: string,
    args?: Record<string, unknown>,
  ): Promise<boolean> {
    return musicAssistantStreamService.playerCommand(zoneId, command, args);
  }

  public shutdown(): void {
    // Stream service cleans up refs on configure; nothing extra yet.
  }
}

export const musicAssistantInputService = new MusicAssistantInputService();
