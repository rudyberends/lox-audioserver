import type { ContentManager } from '@/adapters/content/contentManager';
import type { AppleMusicStreamResolver } from '@/adapters/content/providers/applemusic/appleMusicStreamResolver';
import type { DeezerStreamResolver } from '@/adapters/content/providers/deezer/deezerStreamResolver';
import type { TidalStreamResolver } from '@/adapters/content/providers/tidal/tidalStreamResolver';
import type { YtMusicStreamResolver } from '@/adapters/content/providers/ytmusic/ytmusicStreamResolver';
import type { ContentPort, BuildQueueOptions } from '@/ports/ContentPort';
import type { ContentFolder, ContentFolderItem, ContentItemMetadata } from '@/ports/ContentTypes';
import type { PlaybackSourceResolveArgs, StreamResolution } from '@/ports/types/StreamResolution';
import { detectServiceFromAudiopath } from '@/domain/loxone/audiopath';
import type { QueueItem } from '@/ports/types/queueTypes';

type ContentStreamResolvers = {
  appleMusic: AppleMusicStreamResolver;
  deezer: DeezerStreamResolver;
  tidal: TidalStreamResolver;
  ytmusic: YtMusicStreamResolver;
};

export class ContentAdapter implements ContentPort {
  private readonly resolveCache = new Map<string, { expiresAt: number; result: StreamResolution }>();
  private readonly resolveInflight = new Map<string, Promise<StreamResolution>>();
  private readonly resolveCacheTtlMs = 60_000;

  constructor(
    private readonly contentManager: ContentManager,
    private readonly streamResolvers: ContentStreamResolvers,
  ) {}

  public getDefaultSpotifyAccountId(): string | null {
    return this.contentManager.getDefaultSpotifyAccountId();
  }

  public resolveMetadata(audiopath: string): Promise<ContentItemMetadata | null> {
    return this.contentManager.resolveMetadata(audiopath);
  }

