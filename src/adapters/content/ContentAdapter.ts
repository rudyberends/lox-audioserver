import type { ContentManager } from '@/adapters/content/contentManager';
import type { StreamProvider } from '@/adapters/content/StreamProvider';
import type { ContentPort, BuildQueueOptions } from '@/ports/ContentPort';
import type { ContentFolder, ContentFolderItem, ContentItemMetadata } from '@/ports/ContentTypes';
import type { PlaybackSourceResolveArgs, StreamResolution } from '@/ports/types/StreamResolution';
import { decodeAudiopath, detectServiceFromAudiopath } from '@/domain/zones/audiopath';
import type { QueueItem } from '@/ports/types/queueTypes';

/**
 * Stream URLs that are the same whichever zone asked for them.
 *
 * Both YouTube providers resolve through yt-dlp, whose answer depends only on the video —
 * so all zones share one cache entry instead of each paying for its own resolve.
 */
const ZONE_INDEPENDENT_PROVIDERS = new Set(['youtube', 'ytmusic']);

export class ContentAdapter implements ContentPort {
  private readonly resolveCache = new Map<string, { expiresAt: number; result: StreamResolution }>();
  private readonly resolveInflight = new Map<string, Promise<StreamResolution>>();
  private readonly resolveCacheTtlMs = 60_000;

  /**
   * The stream providers, in the order an audiopath is offered to them.
   *
   * Order is only about which service claims an ambiguous path first; it matches the order
   * the branch-per-service cascade used to test them in, so nothing changes hands.
   */
  constructor(
    private readonly contentManager: ContentManager,
    private readonly streamProviders: readonly StreamProvider[],
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

  /** Re-read every stream provider's configuration after a config change. */
  public configureProviders(): void {
    for (const provider of this.streamProviders) {
      provider.configure();
    }
  }

  /**
   * Which service owns this audiopath, or null when none of them does.
   *
   * One question with one answer, where the port used to carry an `isXProvider()` per service
   * and each caller its own chain of them. A registered prefix decides it; the service name
   * appearing in the path is the fallback for the shapes that predate service-native ids
   * (stored favourites, Loxone recents), which is what the per-service helpers did too.
   *
   * The loops are nested provider-outer, candidate-inner, and that order is the contract: it
   * asks all four questions about one service (raw prefix, raw text, decoded prefix, decoded
   * text) before moving to the next, exactly as the chain of separate helpers did. Testing all
   * services against the raw path first would hand a path to whichever service its *text*
   * happens to mention over the one its decoded prefix actually names.
   */
  public providerForAudiopath(audiopath: string | null | undefined): string | null {
    if (!audiopath) {
      return null;
    }
    const raw = String(audiopath);
    const decoded = decodeAudiopath(raw) || raw;
    const candidates = raw === decoded ? [raw] : [raw, decoded];
    for (const provider of this.streamProviders) {
      for (const candidate of candidates) {
        const segment = candidate.split(':')[0] ?? '';
        if (segment && provider.isProvider(segment)) {
          return provider.provider;
        }
        if (candidate.toLowerCase().includes(provider.provider)) {
          return provider.provider;
        }
      }
    }
    return null;
  }

  public async resolvePlaybackSource(
    args: PlaybackSourceResolveArgs,
  ): Promise<StreamResolution> {
    const { audiopath } = args;
    const zoneId = args.requester?.kind === 'zone' ? args.requester.zoneId : null;
    const providerSegment = (audiopath.split(':')[0] ?? '').trim();
    const owner = this.streamProviders.find((provider) => provider.isProvider(providerSegment));
    const zoneIndependent = owner ? ZONE_INDEPENDENT_PROVIDERS.has(owner.provider) : false;
    // Per-zone cache partitioning is incidental (stream URLs are request-scoped),
    // so an ephemeral requester shares the un-partitioned key — same or better hit rate.
    const cacheKey = zoneIndependent || zoneId == null ? audiopath : `${zoneId}:${audiopath}`;
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
    // A registered prefix first, then the service the path merely names: a stored favourite
    // can carry `applemusic` inside a Loxone-shaped path with no prefix of its own.
    const owner =
      (providerSegment
        ? this.streamProviders.find((provider) => provider.isProvider(providerSegment))
        : undefined) ??
      this.streamProviders.find((provider) => provider.provider === detectedService);
    if (!owner) {
      return { playbackSource: null, provider: providerSegment || detectedService };
    }
    const result = await owner.startStreamForAudiopath(zoneId, audiopath, { suppressErrors });
    return {
      playbackSource: result.playbackSource,
      outputOnly: result.outputOnly,
      provider: owner.provider,
    };
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

  public resolveFolder(
    service: string,
    user: string,
    folderId: string,
  ): Promise<ContentFolderItem | null> {
    return this.contentManager.resolveFolder(service, user, folderId);
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
  streamProviders: readonly StreamProvider[],
): ContentAdapter {
  return new ContentAdapter(contentManager, streamProviders);
}
