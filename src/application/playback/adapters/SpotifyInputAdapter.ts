import type { PlaybackMetadata, PlaybackSource, CoverArtPayload } from '@/application/playback/audioManager';
import type { InputAdapter } from '@/application/playback/inputAdapter';
import type { SpotifyConnectController } from '@/ports/InputsPort';

/**
 * Thin facade to drive a ZonePlayer/queue first, falling back to the existing controller for legacy flows.
 */
export class SpotifyInputAdapter {
  constructor(
    private readonly adapter: InputAdapter,
    private readonly controller: SpotifyConnectController,
    private readonly zoneId: number,
  ) {}

  public start(label: string, source: PlaybackSource, metadata?: PlaybackMetadata): void {
    this.adapter.playInput(label, source, metadata);
  }

  public stop(): void {
    this.adapter.stop();
  }

  public pause(): void {
    this.adapter.pause();
  }

  public resume(): void {
    this.adapter.resume();
  }

  public updateMetadata(metadata: Partial<PlaybackMetadata>): void {
    this.adapter.updateMetadata(metadata as PlaybackMetadata);
  }

  public updateTiming(elapsed: number, duration: number): void {
    this.adapter.updateTiming(elapsed, duration);
  }

  public updateCover(cover?: CoverArtPayload): string | void {
    const path = this.adapter.updateCover(cover);
    return path ?? this.controller.updateCover(this.zoneId, cover);
  }

  public updateVolume(volume: number): void {
    this.adapter.updateVolume(volume);
  }
}
