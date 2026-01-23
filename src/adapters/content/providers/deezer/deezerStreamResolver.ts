import { createLogger } from '@/shared/logging/logger';
import type { PlaybackSource } from '@/application/playback/audioManager';
import type { DeezerStreamService } from '@/adapters/content/providers/deezer/deezerStreamService';

export class DeezerStreamResolver {
  private readonly log = createLogger('Audio', 'DeezerStream');

  constructor(private readonly streamService: DeezerStreamService) {}

  public configure(): void {
    try {
      this.streamService.configureFromConfig();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('deezer stream config failed', { message });
    }
  }

  public isDeezerProvider(providerId: string): boolean {
    return this.streamService.isDeezerProvider(providerId);
  }

  public async startStreamForAudiopath(
    zoneId: number,
    zoneName: string,
    audiopath: string,
  ): Promise<{ playbackSource: PlaybackSource | null; outputOnly?: boolean }> {
    return this.streamService.startStreamForAudiopath(zoneId, zoneName, audiopath);
  }
}
