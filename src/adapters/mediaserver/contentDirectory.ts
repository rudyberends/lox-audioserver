import { createLogger } from '@/shared/logging/logger';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { ContentFolder, ContentFolderItem, ContentItemMetadata } from '@/ports/ContentTypes';
import {
  buildContainerElement,
  buildFolderContainer,
  buildTrackItem,
  isTrackItem,
  wrapDidl,
} from '@/adapters/mediaserver/didl';
import {
  ROOT_OBJECT_ID,
  decodeObjectId,
  encodeContainerId,
  type MediaServerService,
} from '@/adapters/mediaserver/objectId';

/**
 * A top-level service the MediaServer surfaces as a child of the root container.
 *
 * `key` is the stable id used in the object id's service segment (a bridge id for
 * streaming services, or `library`/`radio` for the built-ins). `browse(folderId,
 * offset, limit)` maps the service to a ContentManager call; `rootFolderId` is
 * the native id handed in for the service's own top level.
 *
 * The catalogue is built from config (see MediaServer.buildServiceDefs), NOT a
 * static list, because streaming bridges are keyed by a per-instance bridge id —
 * `getServiceFolder(service, user, …)` only resolves the right provider when
 * `user` is that bridge id, not the generic provider name. A static
 * ('applemusic','applemusic') call misses the bridge and returns empty (while a
 * lone bridge would instead answer via the single-provider fallback, leaking its
 * content under the wrong tile). Deriving from config also gives one tile per
 * configured account when several bridges share a provider type.
 */
export type ServiceDef = {
  /** Stable id embedded in object ids (bridge id, or 'library'/'radio'). */
  key: string;
  service: MediaServerService;
  title: string;
  rootFolderId: string;
  browse: (
    cm: ContentManager,
    folderId: string,
    offset: number,
    limit: number,
  ) => Promise<ContentFolder | null>;
};

const BROWSE_ACTION = 'urn:schemas-upnp-org:service:ContentDirectory:1#Browse';
const CD_NS = 'urn:schemas-upnp-org:service:ContentDirectory:1';

export type BrowseRequest = {
  objectId: string;
  browseFlag: 'BrowseMetadata' | 'BrowseDirectChildren';
  startingIndex: number;
  requestedCount: number;
};

export type BrowseResponse = {
  didl: string;
  numberReturned: number;
  totalMatches: number;
};

/**
 * Serves ContentDirectory:1 Browse over the existing content layer. It never
 * fetches media itself — it delegates to ContentManager and re-serialises the
 * result as DIDL-Lite, with `/dlna/track/<id>` res URLs pointing back at us.
 */
export class ContentDirectory {
  private readonly log = createLogger('MediaServer', 'CDS');

  constructor(
    private readonly contentManager: ContentManager,
    // The catalogue of top-level services, built from config by the MediaServer
    // (library + radio + one entry per configured streaming bridge). Called per
    // request so config changes take effect without a restart.
    private readonly serviceDefs: () => ServiceDef[],
  ) {}

  /** The service defs currently exposed. */
  private services(): ServiceDef[] {
    return this.serviceDefs();
  }

  private findService(key: string): ServiceDef | undefined {
    return this.serviceDefs().find((def) => def.key === key);
  }

