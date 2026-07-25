import { createLogger } from '@/shared/logging/logger';
import type { PlaybackSource } from '@/application/playback/audioManager';
import type { SoundCloudStreamService } from '@/adapters/content/providers/soundcloud/soundcloudStreamService';

export class SoundCloudStreamResolver {
  private readonly log = createLogger('Audio', 'SoundCloudStream');

  constructor(private readonly streamService: SoundCloudStreamService) {}

  public configure(): void {
    try {
      this.streamService.configureFromConfig();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('soundcloud stream config failed', { message });
    }
  }

  public isSoundcloudProvider(providerId: string): boolean {
    return this.streamService.isSoundcloudProvider(providerId);
  }

  public async startStreamForAudiopath(
    zoneId: number | undefined,
    audiopath: string,
    options?: { suppressErrors?: boolean },
  ): Promise<{ playbackSource: PlaybackSource | null; outputOnly?: boolean }> {
    return this.streamService.startStreamForAudiopath(zoneId, audiopath, options);
  }
}
