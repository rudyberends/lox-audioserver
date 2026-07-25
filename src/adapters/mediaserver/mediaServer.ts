import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { ContentPort } from '@/ports/ContentPort';
import type { EnginePort } from '@/ports/EnginePort';
import { buildBaseUrl } from '@/shared/streamUrl';
import { resolveCoverHost } from '@/shared/utils/net';
import { SsdpAdvertiser, UpnpMediaServer, MEDIA_SERVER_PATHS } from '@sonn-audio/node-upnp';
import {
  buildBrowsableServices,
  parseProviderAllowlist,
} from '@/adapters/content/browsableServices';
import {
  MediaContentProvider,
  type ServiceDef,
} from '@/adapters/mediaserver/mediaContentProvider';
import type { MediaServerService } from '@/adapters/mediaserver/objectId';
import { TrackStreamHandler } from '@/adapters/mediaserver/trackStreamHandler';

/** Base path under the shared HTTP server that this MediaServer serves. */
const DLNA_BASE = '/dlna';

// The source protocolInfo advertised in ConnectionManager GetProtocolInfo: the
// explicit PN-tagged MP3 profile we actually serve (matching the <res>
// protocolInfo and the track's contentFeatures header) so a strict sink
// recognises the profile, plus the audio/mpeg wildcard as a fallback.
const SOURCE_PROTOCOL_INFO = [
  'http-get:*:audio/mpeg:DLNA.ORG_PN=MP3;DLNA.ORG_OP=00;DLNA.ORG_CI=0;' +
    'DLNA.ORG_FLAGS=8D500000000000000000000000000000',
  'http-get:*:audio/mpeg:*',
].join(',');

/**
 * DLNA/UPnP MediaServer adapter — a thin wrapper over the module's
 * {@link UpnpMediaServer}, which owns the whole UPnP server protocol (device.xml,
 * SCPD, ContentDirectory/ConnectionManager SOAP, GENA). This adapter owns the app
 * concerns: the enabled gate, the config-derived identity (friendlyName/udn/
 * baseUrl), the service catalogue (library + radio + one tile per streaming
 * bridge), and the zone-less track stream handler that serves the actual MP3
 * bytes at `/dlna/track/<id>.mp3` (the module never serves audio).
 *
 * It plugs into the main gateway via matches()/handle() on `/dlna/*`.
 */
export class MediaServer {
  private readonly log = createLogger('MediaServer');
  private readonly server: UpnpMediaServer;
  private readonly track: TrackStreamHandler;
  private started = false;

  constructor(
    private readonly config: ConfigPort,
    contentManager: ContentManager,
    content: ContentPort,
    engine: EnginePort,
    private readonly httpPort: number,
    // Shared SSDP advertiser (one UDP socket on :1900 for all our UPnP devices).
    private readonly ssdp: SsdpAdvertiser,
  ) {
    const provider = new MediaContentProvider(
      contentManager,
      () => this.buildServiceDefs(),
      () => this.baseUrl(),
    );
    this.server = new UpnpMediaServer({
      udn: this.udn(),
      friendlyName: () => this.friendlyName(),
      baseUrl: () => `${this.baseUrl()}${DLNA_BASE}`,
      provider,
      sourceProtocolInfo: SOURCE_PROTOCOL_INFO,
      // The text properties globalSearch matches against; advertised in
      // GetSearchCapabilities so control points offer a search box.
      searchCapabilities: 'dc:title,upnp:artist,upnp:album',
      logger: this.log,
    });
    this.track = new TrackStreamHandler(engine, content);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  public isEnabled(): boolean {
    return this.config.getConfig().content.mediaServer?.enabled === true;
  }

  public async start(): Promise<void> {
    if (this.started || !this.isEnabled()) {
      return;
    }
    this.started = true;
    // Register the MediaServer as a device on the shared SSDP advertiser (the
    // advertiser itself is started/stopped by the composition root).
    this.ssdp.addDevice({
      udn: this.server.udn,
      ...this.server.deviceTypeAndServices(),
      location: () => `${this.baseUrl()}${DLNA_BASE}/${MEDIA_SERVER_PATHS.device}`,
    });
    this.log.info('media server advertised', {
      friendlyName: this.friendlyName(),
      location: `${this.baseUrl()}${DLNA_BASE}/${MEDIA_SERVER_PATHS.device}`,
    });
  }

  public async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.ssdp.removeDevice(this.server.udn);
  }

