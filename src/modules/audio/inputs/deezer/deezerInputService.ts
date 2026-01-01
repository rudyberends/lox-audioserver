import { createLogger } from '@/core/logging/logger';
import type { PlaybackSource } from '@/modules/audio/engine/audioSession';
import { deezerStreamService } from '@/modules/content/providers/deezer/deezerStreamService';

export class DeezerInputService {
  private readonly log = createLogger('Audio', 'DeezerInput');

  public configure(): void {
    try {
      deezerStreamService.configureFromConfig();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('deezer input config failed', { message });
    }
  }

  public isDeezerProvider(providerId: string): boolean {
    return deezerStreamService.isDeezerProvider(providerId);
  }

  public async startStreamForAudiopath(
    zoneId: number,
    zoneName: string,
    audiopath: string,
  ): Promise<{ playbackSource: PlaybackSource | null; transportOnly?: boolean }> {
    return deezerStreamService.startStreamForAudiopath(zoneId, zoneName, audiopath);
  }
}

export const deezerInputService = new DeezerInputService();
