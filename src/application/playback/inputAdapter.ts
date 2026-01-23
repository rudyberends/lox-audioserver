import type { PlaybackMetadata, PlaybackSource, CoverArtPayload } from '@/application/playback/audioManager';
import type { ZonePlayer } from '@/application/playback/zonePlayer';
import type { QueueItem } from '@/application/zones/zoneManager';
import { normalizeSpotifyAudiopath, createQueueItem } from '@/application/zones/helpers/queueHelpers';
import type { LoxoneZoneState } from '@/domain/loxone/types';

export interface InputAdapterDeps {
  player: ZonePlayer;
  zoneName: string;
  sourceMac: string;
  replaceQueue: (items: QueueItem[], startIndex?: number) => QueueItem | null;
  applyPatch: (patch: Partial<LoxoneZoneState>) => void;
  getDefaultSpotifyAccountId: () => string | null;
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
          : label === 'linein'
            ? 3
            : 0;
    const defaultSpotifyUserId = this.deps.getDefaultSpotifyAccountId();
    const item = createQueueItem(
      normalizeSpotifyAudiopath(resolvedUri),
      this.deps.zoneName,
      metadataWithAudiopath,
      audioType,
      defaultSpotifyUserId,
    );
    const current = this.deps.replaceQueue([item], 0);
    if (current) {
      this.deps.applyPatch({
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
        ...(label === 'linein' ? { type: 6 } : {}),
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
    this.deps.applyPatch({
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
    this.deps.applyPatch({ mode: 'pause', clientState: 'on', power: 'on' });
  }

  public resume(): void {
    this.deps.player.resume();
    this.deps.applyPatch({ mode: 'play', clientState: 'on', power: 'on' });
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
