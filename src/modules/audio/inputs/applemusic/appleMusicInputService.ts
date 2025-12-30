import { createLogger } from '@/core/logging/logger';
import type { PlaybackSource } from '@/modules/audio/engine/audioSession';
import { appleMusicStreamService } from '@/modules/content/providers/applemusic/appleMusicStreamService';

export class AppleMusicInputService {
  private readonly log = createLogger('Audio', 'AppleMusicInput');

  public configure(): void {
    try {
      appleMusicStreamService.configureFromConfig();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('apple music input config failed', { message });
    }
  }

  public isAppleMusicProvider(providerId: string): boolean {
    return appleMusicStreamService.isAppleMusicProvider(providerId);
  }

  public async startStreamForAudiopath(
    zoneId: number,
    zoneName: string,
    audiopath: string,
  ): Promise<{ playbackSource: PlaybackSource | null; transportOnly?: boolean }> {
    return appleMusicStreamService.startStreamForAudiopath(zoneId, zoneName, audiopath);
  }
}

export const appleMusicInputService = new AppleMusicInputService();