  // ── HTTP dispatch ───────────────────────────────────────────────────────────

  public matches(pathname: string): boolean {
    return pathname.startsWith(`${DLNA_BASE}/`);
  }

  public async handle(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    // The whole surface is gated on the enabled flag to avoid exposing content unexpectedly.
    if (!this.isEnabled()) {
      this.notFound(res);
      return;
    }
    // Track streaming stays app-side (the module doesn't serve audio bytes).
    if (this.track.matches(pathname)) {
      await this.track.handle(req, res, pathname);
      return;
    }
    // Everything else is UPnP protocol: strip the /dlna/ prefix and delegate the
    // sub-path (device.xml, cds/control, …) to the module's server.
    const sub = pathname.slice(`${DLNA_BASE}/`.length);
    await this.server.handle(req, res, sub);
  }

  // ── Config-derived values ────────────────────────────────────────────────────

  /**
   * Build the top-level service catalogue: the shared browsable-services list
   * (library + radio + one entry per enabled streaming bridge), decorated with
   * the per-service tile icons DLNA controllers show.
   */
  private buildServiceDefs(): ServiceDef[] {
    const allow = parseProviderAllowlist(this.config.getConfig().content.mediaServer?.providers);
    // Cache-buster: some controllers (B&O) cache tile icons hard by URL, so a
    // changed icon at the same path can keep showing the stale image. The version
    // token forces a fresh fetch when the icon set changes.
    const icon = (path: string): string => `${this.baseUrl()}${path}?v=${ICON_VERSION}`;

    return buildBrowsableServices(this.config, allow).map((service) => {
      const iconPath = PROVIDER_ICON_PATHS[service.provider];
      return {
        key: service.key,
        service: service.provider as MediaServerService,
        title: service.title,
        rootFolderId: service.rootFolderId,
        iconUrl: iconPath ? icon(iconPath) : undefined,
        searchSource: service.searchSource,
        browse: service.browse,
      };
    });
  }

  private friendlyName(): string {
    const cfg = this.config.getConfig();
    return (
      cfg.content.mediaServer?.friendlyName?.trim() ||
      cfg.system.audioserver.name?.trim() ||
      'Sonn Audio'
    );
  }

  private udn(): string {
    // Derive a stable UDN from the audioserver uuid so controllers keep one entry
    // across restarts. Fall back to a fixed namespace if uuid is unset.
    const uuid = this.config.getConfig().system.audioserver.uuid?.trim();
    const base = uuid && uuid.length >= 8 ? uuid : 'sonn-audio-mediaserver-0000';
    return `uuid:${base}`;
  }

  private baseUrl(): string {
    const host = resolveCoverHost(this.config.getConfig().system.audioserver.ip);
    return buildBaseUrl({ host, port: this.httpPort });
  }

  private notFound(res: ServerResponse): void {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not-found');
  }
}

// Per-service tile icons, keyed by provider type. Flat RGB PNGs under
// /dlna-icons/. Bump ICON_VERSION when the icon set changes so caching
// controllers refetch.
const ICON_VERSION = '2';

const PROVIDER_ICON_PATHS: Record<string, string> = {
  library: '/dlna-icons/library.png',
  radio: '/dlna-icons/radio.png',
  applemusic: '/dlna-icons/apple-music.png',
  deezer: '/dlna-icons/deezer.png',
  tidal: '/dlna-icons/tidal.png',
  soundcloud: '/dlna-icons/soundcloud.png',
  ytmusic: '/dlna-icons/youtube-music.png',
  youtube: '/dlna-icons/youtube.png',
};
