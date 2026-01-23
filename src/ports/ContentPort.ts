import type { ContentFolder, ContentFolderItem, ContentItemMetadata } from '@/ports/ContentTypes';
import type { QueueItem } from '@/ports/types/queueTypes';
import type { PlaybackSourceResolveArgs, StreamResolution } from '@/ports/types/StreamResolution';

export type BuildQueueOptions = {
  maxItems?: number;
};

export interface ContentPort {
  getDefaultSpotifyAccountId(): string | null;
  resolveMetadata(audiopath: string): Promise<ContentItemMetadata | null>;
  resolvePlaybackSource(args: PlaybackSourceResolveArgs): Promise<StreamResolution>;
  configureAppleMusic(): void;
  configureDeezer(): void;
  configureTidal(): void;
  isAppleMusicProvider(providerId: string): boolean;
  isDeezerProvider(providerId: string): boolean;
  isTidalProvider(providerId: string): boolean;
  getMediaFolder(folderId: string, offset: number, limit: number): Promise<ContentFolder | null>;
  getServiceTrack(
    service: string,
    user: string,
    trackId: string,
  ): Promise<ContentFolderItem | null>;
  getServiceFolder(
    service: string,
    user: string,
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null>;
  buildQueueForUri(
    uri: string,
    zoneName: string,
    station?: string,
    rawAudiopath?: string,
    options?: BuildQueueOptions,
  ): Promise<QueueItem[]>;
}
