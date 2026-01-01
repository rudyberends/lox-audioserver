import { createLogger } from '@/core/logging/logger';
import type { PlaybackSource } from '@/modules/audio/engine/audioSession';
import { tidalStreamService } from '@/modules/content/providers/tidal/tidalStreamService';

export class TidalInputService {
  private readonly log = createLogger('Audio', 'TidalInput');

  public configure(): void {
    try {
      tidalStreamService.configureFromConfig();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('tidal input config failed', { message });
    }
  }

  public isTidalProvider(providerId: string): boolean {
    return tidalStreamService.isTidalProvider(providerId);
  }

  public async startStreamForAudiopath(
    zoneId: number,
    zoneName: string,
    audiopath: string,
  ): Promise<{ playbackSource: PlaybackSource | null; transportOnly?: boolean }> {
    return tidalStreamService.startStreamForAudiopath(zoneId, zoneName, audiopath);
  }
}

export const tidalInputService = new TidalInputService();
