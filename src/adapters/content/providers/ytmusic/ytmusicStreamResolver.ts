import { createLogger } from '@/shared/logging/logger';
import type { PlaybackSource } from '@/application/playback/audioManager';
import type { YtMusicStreamService } from '@/adapters/content/providers/ytmusic/ytmusicStreamService';

export class YtMusicStreamResolver {
  private readonly log = createLogger('Audio', 'YTMusicStream');

  constructor(private readonly streamService: YtMusicStreamService) {}

  public configure(): void {
    try {
      this.streamService.configureFromConfig();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('ytmusic stream config failed', { message });
    }
  }

  public isYtMusicProvider(providerId: string): boolean {
    return this.streamService.isYtMusicProvider(providerId);
  }

  public async startStreamForAudiopath(
    zoneId: number | undefined,
    audiopath: string,
    options?: { suppressErrors?: boolean },
  ): Promise<{ playbackSource: PlaybackSource | null; outputOnly?: boolean }> {
    return this.streamService.startStreamForAudiopath(zoneId, audiopath, options);
  }
}

