import { createLogger } from '@/shared/logging/logger';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { ContentFolder, ContentFolderItem, ContentItemMetadata } from '@/ports/ContentTypes';
import { audioOutputSettings, mp3BitrateToBps } from '@/ports/types/audioFormat';
import type { ContentProvider, BrowseResult, DidlContainer, DidlItem } from '@sonn-audio/node-upnp';
import { ROOT_OBJECT_ID } from '@sonn-audio/node-upnp';
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

/** Loxone content type for a directly-playable file/track. Everything else browses. */
const CONTENT_TYPE_TRACK = 2;

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
      const def = this.findService(ref.service);
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
    return {
      id: encodeContainerId(def.key, def.rootFolderId),
      parentId: ROOT_OBJECT_ID,
      title: def.title,
      upnpClass: 'object.container.storageFolder',
      albumArtUri: def.iconUrl,
    };
  }

  /** A browsable folder/playlist/album belonging to `serviceKey`. */
  private folderContainer(
    item: ContentFolderItem,
    serviceKey: string,
    parentId: string,
  ): DidlContainer {
    // The child container id must be the value the content layer accepts back as a
    // folderId on the next Browse: the listing item's `id` (e.g. `library-local`),
    // NOT its audiopath — the audiopath is a play target, not a browse key.
    const folderId = item.id || item.audiopath || 'root';
    return {
      id: encodeContainerId(serviceKey, folderId),
      parentId,
      title: item.name || item.title || 'Folder',
      upnpClass: 'object.container.storageFolder',
      childCount: typeof item.items === 'number' ? item.items : undefined,
    };
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
