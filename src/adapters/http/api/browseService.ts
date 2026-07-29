/**
 * The public browse API's implementation.
 *
 * Sits on the same `buildBrowsableServices` the DLNA and Subsonic adapters use, so all three
 * see one catalogue and a service cannot appear in one and be missing from another.
 *
 * Its own file rather than a block inside `httpService`, because there is real logic here:
 * decoding ids, honouring declared capabilities, and reporting paging honestly.
 */
import {
  buildBrowsableServices,
  parseProviderAllowlist,
  type BrowsableService,
} from '@/adapters/content/browsableServices';
import type { ContentManager } from '@/adapters/content/contentManager';
import { toApiBrowseItem, toApiContainer } from '@/adapters/http/api/browseProjection';
import {
  decodeBrowseRef,
  encodeContainerRef,
  type BrowseRef,
} from '@/domain/media/browseRef';
import type {
  ApiBrowseItem,
  ApiBrowseResult,
  ApiItemKind,
  ApiSearchResult,
  ApiService,
} from '@/domain/zones/apiTypes';
import { detectServiceFromAudiopath } from '@/domain/zones/audiopath';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { ContentFolderItem } from '@/ports/ContentTypes';
import { createLogger } from '@/shared/logging/logger';

/**
 * Which search bucket names the content layer returns for which kind.
 *
 * `globalSearch` keys its result by free-string plural names, which is why the Subsonic
 * adapter demuxes them with `.replace(/s$/, '')` and drops the buckets it does not
 * recognise. Mapping explicitly here means an unmapped bucket is visibly unmapped rather
 * than silently lost.
 */
const BUCKETS: Partial<Record<ApiItemKind, readonly string[]>> = {
  track: ['tracks', 'track'],
  album: ['albums', 'album'],
  artist: ['artists', 'artist'],
  playlist: ['playlists', 'playlist'],
  radio: ['stations', 'station', 'radios', 'radio'],
  show: ['shows', 'show'],
  episode: ['episodes', 'episode'],
};

export class BrowseService {
  private readonly log = createLogger('Api', 'Browse');

  constructor(
    private readonly configPort: ConfigPort,
    private readonly contentManager: ContentManager,
  ) {}

  /** Rebuilt per call so a config change applies without a restart, as elsewhere. */
  private services(): BrowsableService[] {
    // No allowlist: the allowlists that exist are per-consumer (Subsonic and DLNA each have
    // their own), and this API exposes what the server has.
    return buildBrowsableServices(this.configPort, parseProviderAllowlist(undefined));
  }

  private serviceByKey(key: string): BrowsableService | undefined {
    return this.services().find((service) => service.key === key);
  }

  public async listServices(): Promise<ApiService[]> {
    return this.services().map((service) => ({
      id: service.key,
      name: service.title,
      rootId: encodeContainerRef({
        kind: 'category',
        service: service.key,
        folderId: service.rootFolderId,
      }),
      // Declared, not assumed. A consumer should render the tabs listed here and no others;
      // asserting a uniform set is what put an empty Albums tab in front of SoundCloud.
      searchableKinds: [...service.capabilities.search] as ApiItemKind[],
    }));
  }

  public async browse(id: string, start: number, limit: number): Promise<ApiBrowseResult | null> {
    const ref = decodeBrowseRef(id);
    if (!ref || ref.target !== 'container') {
      return null;
    }
    const service = this.serviceByKey(ref.service);
    if (!service) {
      return null;
    }
    const folder = await service.browse(this.contentManager, ref.folderId, start, limit);
    if (!folder) {
      return null;
    }
    return {
      container: toApiContainer(
        { id: ref.folderId, name: folder.name },
        ref.service,
        ref.kind,
      ),
      items: (folder.items ?? []).map((item) => toApiBrowseItem(item, ref.service)),
      start: folder.start ?? start,
      // Null when the provider could not say, rather than the guess it had to put in
      // `totalitems`. A consumer pages until it gets a short page instead of trusting a
      // number that two providers used to compute differently.
      total: folder.totalKnown === false ? null : folder.totalitems,
    };
  }