  public isBrowseAction(soapAction: string): boolean {
    const cleaned = soapAction.replace(/"/g, '').trim();
    return cleaned === BROWSE_ACTION;
  }

  /** Parse a Browse SOAP envelope. Returns null when it isn't a well-formed Browse. */
  public parseBrowse(body: string): BrowseRequest | null {
    if (!/<[\w:]*Browse[\s>]/.test(body)) {
      return null;
    }
    const objectId = extractTag(body, 'ObjectID') ?? ROOT_OBJECT_ID;
    const flagRaw = extractTag(body, 'BrowseFlag') ?? 'BrowseDirectChildren';
    const browseFlag =
      flagRaw === 'BrowseMetadata' ? 'BrowseMetadata' : 'BrowseDirectChildren';
    const startingIndex = toInt(extractTag(body, 'StartingIndex'), 0);
    const requestedCount = toInt(extractTag(body, 'RequestedCount'), 0);
    return { objectId, browseFlag, startingIndex, requestedCount };
  }

  public async browse(req: BrowseRequest, baseUrl: string): Promise<BrowseResponse> {
    const ref = decodeObjectId(req.objectId);
    if (!ref) {
      return { didl: wrapDidl([]), numberReturned: 0, totalMatches: 0 };
    }

    // Metadata on a container/item: return a one-element description of the object
    // itself. Controllers (notably the B&O app) issue BrowseMetadata on a track
    // just before play, and feed the returned DIDL to the renderer via
    // SetAVTransportURI — so an empty item here means an empty now-playing screen.
    if (req.browseFlag === 'BrowseMetadata') {
      return this.browseMetadata(ref, req.objectId, baseUrl);
    }

    if (ref.kind === 'root') {
      return this.browseRoot();
    }
    if (ref.kind === 'item') {
      // Items have no children.
      return { didl: wrapDidl([]), numberReturned: 0, totalMatches: 0 };
    }
    return this.browseContainer(ref.service, ref.folderId, req, baseUrl);
  }

  private browseRoot(): BrowseResponse {
    const defs = this.services();
    const elements = defs.map((def) =>
      buildContainerElement({
        id: encodeContainerId(def.key, def.rootFolderId),
        parentId: ROOT_OBJECT_ID,
        title: def.title,
      }),
    );
    return {
      didl: wrapDidl(elements),
      numberReturned: elements.length,
      totalMatches: elements.length,
    };
  }

  private async browseMetadata(
    ref: NonNullable<ReturnType<typeof decodeObjectId>>,
    objectId: string,
    baseUrl: string,
  ): Promise<BrowseResponse> {
    if (ref.kind === 'root') {
      const element = buildContainerElement({
        id: ROOT_OBJECT_ID,
        parentId: '-1',
        title: 'Sonn Audio',
        childCount: this.services().length,
      });
      return { didl: wrapDidl([element]), numberReturned: 1, totalMatches: 1 };
    }
    if (ref.kind === 'container') {
      const def = this.findService(ref.service);
      const element = buildContainerElement({
        id: objectId,
        parentId: ROOT_OBJECT_ID,
        title: def?.title ?? ref.service,
      });
      return { didl: wrapDidl([element]), numberReturned: 1, totalMatches: 1 };
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
    const element = buildTrackItem(item, '-1', baseUrl);
    return { didl: wrapDidl([element]), numberReturned: 1, totalMatches: 1 };
  }

  private async browseContainer(
    serviceKey: string,
    folderId: string,
    req: BrowseRequest,
    baseUrl: string,
  ): Promise<BrowseResponse> {
    const def = this.findService(serviceKey);
    if (!def) {
      return { didl: wrapDidl([]), numberReturned: 0, totalMatches: 0 };
    }
    // RequestedCount 0 means "all" in UPnP; cap to a sane page for heavy providers.
    const limit = req.requestedCount > 0 ? req.requestedCount : 200;
    const offset = req.startingIndex > 0 ? req.startingIndex : 0;

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
      return { didl: wrapDidl([]), numberReturned: 0, totalMatches: 0 };
    }

    // Child containers inherit this service's key so a follow-up Browse routes to
    // the same provider/bridge.
    const parentId = encodeContainerId(serviceKey, folderId);
    const elements: string[] = [];
    for (const item of folder.items ?? []) {
      elements.push(this.renderItem(item, serviceKey, parentId, baseUrl));
    }
    const total =
      typeof folder.totalitems === 'number' && folder.totalitems > 0
        ? folder.totalitems
        : offset + elements.length;
    return { didl: wrapDidl(elements), numberReturned: elements.length, totalMatches: total };
  }

  private renderItem(
    item: ContentFolderItem,
    serviceKey: string,
    parentId: string,
    baseUrl: string,
  ): string {
    if (isTrackItem(item)) {
      return buildTrackItem(item, parentId, baseUrl);
    }
    return buildFolderContainer(item, serviceKey, parentId);
  }

  /** Build the full SOAP response envelope for a Browse result. */
  public buildBrowseSoapResponse(result: BrowseResponse, updateId = 0): string {
    // The DIDL document is embedded as an escaped string inside <Result>.
    const escapedDidl = escapeSoapValue(result.didl);
    return (
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
      's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      '<s:Body>' +
      `<u:BrowseResponse xmlns:u="${CD_NS}">` +
      `<Result>${escapedDidl}</Result>` +
      `<NumberReturned>${result.numberReturned}</NumberReturned>` +
      `<TotalMatches>${result.totalMatches}</TotalMatches>` +
      `<UpdateID>${updateId}</UpdateID>` +
      '</u:BrowseResponse>' +
      '</s:Body></s:Envelope>'
    );
  }

  public buildSoapFault(message: string): string {
    return (
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
      's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      '<s:Body><s:Fault>' +
      '<faultcode>s:Client</faultcode>' +
      `<faultstring>${escapeSoapValue(message)}</faultstring>` +
      '</s:Fault></s:Body></s:Envelope>'
    );
  }
}

function extractTag(xml: string, tag: string): string | null {
  // Namespace-tolerant, matches <ObjectID>…</ObjectID> or <u:ObjectID>…</…>.
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'i');
  const match = re.exec(xml);
  if (!match) {
    return null;
  }
  return unescapeSoapValue(match[1] ?? '').trim();
}

function toInt(value: string | null, fallback: number): number {
  const n = Number((value ?? '').trim());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function escapeSoapValue(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function unescapeSoapValue(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&amp;/g, '&');
}
