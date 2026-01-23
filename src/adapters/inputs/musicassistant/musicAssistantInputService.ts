import { createLogger } from '@/shared/logging/logger';
import type { ZoneConfig } from '@/domain/config/types';
import type { PlaybackSource } from '@/ports/EngineTypes';
import type { PlaybackMetadata } from '@/application/playback/audioManager';
import type { MusicAssistantInputHandlers, MusicAssistantSwitchAwayHandlers } from '@/ports/InputsPort';
import type { MusicAssistantStreamService } from '@/adapters/inputs/musicassistant/musicAssistantStreamService';

/**
 * Thin input wrapper around MusicAssistantStreamService so zoneManager can treat
 * Music Assistant similar to other inputs (Spotify/AirPlay).
 *
 * StreamService still handles registerAll/on-demand based on bridge config.
 */
export class MusicAssistantInputService {
  private readonly log = createLogger('Audio', 'MAInput');
  private readonly streamService: MusicAssistantStreamService;

  constructor(streamService: MusicAssistantStreamService) {
    this.streamService = streamService;
  }

  public configure(handlers?: MusicAssistantInputHandlers, switchAwayHandlers?: MusicAssistantSwitchAwayHandlers): void {
    this.streamService.setInputHandlers(handlers ?? null);
    this.streamService.setSwitchAwayHandlers(switchAwayHandlers ?? {});
    this.streamService.configureFromConfig();
  }

  public async syncZones(zones: ZoneConfig[]): Promise<void> {
    try {
      await this.streamService.registerZones(zones);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('music assistant zone registration failed', { message });
    }
  }

  public getPlaybackSource(zoneId: number): PlaybackSource | null {
    return this.streamService.getPlaybackSource(zoneId);
  }

  public getProviderId(): string {
    return this.streamService.getProviderId();
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
  ): Promise<{ playbackSource: PlaybackSource | null; outputOnly?: boolean }> {
    return this.streamService.startStreamForAudiopath(zoneId, zoneName, audiopath, options);
  }

  public async playerCommand(
    zoneId: number,
    command: string,
    args?: Record<string, unknown>,
  ): Promise<boolean> {
    return this.streamService.playerCommand(zoneId, command, args);
  }

  public shutdown(): void {
    // Stream service cleans up refs on configure; nothing extra yet.
  }

  public async switchAway(zoneId: number): Promise<void> {
    await this.streamService.switchAway(zoneId);
  }
}
