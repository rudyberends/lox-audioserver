import { createLogger } from '@/shared/logging/logger';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { ContentFolder, ContentFolderItem, ContentItemMetadata, ContentItemKind } from '@/ports/ContentTypes';
import { resolveItemKind } from '@/adapters/content/contentItemKind';
import { audioOutputSettings, mp3BitrateToBps } from '@/ports/types/audioFormat';
import type { ContentProvider, BrowseResult, DidlContainer, DidlItem } from '@sonn-audio/node-upnp';
import { ROOT_OBJECT_ID, parseSearchCriteria } from '@sonn-audio/node-upnp';
import {
  decodeObjectId,
  encodeContainerId,
  encodeItemId,
  type MediaServerService,
} from '@/adapters/mediaserver/objectId';

/**
 * A top-level service the MediaServer surfaces as a child of the root container.
 *
 * `key` is the stable id used in the object id's service segment (a bridge id for
 * streaming services, or `library`/`radio`). `browse(folderId, offset, limit)`
 * maps the service to a ContentManager call; `rootFolderId` is the native id
 * handed in for the service's own top level.
 *
 * The catalogue is built from config (see MediaServer.buildServiceDefs), NOT a
 * static list, because streaming bridges are keyed by a per-instance bridge id —
 * `getServiceFolder(service, user, …)` only resolves the right provider when
 * `user` is that bridge id, not the generic provider name.
 */
export type ServiceDef = {
  key: string;
  service: MediaServerService;
  title: string;
  rootFolderId: string;
  /** Optional absolute icon URL shown as the service's root tile. */
  iconUrl?: string;
  /** `globalSearch` source for this service (`local`, `spotify@bridgeId`, …), or null when it can't search. */
  searchSource: string | null;
  browse: (
    cm: ContentManager,
    folderId: string,
    offset: number,
    limit: number,
  ) => Promise<ContentFolder | null>;
};

// protocolInfo for our MP3 stream. The DLNA.ORG_PN=MP3 profile name is
// load-bearing: strict sinks (B&O) validate the 4th field and refuse to adopt an
// item's DIDL as now-playing metadata when no recognized profile is present.
// OP=00 (no byte-range seek) stays consistent with our `Accept-Ranges: none`
// chunked stream. This must also match the ConnectionManager source protocolInfo.
export const AUDIO_DLNA_FEATURES =
  'DLNA.ORG_PN=MP3;DLNA.ORG_OP=00;DLNA.ORG_CI=0;' +
  'DLNA.ORG_FLAGS=8D500000000000000000000000000000';
export const AUDIO_PROTOCOL_INFO = `http-get:*:audio/mpeg:${AUDIO_DLNA_FEATURES}`;

/** How many described containers to remember for BrowseMetadata. */
const CONTAINER_META_MAX = 2000;

/** Loxone content type for a directly-playable file/track. Everything else browses. */
const CONTENT_TYPE_TRACK = 2;

/**
 * UPnP class per neutral item kind. Everything used to be announced as a plain
 * storage folder, so controllers could not render albums as albums, group by artist,
 * or offer play-all on a playlist — the distinction existed in the provider data and
 * was thrown away here.
 */
const CONTAINER_CLASS: Record<ContentItemKind, string> = {
  album: 'object.container.album.musicAlbum',
  artist: 'object.container.person.musicArtist',
  playlist: 'object.container.playlistContainer',
  show: 'object.container.album.musicAlbum',
  category: 'object.container.genre.musicGenre',
  folder: 'object.container.storageFolder',
  // Playable kinds never reach the container path; mapped for exhaustiveness.
  track: 'object.container.storageFolder',
  radio: 'object.container.storageFolder',
  episode: 'object.container.storageFolder',
};

// The engine transcodes MP3 at the configured output settings, so we advertise
// honest res descriptors. A strict renderer keys on size + audio attributes to
// accept the item as now-playing metadata.
const MP3_BITRATE_BPS = mp3BitrateToBps(audioOutputSettings.mp3Bitrate);
const MP3_SAMPLE_RATE = audioOutputSettings.sampleRate;
const MP3_CHANNELS = audioOutputSettings.channels;
// DLNA res@bitrate is BYTES/sec (not bits).
const MP3_BITRATE_BYTES = Math.round(MP3_BITRATE_BPS / 8);

/**
 * The MediaServer's content backend. Answers UPnP Browse over the existing content
 * layer by mapping ContentManager results onto the module's neutral DIDL shapes —
 * the module (`UpnpMediaServer`) owns all the SOAP/DIDL serialisation. Object ids
 * are opaque strings round-tripped through {@link ../objectId}: containers carry a
 * service key + folderId, items carry a base64url audiopath, so browse→play needs
 * no second lookup.
 */
