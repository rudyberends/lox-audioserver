import type { PlaybackMetadata, PlaybackSource, CoverArtPayload } from '@/modules/audio';
import type { ZonePlayer } from '@/modules/audio/player/zonePlayer';
import type { QueueItem } from '@/modules/zones/zoneManager';
import { normalizeSpotifyAudiopath, createQueueItem } from '@/modules/zones/helpers/queueHelpers';

export interface InputAdapterDeps {
  player: ZonePlayer;
  zoneName: string;
  sourceMac: string;
  replaceQueue: (items: QueueItem[], startIndex?: number) => QueueItem | null;
  patchState: (patch: Partial<Record<string, unknown>>) => void;
}

/**
  * Bridges input callbacks directly to a ZonePlayer while preserving queue/state expectations.
  */
export class InputAdapter {
  constructor(private readonly deps: InputAdapterDeps) {}

  public playInput(
    label: string,
    playbackSource: PlaybackSource,
    metadata?: PlaybackMetadata,
  ): void {
    const metadataWithAudiopath = metadata ? { ...metadata } : undefined;
    const resolvedUri =
      metadataWithAudiopath?.audiopath ??
      (metadataWithAudiopath?.trackId ? `spotify:track:${metadataWithAudiopath.trackId}` : null) ??
      `${label}://${this.deps.sourceMac}`;
    if (metadataWithAudiopath && !metadataWithAudiopath.audiopath) {
      metadataWithAudiopath.audiopath = resolvedUri;
    }
    const audioType =
      label === 'airplay'
        ? 4
        : label === 'spotify' || resolvedUri.startsWith('spotify:')
          ? 5
          : 0;
    const item = createQueueItem(
      normalizeSpotifyAudiopath(resolvedUri),
      this.deps.zoneName,
      metadataWithAudiopath,
      audioType,
    );
    const current = this.deps.replaceQueue([item], 0);
    if (current) {
      this.deps.patchState({
        title: current.title,
        artist: current.artist,
        album: current.album,
        coverurl: current.coverurl,
        audiopath: current.audiopath,
        station: current.station,
        qindex: 0,
        qid: current.unique_id,
        mode: 'play',
        clientState: 'on',
        power: 'on',
        audiotype: audioType,
        sourceName:
          audioType === 5
            ? 'musicassistant'
            : audioType === 4
              ? this.deps.zoneName
              : this.deps.sourceMac,
        queueAuthority: audioType === 4 ? 'airplay' : audioType === 5 ? 'musicassistant' : 'local',
      });
    }
    this.deps.player.playExternal(resolvedUri, playbackSource, metadataWithAudiopath);
  }

  public stop(): void {
    this.deps.player.stop('input_stop');
    this.deps.patchState({
      mode: 'stop',
      clientState: 'on',
      power: 'on',
      audiotype: 0,
      time: 0,
      duration: 0,
      sourceName: this.deps.sourceMac,
    });
  }

  public pause(): void {
    this.deps.player.pause();
    this.deps.patchState({ mode: 'pause', clientState: 'on', power: 'on' });
  }

  public resume(): void {
    this.deps.player.resume();
    this.deps.patchState({ mode: 'play', clientState: 'on', power: 'on' });
  }

  public updateMetadata(metadata: Partial<PlaybackMetadata>): void {
    if (metadata) {
      this.deps.player.updateMetadata(metadata as PlaybackMetadata);
    }
  }

  public updateCover(cover?: CoverArtPayload): string | undefined {
    return this.deps.player.updateCover(cover);
  }

  public updateVolume(volume: number): void {
    this.deps.player.setVolume(volume);
  }

  public updateTiming(elapsed: number, duration: number): void {
    this.deps.player.updateTiming(elapsed, duration);
  }
}