  public async resolvePlaybackSource(
    args: PlaybackSourceResolveArgs,
  ): Promise<StreamResolution> {
    const { audiopath, zoneId, zoneName } = args;
    const cacheKey = `${zoneId}:${audiopath}`;
    const now = Date.now();
    const cached = this.resolveCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.result;
    }
    if (cached) {
      this.resolveCache.delete(cacheKey);
    }
    const inflight = this.resolveInflight.get(cacheKey);
    if (inflight) {
      return inflight;
    }
    const promise = this.resolvePlaybackSourceInternal(args)
      .then((result) => {
        if (result.playbackSource || result.outputOnly) {
          this.resolveCache.set(cacheKey, {
            expiresAt: Date.now() + this.resolveCacheTtlMs,
            result,
          });
        }
        return result;
      })
      .finally(() => {
        this.resolveInflight.delete(cacheKey);
      });
    this.resolveInflight.set(cacheKey, promise);
    return promise;
  }

  private async resolvePlaybackSourceInternal(
    args: PlaybackSourceResolveArgs,
  ): Promise<StreamResolution> {
    const { audiopath, zoneId, zoneName } = args;
    const suppressErrors = args.prefetch === true;
    const providerSegment = (audiopath.split(':')[0] ?? '').trim();
    const detectedService = detectServiceFromAudiopath(audiopath);
    const { appleMusic, deezer, tidal } = this.streamResolvers;
    const ytmusic = this.streamResolvers.ytmusic;
    if (providerSegment && appleMusic.isAppleMusicProvider(providerSegment)) {
      const result = await appleMusic.startStreamForAudiopath(
        zoneId,
        zoneName,
        audiopath,
        { suppressErrors },
      );
      return { playbackSource: result.playbackSource, outputOnly: result.outputOnly, provider: 'applemusic' };
    }
    if (providerSegment && deezer.isDeezerProvider(providerSegment)) {
      const result = await deezer.startStreamForAudiopath(
        zoneId,
        zoneName,
        audiopath,
        { suppressErrors },
      );
      return { playbackSource: result.playbackSource, outputOnly: result.outputOnly, provider: 'deezer' };
    }
    if (providerSegment && tidal.isTidalProvider(providerSegment)) {
      const result = await tidal.startStreamForAudiopath(
        zoneId,
        zoneName,
        audiopath,
        { suppressErrors },
      );
      return { playbackSource: result.playbackSource, outputOnly: result.outputOnly, provider: 'tidal' };
    }
    if (providerSegment && ytmusic.isYtMusicProvider(providerSegment)) {
      const result = await ytmusic.startStreamForAudiopath(
        zoneId,
        zoneName,
        audiopath,
        { suppressErrors },
      );
      return { playbackSource: result.playbackSource, outputOnly: result.outputOnly, provider: 'ytmusic' };
    }
    if (detectedService === 'applemusic') {
      const result = await appleMusic.startStreamForAudiopath(
        zoneId,
        zoneName,
        audiopath,
        { suppressErrors },
      );
      return { playbackSource: result.playbackSource, outputOnly: result.outputOnly, provider: 'applemusic' };
    }
    if (detectedService === 'deezer') {
      const result = await deezer.startStreamForAudiopath(
        zoneId,
        zoneName,
        audiopath,
        { suppressErrors },
      );
      return { playbackSource: result.playbackSource, outputOnly: result.outputOnly, provider: 'deezer' };
    }
    if (detectedService === 'tidal') {
      const result = await tidal.startStreamForAudiopath(
        zoneId,
        zoneName,
        audiopath,
        { suppressErrors },
      );
      return { playbackSource: result.playbackSource, outputOnly: result.outputOnly, provider: 'tidal' };
    }
    if (detectedService === 'ytmusic') {
      const result = await ytmusic.startStreamForAudiopath(
        zoneId,
        zoneName,
        audiopath,
        { suppressErrors },
      );
      return { playbackSource: result.playbackSource, outputOnly: result.outputOnly, provider: 'ytmusic' };
    }
    return { playbackSource: null, provider: providerSegment || detectedService };
  }

  public configureAppleMusic(): void {
    this.streamResolvers.appleMusic.configure();
  }

  public configureDeezer(): void {
    this.streamResolvers.deezer.configure();
  }

  public configureTidal(): void {
    this.streamResolvers.tidal.configure();
  }

  public configureYtMusic(): void {
    this.streamResolvers.ytmusic.configure();
  }

  public isAppleMusicProvider(providerId: string): boolean {
    return this.streamResolvers.appleMusic.isAppleMusicProvider(providerId);
  }

  public isDeezerProvider(providerId: string): boolean {
    return this.streamResolvers.deezer.isDeezerProvider(providerId);
  }

  public isTidalProvider(providerId: string): boolean {
    return this.streamResolvers.tidal.isTidalProvider(providerId);
  }

  public isYtMusicProvider(providerId: string): boolean {
    return this.streamResolvers.ytmusic.isYtMusicProvider(providerId);
  }

  public getMediaFolder(
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    return this.contentManager.getMediaFolder(folderId, offset, limit);
  }

  public getServiceTrack(
    service: string,
    user: string,
    trackId: string,
  ): Promise<ContentFolderItem | null> {
    return this.contentManager.getServiceTrack(service, user, trackId);
  }

  public getServiceFolder(
    service: string,
    user: string,
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    return this.contentManager.getServiceFolder(service, user, folderId, offset, limit);
  }

  public async buildQueueForUri(
    _uri: string,
    _zoneName: string,
    _station?: string,
    _rawAudiopath?: string,
    _options?: BuildQueueOptions,
  ): Promise<QueueItem[]> {
    throw new Error('ContentAdapter.buildQueueForUri is not supported; use QueueController.buildQueueForUri');
  }
}

export function createContentAdapter(
  contentManager: ContentManager,
  streamResolvers: ContentStreamResolvers,
): ContentAdapter {
  return new ContentAdapter(contentManager, streamResolvers);
}