export class MediaContentProvider implements ContentProvider {
  private readonly log = createLogger('MediaServer', 'CDS');

  constructor(
    private readonly contentManager: ContentManager,
    // The catalogue of top-level services, built from config by the MediaServer
    // (library + radio + one entry per configured streaming bridge). Called per
    // request so config changes take effect without a restart.
    private readonly serviceDefs: () => ServiceDef[],
    // Absolute origin (http://ip:port) the renderer can reach for res/cover URLs.
    private readonly baseUrl: () => string,
  ) {}

  /**
   * Containers we have already described, keyed by their object id.
   *
   * BrowseMetadata on a container has to answer with that container's own title,
   * art and class. Nothing in the content layer can look a folder up by id — a
   * provider only ever returns folders as *children* of a browse — so we keep what
   * we knew when we listed it. Controllers always browse the parent before opening
   * a child, so this is warm exactly when it is needed; {@link browseMetadata}
   * falls back to resolving the id as an audiopath, then to the service tile.
   */
  private readonly containerMeta = new Map<string, DidlContainer>();

  private rememberContainer(container: DidlContainer): DidlContainer {
    if (this.containerMeta.size >= CONTAINER_META_MAX) {
      const oldest = this.containerMeta.keys().next().value;
      if (oldest !== undefined) {
        this.containerMeta.delete(oldest);
      }
    }
    this.containerMeta.set(container.id, container);
    return container;
  }

  public async browse(objectId: string, startingIndex: number, requestedCount: number): Promise<BrowseResult> {
    const ref = decodeObjectId(objectId);
    if (!ref) {
      return { objects: [], total: 0 };
    }
    if (ref.kind === 'root') {
      const objects = this.serviceDefs().map((def) => this.serviceContainer(def));
      return { objects, total: objects.length };
    }
    if (ref.kind === 'item') {
      return { objects: [], total: 0 };
    }
    return this.browseContainer(ref.service, ref.folderId, startingIndex, requestedCount);
  }

