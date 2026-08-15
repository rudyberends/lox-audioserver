import type { ContentFolder, ContentFolderItem, ContentItemMetadata } from '@/ports/ContentTypes';
import type { QueueItem } from '@/ports/types/queueTypes';
import type { PlaybackSourceResolveArgs, StreamResolution } from '@/ports/types/StreamResolution';
import type { BridgeRegistry } from '@/domain/zones/bridgeIdentity';

export type BuildQueueOptions = {
  maxItems?: number;
};

export interface ContentPort {
  getDefaultSpotifyAccountId(): string | null;
  /** Bridge registry for service-native ⇄ Loxone audiopath translation. */
  getBridgeRegistry(): BridgeRegistry;
  resolveMetadata(audiopath: string): Promise<ContentItemMetadata | null>;
  resolvePlaybackSource(args: PlaybackSourceResolveArgs): Promise<StreamResolution>;
  /** Re-read every content service's configuration (accounts, tokens, cookies). */
  configureProviders(): void;
  /** Which service owns this audiopath — `applemusic`, `ytmusic`, … — or null. */
  providerForAudiopath(audiopath: string | null | undefined): string | null;
  getMediaFolder(folderId: string, offset: number, limit: number): Promise<ContentFolder | null>;
  /** Describe a container by id: a folder never names itself when browsed. */
  resolveFolder(service: string, user: string, folderId: string): Promise<ContentFolderItem | null>;
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
