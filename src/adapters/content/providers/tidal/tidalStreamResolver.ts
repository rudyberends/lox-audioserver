import { createLogger } from '@/shared/logging/logger';
import type { PlaybackSource } from '@/application/playback/audioManager';
import type { TidalStreamService } from '@/adapters/content/providers/tidal/tidalStreamService';

export class TidalStreamResolver {
  private readonly log = createLogger('Audio', 'TidalStream');

  constructor(private readonly streamService: TidalStreamService) {}

  public configure(): void {
    try {
      this.streamService.configureFromConfig();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('tidal stream config failed', { message });
    }
  }

  public isTidalProvider(providerId: string): boolean {
    return this.streamService.isTidalProvider(providerId);
  }

  public async startStreamForAudiopath(
    zoneId: number,
    zoneName: string,
    audiopath: string,
  ): Promise<{ playbackSource: PlaybackSource | null; outputOnly?: boolean }> {
    return this.streamService.startStreamForAudiopath(zoneId, zoneName, audiopath);
  }
}
