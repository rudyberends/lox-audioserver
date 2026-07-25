import type { ContentManager } from '@/adapters/content/contentManager';
import type { AppleMusicStreamResolver } from '@/adapters/content/providers/applemusic/appleMusicStreamResolver';
import type { DeezerStreamResolver } from '@/adapters/content/providers/deezer/deezerStreamResolver';
import type { TidalStreamResolver } from '@/adapters/content/providers/tidal/tidalStreamResolver';
import type { YtMusicStreamResolver } from '@/adapters/content/providers/ytmusic/ytmusicStreamResolver';
import type { YoutubeStreamResolver } from '@/adapters/content/providers/youtube/youtubeStreamResolver';
import type { SoundCloudStreamResolver } from '@/adapters/content/providers/soundcloud/soundcloudStreamResolver';
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
  youtube: YoutubeStreamResolver;
  soundcloud: SoundCloudStreamResolver;
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

  public getBridgeRegistry() {
    return this.contentManager.getBridgeRegistry();
  }

  public resolveMetadata(audiopath: string): Promise<ContentItemMetadata | null> {
    return this.contentManager.resolveMetadata(audiopath);
  }

  public async resolvePlaybackSource(
    args: PlaybackSourceResolveArgs,
  ): Promise<StreamResolution> {
    const { audiopath } = args;
    const zoneId = args.requester?.kind === 'zone' ? args.requester.zoneId : null;
    // YouTube and ytmusic stream URLs are zone-independent; share cache across zones.
    const providerSegment = (audiopath.split(':')[0] ?? '').trim();
    const isYtLike = this.streamResolvers.youtube.isYoutubeProvider(providerSegment) ||
      this.streamResolvers.ytmusic.isYtMusicProvider(providerSegment);
    // Per-zone cache partitioning is incidental (stream URLs are request-scoped),
    // so an ephemeral requester shares the un-partitioned key — same or better hit rate.
    const cacheKey = isYtLike || zoneId == null ? audiopath : `${zoneId}:${audiopath}`;
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
    const { audiopath } = args;
    // Only a real zone routes stream-resolution errors; ephemeral requesters
    // (DLNA) have no zone to notify, so they pass undefined and stay silent.
    const zoneId = args.requester?.kind === 'zone' ? args.requester.zoneId : undefined;
    const suppressErrors = args.prefetch === true;
    const providerSegment = (audiopath.split(':')[0] ?? '').trim();
    const detectedService = detectServiceFromAudiopath(audiopath);
    const { appleMusic, deezer, tidal } = this.streamResolvers;
    const ytmusic = this.streamResolvers.ytmusic;
    const youtube = this.streamResolvers.youtube;
    const soundcloud = this.streamResolvers.soundcloud;
    if (providerSegment && appleMusic.isAppleMusicProvider(providerSegment)) {
      const result = await appleMusic.startStreamForAudiopath(
        zoneId,
        audiopath,
        { suppressErrors },
      );
      return { playbackSource: result.playbackSource, outputOnly: result.outputOnly, provider: 'applemusic' };
    }
    if (providerSegment && deezer.isDeezerProvider(providerSegment)) {
      const result = await deezer.startStreamForAudiopath(
        zoneId,
        audiopath,
        { suppressErrors },
      );
      return { playbackSource: result.playbackSource, outputOnly: result.outputOnly, provider: 'deezer' };
    }
    if (providerSegment && tidal.isTidalProvider(providerSegment)) {
      const result = await tidal.startStreamForAudiopath(
        zoneId,
        audiopath,
        { suppressErrors },
      );
      return { playbackSource: result.playbackSource, outputOnly: result.outputOnly, provider: 'tidal' };
    }
    if (providerSegment && ytmusic.isYtMusicProvider(providerSegment)) {
      const result = await ytmusic.startStreamForAudiopath(
        zoneId,
        audiopath,
        { suppressErrors },
      );
      return { playbackSource: result.playbackSource, outputOnly: result.outputOnly, provider: 'ytmusic' };
    }
    if (providerSegment && youtube.isYoutubeProvider(providerSegment)) {
      const result = await youtube.startStreamForAudiopath(
        zoneId,
        audiopath,
        { suppressErrors },
      );
      return { playbackSource: result.playbackSource, outputOnly: result.outputOnly, provider: 'youtube' };
    }
    if (providerSegment && soundcloud.isSoundcloudProvider(providerSegment)) {
      const result = await soundcloud.startStreamForAudiopath(
        zoneId,
        audiopath,
        { suppressErrors },
      );
      return { playbackSource: result.playbackSource, outputOnly: result.outputOnly, provider: 'soundcloud' };
    }
    if (detectedService === 'applemusic') {
      const result = await appleMusic.startStreamForAudiopath(
        zoneId,
        audiopath,
        { suppressErrors },
      );
      return { playbackSource: result.playbackSource, outputOnly: result.outputOnly, provider: 'applemusic' };
    }
    if (detectedService === 'deezer') {
      const result = await deezer.startStreamForAudiopath(
        zoneId,
        audiopath,
        { suppressErrors },
      );
      return { playbackSource: result.playbackSource, outputOnly: result.outputOnly, provider: 'deezer' };
    }
    if (detectedService === 'tidal') {
      const result = await tidal.startStreamForAudiopath(
        zoneId,
        audiopath,
        { suppressErrors },
      );
      return { playbackSource: result.playbackSource, outputOnly: result.outputOnly, provider: 'tidal' };
    }
    if (detectedService === 'ytmusic') {
      const result = await ytmusic.startStreamForAudiopath(
        zoneId,
        audiopath,
        { suppressErrors },
      );
      return { playbackSource: result.playbackSource, outputOnly: result.outputOnly, provider: 'ytmusic' };
    }
    if (detectedService === 'soundcloud') {
      const result = await soundcloud.startStreamForAudiopath(
        zoneId,
        audiopath,
        { suppressErrors },
      );
      return { playbackSource: result.playbackSource, outputOnly: result.outputOnly, provider: 'soundcloud' };
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

  public configureYoutube(): void {
    this.streamResolvers.youtube.configure();
  }

  public configureSoundcloud(): void {
    this.streamResolvers.soundcloud.configure();
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

  public isYoutubeProvider(providerId: string): boolean {
    return this.streamResolvers.youtube.isYoutubeProvider(providerId);
  }

  public isSoundcloudProvider(providerId: string): boolean {
    return this.streamResolvers.soundcloud.isSoundcloudProvider(providerId);
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