  public async browseMetadata(objectId: string): Promise<DidlContainer | DidlItem | null> {
    const ref = decodeObjectId(objectId);
    if (!ref) {
      return null;
    }
    if (ref.kind === 'root') {
      return {
        id: ROOT_OBJECT_ID,
        parentId: '-1',
        title: 'Sonn Audio',
        upnpClass: 'object.container.storageFolder',
        childCount: this.serviceDefs().length,
      };
    }
    if (ref.kind === 'container') {
      const known = this.containerMeta.get(objectId);
      if (known) {
        return known;
      }
      // Not listed this session (deep link, or evicted). For services whose folder
      // ids are audiopaths — the streaming providers — the harvest cache can still
      // name it; the local library uses opaque ids and falls through.
      const resolved = await this.resolveContainerMetadata(ref.folderId);
      const def = this.findService(ref.service);
      if (resolved) {
        return {
          id: objectId,
          parentId: encodeContainerId(ref.service, 'root'),
          title: resolved.album || resolved.title || def?.title || ref.service,
          upnpClass: CONTAINER_CLASS.album,
          artist: resolved.artist || undefined,
          albumArtUri: resolved.coverurl || undefined,
        };
      }
      return {
        id: objectId,
        parentId: ROOT_OBJECT_ID,
        title: def?.title ?? ref.service,
        upnpClass: 'object.container.storageFolder',
      };
    }
    // Item metadata: reconstruct the full track DIDL from the harvested-metadata
    // cache (populated during the preceding browse), so a controller's pre-play
    // BrowseMetadata gets title/artist/album/cover to show as now-playing.
    let meta: ContentItemMetadata | null = null;
    try {
      meta = await this.contentManager.resolveMetadata(ref.audiopath);
    } catch (error) {
      this.log.debug('metadata resolve failed for BrowseMetadata', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const item: ContentFolderItem = {
      id: objectId,
      name: meta?.title || 'Track',
      title: meta?.title || 'Track',
      type: 2,
      audiopath: ref.audiopath,
      artist: meta?.artist,
      album: meta?.album,
      coverurl: meta?.coverurl,
      duration: meta?.duration,
    };
    return this.trackItem(item, '-1');
  }

  /**
   * UPnP Search over the content layer. Extracts the free-text term from the
   * SearchCriteria, then runs the app's `globalSearch` against each searchable
   * service — all of them when searching the root (`ContainerID=0`), or just the
   * one when a specific service container is given — and maps the hits onto DIDL.
   *
   * Tracks become playable items (same `/dlna/track/<id>` res as browse); albums/
   * artists/playlists become browsable containers that route back into the service.
   */
  public async search(
    containerId: string,
    searchCriteria: string,
    startingIndex: number,
    requestedCount: number,
  ): Promise<BrowseResult> {
    const parsed = parseSearchCriteria(searchCriteria);
    // No usable free-text term (empty criteria, or the `*` wildcard): we do NOT
    // dump the whole catalogue as a "search" — return nothing.
    if (parsed.terms.length === 0) {
      return { objects: [], total: 0 };
    }
    const query = parsed.terms.join(' ');

    // Which services to search: a specific service container restricts to that
    // service; the root (or anything else) searches every searchable service.
    const searchable = this.serviceDefs().filter((def) => def.searchSource);
    const ref = decodeObjectId(containerId);
    const targets =
      ref?.kind === 'container'
        ? searchable.filter((def) => def.key === ref.service)
        : searchable;
    if (targets.length === 0) {
      return { objects: [], total: 0 };
    }

    const limit = requestedCount > 0 ? requestedCount : 200;
    const offset = startingIndex > 0 ? startingIndex : 0;
    const perService = Math.max(1, Math.min(limit, 50));

    const settled = await Promise.allSettled(
      targets.map((def) => this.searchService(def, query, perService)),
    );

    const objects: Array<DidlContainer | DidlItem> = [];
    settled.forEach((outcome, i) => {
      const def = targets[i]!;
      if (outcome.status !== 'fulfilled') {
        this.log.debug('search failed for service', {
          service: def.key,
          message:
            outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        });
        return;
      }
      const parentId = encodeContainerId(def.key, def.rootFolderId);
      for (const [category, items] of Object.entries(outcome.value)) {
        for (const item of items) {
          const obj = this.searchHitToObject(item, def.key, parentId, category, parsed.classFilter);
          if (obj) {
            objects.push(obj);
          }
        }
      }
    });

    const total = objects.length;
    return { objects: objects.slice(offset, offset + limit), total };
  }

  private async searchService(
    def: ServiceDef,
    query: string,
    perCategory: number,
  ): Promise<Record<string, ContentFolderItem[]>> {
    // The source syntax carries per-category limits (same as the Subsonic adapter).
    const filters = [`track#${perCategory}`, `album#${perCategory}`, `artist#${perCategory}`].join(',');
    const { result } = await this.contentManager.globalSearch(`${def.searchSource}:${filters}`, query);
    return result ?? {};
  }

  private searchHitToObject(
    item: ContentFolderItem,
    serviceKey: string,
    parentId: string,
    category: string,
    classFilter: 'item' | 'container' | null,
  ): DidlContainer | DidlItem | null {
    const isTrack = category === 'track' || isTrackItem(item);
    if (isTrack) {
      if (classFilter === 'container') {
        return null;
      }
      return this.trackItem(item, parentId);
    }
    if (classFilter === 'item') {
      return null;
    }
    // A search category ('album'/'artist') is a reliable hint for providers that
    // don't tag their hits.
    const hint = category === 'album' || category === 'artist' ? category : undefined;
    return this.folderContainer(item, serviceKey, parentId, hint);
  }

  /** Metadata for a container whose id doubles as an audiopath (streaming services). */
  private async resolveContainerMetadata(folderId: string): Promise<ContentItemMetadata | null> {
    if (!folderId.includes(':')) {
      return null;
    }
    try {
      return await this.contentManager.resolveMetadata(folderId);
    } catch (error) {
      this.log.debug('container metadata resolve failed', {
        folderId,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private findService(key: string): ServiceDef | undefined {
    return this.serviceDefs().find((def) => def.key === key);
  }

  private async browseContainer(
    serviceKey: string,
    folderId: string,
    startingIndex: number,
    requestedCount: number,
  ): Promise<BrowseResult> {
    const def = this.findService(serviceKey);
    if (!def) {
      return { objects: [], total: 0 };
    }
    // RequestedCount 0 means "all" in UPnP; cap to a sane page for heavy providers.
    const limit = requestedCount > 0 ? requestedCount : 200;
    const offset = startingIndex > 0 ? startingIndex : 0;

    let folder: ContentFolder | null = null;
    try {
      folder = await def.browse(this.contentManager, folderId, offset, limit);
    } catch (error) {
      this.log.warn('browse failed', {
        service: serviceKey,
        folderId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (!folder) {
      return { objects: [], total: 0 };
    }

    // Child containers inherit this service's key so a follow-up Browse routes to
    // the same provider/bridge.
    const parentId = encodeContainerId(serviceKey, folderId);
    const objects: Array<DidlContainer | DidlItem> = [];
    for (const item of folder.items ?? []) {
      objects.push(this.renderItem(item, serviceKey, parentId));
    }
    const total =
      typeof folder.totalitems === 'number' && folder.totalitems > 0
        ? folder.totalitems
        : offset + objects.length;
    return { objects, total };
  }

  private renderItem(
    item: ContentFolderItem,
    serviceKey: string,
    parentId: string,
  ): DidlContainer | DidlItem {
    if (isTrackItem(item)) {
      return this.trackItem(item, parentId);
    }
    return this.folderContainer(item, serviceKey, parentId);
  }

  /** A top-level service tile (child of the root container). */
  private serviceContainer(def: ServiceDef): DidlContainer {
    return this.rememberContainer({
      id: encodeContainerId(def.key, def.rootFolderId),
      parentId: ROOT_OBJECT_ID,
      title: def.title,
      upnpClass: 'object.container.storageFolder',
      albumArtUri: def.iconUrl,
    });
  }

  /** A browsable folder/playlist/album belonging to `serviceKey`. */
  private folderContainer(
    item: ContentFolderItem,
    serviceKey: string,
    parentId: string,
    /** Used when the caller knows the kind and the item carries no hint (search). */
    kindHint?: ContentItemKind,
  ): DidlContainer {
    // The child container id must be the value the content layer accepts back as a
    // folderId on the next Browse: the listing item's `id` (e.g. `library-local`),
    // NOT its audiopath — the audiopath is a play target, not a browse key.
    const folderId = item.id || item.audiopath || 'root';
    const kind = item.kind ?? (item.tag ? resolveItemKind(item) : (kindHint ?? resolveItemKind(item)));
    const artist = item.artist?.trim() || undefined;
    return this.rememberContainer({
      id: encodeContainerId(serviceKey, folderId),
      parentId,
      title: item.name || item.title || 'Folder',
      upnpClass: CONTAINER_CLASS[kind] ?? CONTAINER_CLASS.folder,
      childCount: typeof item.items === 'number' ? item.items : undefined,
      albumArtUri: coverFor(item, this.baseUrl()) ?? undefined,
      // Only meaningful where the container has a performer; a genre folder does not.
      artist: kind === 'album' || kind === 'artist' ? artist : undefined,
    });
  }

  /** A playable track item; res URL points back at our stateless track endpoint. */
  private trackItem(item: ContentFolderItem, parentId: string): DidlItem {
    const audiopath = item.audiopath ?? '';
    const objectId = encodeItemId(audiopath);
    const base = this.baseUrl();
    const resUrl = `${base}/dlna/track/${encodeURIComponent(objectId)}.mp3`;
    const cover = coverFor(item, base);
    const duration = formatDuration(item.duration);
    const size = estimateSize(item.duration);
    return {
      id: objectId,
      parentId,
      title: item.name || item.title || 'Track',
      artist: item.artist || undefined,
      album: item.album || undefined,
      albumArtUri: cover ?? undefined,
      upnpClass: 'object.item.audioItem.musicTrack',
      resources: [
        {
          url: resUrl,
          protocolInfo: AUDIO_PROTOCOL_INFO,
          duration: duration ?? undefined,
          size: size ?? undefined,
          bitrate: MP3_BITRATE_BYTES,
          sampleFrequency: MP3_SAMPLE_RATE,
          nrAudioChannels: MP3_CHANNELS,
        },
      ],
    };
  }
}

export function isTrackItem(item: ContentFolderItem): boolean {
  // A track carries a playable audiopath and the "file" content type. Folders
  // (type 1/7/11/12…) browse further even when they expose a container audiopath.
  return item.type === CONTENT_TYPE_TRACK && !!item.audiopath;
}

function coverFor(item: ContentFolderItem, baseUrl: string): string | null {
  const raw = item.coverurl || item.thumbnail;
  if (!raw) {
    return null;
  }
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }
  if (raw.startsWith('/')) {
    return `${baseUrl}${raw}`;
  }
  return null;
}

function formatDuration(seconds?: number): string | null {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  // DLNA res@duration wants H:MM:SS.mmm with an un-padded hour.
  return `${h}:${pad(m)}:${pad(s)}.000`;
}

/** Estimated byte size for a live transcode (bitrate × duration). */
function estimateSize(durationSeconds?: number): number | null {
  if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return null;
  }
  return Math.round(MP3_BITRATE_BYTES * durationSeconds);
}