  /**
   * Describes one item by id.
   *
   * The content layer can only truly answer this for the local library; for everything else
   * `resolveFolder` infers a name from the folder's first child, and for a playlist it
   * cannot infer anything at all. So the name may come back empty — which is the honest
   * answer, and better than Music Assistant's, which returns the raw id as the name.
   */
  public async describeItem(id: string): Promise<ApiBrowseItem | null> {
    const ref = decodeBrowseRef(id);
    if (!ref) {
      return null;
    }
    if (ref.target === 'playable') {
      const resolved = await this.resolvePlayable(ref);
      return resolved ?? {
        // Still answer: the id is valid and playable even when no provider will describe it,
        // and a caller that stored it deserves better than a 404 it cannot act on.
        id,
        name: '',
        kind: ref.kind as ApiItemKind,
        browsable: false,
        playable: true,
        service: '',
      };
    }
    const service = this.serviceByKey(ref.service);
    if (!service) {
      return null;
    }
    const described = await this.contentManager.resolveFolder(ref.service, '', ref.folderId);
    return described
      ? toApiBrowseItem({ ...described, id: ref.folderId }, ref.service)
      : toApiContainer({ id: ref.folderId }, ref.service, ref.kind);
  }

  /** A playable item's own metadata, from the harvest cache the content layer keeps. */
  private async resolvePlayable(ref: Extract<BrowseRef, { target: 'playable' }>) {
    const metadata = await this.contentManager.resolveMetadata(ref.audiopath).catch(() => null);
    if (!metadata) {
      return null;
    }
    const item = {
      id: ref.audiopath,
      name: metadata.title ?? '',
      title: metadata.title ?? '',
      artist: metadata.artist ?? '',
      album: metadata.album ?? '',
      coverurl: metadata.coverurl ?? '',
      duration: metadata.duration,
      audiopath: ref.audiopath,
      type: 2,
      kind: ref.kind,
    } as unknown as ContentFolderItem;
    // The metadata carries no provider, so it comes from the audiopath — which is
    // service-native by the time it reaches this API.
    return toApiBrowseItem(item, detectServiceFromAudiopath(ref.audiopath) ?? '');
  }

  public async search(request: {
    query: string;
    kinds: string[];
    services: string[];
    limit: number;
  }): Promise<ApiSearchResult> {
    const wanted = request.kinds.length > 0 ? new Set(request.kinds) : null;
    const targets = this.services().filter((service) => {
      if (request.services.length > 0 && !request.services.includes(service.key)) {
        return false;
      }
      if (!service.searchSource) {
        return false;
      }
      // Skip a provider entirely for a kind it cannot search, rather than asking and
      // discarding: that is the whole point of declaring capabilities.
      const searchable = service.capabilities.search;
      return wanted ? searchable.some((kind) => wanted.has(kind)) : searchable.length > 0;
    });

    const items: Partial<Record<ApiItemKind, ApiBrowseItem[]>> = {};
    const answered: ApiSearchResult['services'] = [];

    // Sequential rather than parallel: several providers share an upstream rate limit, and a
    // search fanning out across five accounts at once is how you get throttled.
    for (const service of targets) {
      const kinds = service.capabilities.search.filter((kind) => !wanted || wanted.has(kind));
      if (kinds.length === 0) {
        continue;
      }
      try {
        const filters = kinds.map((kind) => `${kind}#${request.limit}`).join(',');
        const { result } = await this.contentManager.globalSearch(
          `${service.searchSource}:${filters}`,
          request.query,
        );
        for (const kind of kinds) {
          const bucket = this.pickBucket(result, kind);
          if (bucket.length === 0) {
            continue;
          }
          const apiKind = kind as ApiItemKind;
          items[apiKind] = [
            ...(items[apiKind] ?? []),
            ...bucket.map((item) => toApiBrowseItem(item, service.key)),
          ];
        }
        answered.push({ service: service.key });
      } catch (error) {
        // One provider failing must not lose the others' results, but the caller has to be
        // told the answer is partial — otherwise an outage looks like "no matches".
        this.log.warn('search failed for one service', {
          service: service.key,
          message: error instanceof Error ? error.message : String(error),
        });
        answered.push({ service: service.key, failed: true });
      }
    }

    return { query: request.query, items, services: answered };
  }

  private pickBucket(
    result: Record<string, ContentFolderItem[]>,
    kind: string,
  ): ContentFolderItem[] {
    for (const name of BUCKETS[kind as ApiItemKind] ?? [kind]) {
      const bucket = result[name];
      if (Array.isArray(bucket) && bucket.length > 0) {
        return bucket;
      }
    }
    return [];
  }
}
