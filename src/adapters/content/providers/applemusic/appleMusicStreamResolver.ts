import { createLogger } from '@/shared/logging/logger';
import type { PlaybackSource } from '@/application/playback/audioManager';
import type { AppleMusicStreamService } from '@/adapters/content/providers/applemusic/appleMusicStreamService';

export class AppleMusicStreamResolver {
  private readonly log = createLogger('Audio', 'AppleMusicStream');

  constructor(private readonly streamService: AppleMusicStreamService) {}

  public configure(): void {
    try {
      this.streamService.configureFromConfig();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('apple music stream config failed', { message });
    }
  }

  public isAppleMusicProvider(providerId: string): boolean {
    return this.streamService.isAppleMusicProvider(providerId);
  }

  public async startStreamForAudiopath(
    zoneId: number,
    zoneName: string,
    audiopath: string,
  ): Promise<{ playbackSource: PlaybackSource | null; outputOnly?: boolean }> {
    return this.streamService.startStreamForAudiopath(zoneId, zoneName, audiopath);
  }
}
