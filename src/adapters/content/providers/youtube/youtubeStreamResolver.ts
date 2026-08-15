import type { StreamProvider } from '@/adapters/content/StreamProvider';
import { createLogger } from '@/shared/logging/logger';
import type { PlaybackSource } from '@/application/playback/audioManager';
import type { YoutubeStreamService } from '@/adapters/content/providers/youtube/youtubeStreamService';

export class YoutubeStreamResolver implements StreamProvider {
  public readonly provider = 'youtube';

  private readonly log = createLogger('Audio', 'YoutubeStream');

  constructor(private readonly streamService: YoutubeStreamService) {}

  public configure(): void {
    try {
      this.streamService.configureFromConfig();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('youtube stream config failed', { message });
    }
  }

  public isProvider(providerId: string): boolean {
    return this.streamService.isYoutubeProvider(providerId);
  }

  public async startStreamForAudiopath(
    zoneId: number | undefined,
    audiopath: string,
    options?: { suppressErrors?: boolean },
  ): Promise<{ playbackSource: PlaybackSource | null; outputOnly?: boolean }> {
    return this.streamService.startStreamForAudiopath(zoneId, audiopath, options);
  }
}
