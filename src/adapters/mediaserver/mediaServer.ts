import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { ContentPort } from '@/ports/ContentPort';
import type { EnginePort } from '@/ports/EnginePort';
import { buildBaseUrl } from '@/shared/streamUrl';
import { resolveCoverHost } from '@/shared/utils/net';
import { ContentDirectory, type ServiceDef } from '@/adapters/mediaserver/contentDirectory';
import type { MediaServerService } from '@/adapters/mediaserver/objectId';
import { TrackStreamHandler } from '@/adapters/mediaserver/trackStreamHandler';
import { SsdpAdvertiser } from '@/adapters/mediaserver/ssdpAdvertiser';
import {
  CDS_CONTROL_PATH,
  CDS_SCPD,
  CDS_SCPD_PATH,
  CMS_CONTROL_PATH,
  CMS_SCPD,
  CMS_SCPD_PATH,
  DEVICE_DESCRIPTION_PATH,
  buildDeviceDescription,
  buildGetProtocolInfoResponse,
} from '@/adapters/mediaserver/deviceDescription';

/**
 * DLNA/UPnP MediaServer adapter.
 *
 * Exposes all browsable content (local library, radio, and the streaming
 * bridges) as a ContentDirectory, and serves each track statelessly at
 * `/dlna/track/<id>`. It is the inverse of the per-zone DLNA *output*: rather
 * than pushing a stream to a renderer, it advertises a media server that
 * renderers pull from.
 *
 * The adapter owns:
 *   - the SSDP advertiser (presence + M-SEARCH replies),
 *   - the ContentDirectory (Browse over the existing content layer),
 *   - the static description/SCPD documents,
 *   - and the zone-less track stream handler.
 *
 * It plugs into the main gateway via matches()/handle() on `/dlna/*`.
 */
export class MediaServer {
  private readonly log = createLogger('MediaServer');
  private readonly cds: ContentDirectory;
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
    this.cds = new ContentDirectory(contentManager, () => this.buildServiceDefs());
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
      udn: this.udn(),
      deviceType: 'urn:schemas-upnp-org:device:MediaServer:1',
      serviceTypes: [
        'urn:schemas-upnp-org:service:ContentDirectory:1',
        'urn:schemas-upnp-org:service:ConnectionManager:1',
      ],
      location: () => `${this.baseUrl()}${DEVICE_DESCRIPTION_PATH}`,
    });
    this.log.info('media server advertised', {
      friendlyName: this.friendlyName(),
      location: `${this.baseUrl()}${DEVICE_DESCRIPTION_PATH}`,
    });
  }

  public async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.ssdp.removeDevice(this.udn());
  }

  // ── HTTP dispatch ───────────────────────────────────────────────────────────

  public matches(pathname: string): boolean {
    return pathname.startsWith('/dlna/');
  }

  public async handle(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    // Track streaming stays available even if advertising is off, but the whole
    // surface is gated on the enabled flag to avoid exposing content unexpectedly.
    if (!this.isEnabled()) {
      this.notFound(res);
      return;
    }

    if (this.track.matches(pathname)) {
      await this.track.handle(req, res, pathname);
      return;
    }

    switch (pathname) {
      case DEVICE_DESCRIPTION_PATH:
        this.sendXml(res, buildDeviceDescription({
          udn: this.udn(),
          friendlyName: this.friendlyName(),
          baseUrl: this.baseUrl(),
        }));
        return;
      case CDS_SCPD_PATH:
        this.sendXml(res, CDS_SCPD);
        return;
      case CMS_SCPD_PATH:
        this.sendXml(res, CMS_SCPD);
        return;
      case CDS_CONTROL_PATH:
        await this.handleCdsControl(req, res);
        return;
      case CMS_CONTROL_PATH:
        await this.handleCmsControl(req, res);
        return;
      default:
        // GENA event subscribe endpoints: accept SUBSCRIBE so controllers don't
        // error, but we send no events (our tree is effectively static per session).
        if (req.method === 'SUBSCRIBE' || req.method === 'UNSUBSCRIBE') {
          this.acceptSubscribe(res);
          return;
        }
        this.notFound(res);
    }
  }

  // ── SOAP control ─────────────────────────────────────────────────────────────

  private async handleCdsControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      this.methodNotAllowed(res);
      return;
    }
    const soapAction = String(req.headers['soapaction'] ?? '');
    const body = await readBody(req);
    if (this.cds.isBrowseAction(soapAction) || /Browse/.test(body)) {
      const parsed = this.cds.parseBrowse(body);
      if (!parsed) {
        this.sendSoap(res, this.cds.buildSoapFault('Invalid Browse request'), 500);
        return;
      }
      try {
        const result = await this.cds.browse(parsed, this.baseUrl());
        this.sendSoap(res, this.cds.buildBrowseSoapResponse(result));
      } catch (error) {
        this.log.warn('browse handling failed', {
          message: error instanceof Error ? error.message : String(error),
        });
        this.sendSoap(res, this.cds.buildSoapFault('Browse failed'), 500);
      }
      return;
    }
    // GetSystemUpdateID / GetSearch/SortCapabilities: minimal valid responses.
    if (/GetSystemUpdateID/.test(soapAction) || /GetSystemUpdateID/.test(body)) {
      this.sendSoap(res, buildSimpleCdsResponse('GetSystemUpdateID', { Id: '1' }));
      return;
    }
    if (/GetSearchCapabilities/.test(soapAction) || /GetSearchCapabilities/.test(body)) {
      this.sendSoap(res, buildSimpleCdsResponse('GetSearchCapabilities', { SearchCaps: '' }));
      return;
    }
    if (/GetSortCapabilities/.test(soapAction) || /GetSortCapabilities/.test(body)) {
      this.sendSoap(res, buildSimpleCdsResponse('GetSortCapabilities', { SortCaps: '' }));
      return;
    }
    this.sendSoap(res, this.cds.buildSoapFault('Unsupported action'), 500);
  }

  private async handleCmsControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      this.methodNotAllowed(res);
      return;
    }
    const soapAction = String(req.headers['soapaction'] ?? '');
    if (/GetProtocolInfo/.test(soapAction)) {
      this.sendSoap(res, buildGetProtocolInfoResponse());
      return;
    }
    // Drain body then answer a benign fault for anything else.
    await readBody(req);
    this.sendSoap(res, this.cds.buildSoapFault('Unsupported action'), 500);
  }

  // ── Config-derived values ────────────────────────────────────────────────────

  private allowedServices(): Set<string> | null {
    const providers = this.config.getConfig().content.mediaServer?.providers;
    if (!providers || providers.length === 0) {
      return null;
    }
    return new Set(providers.map((p) => p.trim().toLowerCase()).filter(Boolean));
  }

  /**
   * Build the top-level service catalogue from config.
   *
   * Library and Radio are always present. Each enabled streaming bridge becomes
   * one tile keyed by its bridge id — crucially, the browse call passes that
   * bridge id as the `user` argument, which is the only value the content layer's
   * provider resolution matches (the generic provider name does NOT resolve a
   * bridge, and with several bridges configured the single-provider fallback is
   * refused, so a provider-name browse returns empty). This also yields one tile
   * per account when multiple bridges share a provider type.
   *
   * The optional config allowlist filters by provider name (e.g. only expose
   * ['library','soundcloud']). `outputOnly` providers never appear as tiles.
   */
  private buildServiceDefs(): ServiceDef[] {
    const allow = this.allowedServices();
    const permitted = (provider: string): boolean => !allow || allow.has(provider);
    // Cache-buster: some controllers (B&O) cache tile icons hard by URL, so a
    // changed icon at the same path can keep showing the stale image. The version
    // token forces a fresh fetch when the icon set changes.
    const icon = (path: string): string => `${this.baseUrl()}${path}?v=${ICON_VERSION}`;

    const defs: ServiceDef[] = [];
    if (permitted('library')) {
      defs.push({
        key: 'library',
        service: 'library',
        title: 'Library',
        rootFolderId: 'root',
        iconUrl: icon('/dlna-icons/library.png'),
        browse: (cm, folderId, offset, limit) => cm.getMediaFolder(folderId, offset, limit),
      });
    }
    if (permitted('radio')) {
      defs.push({
        key: 'radio',
        service: 'radio',
        title: 'Radio',
        rootFolderId: 'start',
        iconUrl: icon('/dlna-icons/radio.png'),
        browse: (cm, folderId, offset, limit) =>
          cm.getServiceFolder('radioparadise', 'radioparadise', folderId, offset, limit),
      });
    }

    const bridges = this.config.getConfig().content.spotify?.bridges ?? [];
    for (const bridge of bridges) {
      if (!bridge || bridge.enabled === false || !bridge.id) {
        continue;
      }
      const provider = bridge.provider?.trim().toLowerCase();
      if (!provider || !permitted(provider)) {
        continue;
      }
      const bridgeId = bridge.id;
      const service = provider as MediaServerService;
      const iconPath = PROVIDER_ICON_PATHS[provider];
      defs.push({
        key: bridgeId,
        service,
        title: bridge.label?.trim() || defaultProviderTitle(provider),
        rootFolderId: 'root',
        iconUrl: iconPath ? icon(iconPath) : undefined,
        // The content layer resolves the bridge from `user === bridgeId`.
        browse: (cm, folderId, offset, limit) =>
          cm.getServiceFolder(provider, bridgeId, folderId, offset, limit),
      });
    }
    return defs;
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

  // ── HTTP helpers ─────────────────────────────────────────────────────────────

  private sendXml(res: ServerResponse, xml: string): void {
    res.writeHead(200, {
      'Content-Type': 'text/xml; charset="utf-8"',
      'Cache-Control': 'no-cache',
    });
    res.end(xml);
  }

  private sendSoap(res: ServerResponse, xml: string, status = 200): void {
    res.writeHead(status, {
      'Content-Type': 'text/xml; charset="utf-8"',
      EXT: '',
    });
    res.end(xml);
  }

  private acceptSubscribe(res: ServerResponse): void {
    // Grant a subscription with an SID but never NOTIFY. Controllers tolerate a
    // silent subscription; our content tree has no live change events to push.
    res.writeHead(200, {
      SID: `uuid:${this.udn().slice(5)}-cds`,
      TIMEOUT: 'Second-1800',
    });
    res.end();
  }

  private notFound(res: ServerResponse): void {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not-found');
  }

  private methodNotAllowed(res: ServerResponse): void {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method-not-allowed');
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const MAX = 256 * 1024;
  const chunks: Buffer[] = [];
  let total = 0;
  return new Promise<string>((resolve) => {
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX) {
        // Stop accumulating; return what we have (SOAP bodies are tiny).
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const PROVIDER_TITLES: Record<string, string> = {
  soundcloud: 'SoundCloud',
  applemusic: 'Apple Music',
  deezer: 'Deezer',
  tidal: 'Tidal',
  ytmusic: 'YouTube Music',
  youtube: 'YouTube',
  musicassistant: 'Music Assistant',
};

function defaultProviderTitle(provider: string): string {
  return PROVIDER_TITLES[provider] ?? provider;
}

// Per-provider tile icons. These are flat RGB PNGs (rasterised from the provider
// SVGs) under /dlna-icons/ — a plain raster with no alpha is the most broadly
// rendered form across DLNA controllers.
// Bump when the icon set changes so caching controllers refetch.
const ICON_VERSION = '2';

const PROVIDER_ICON_PATHS: Record<string, string> = {
  applemusic: '/dlna-icons/apple-music.png',
  deezer: '/dlna-icons/deezer.png',
  tidal: '/dlna-icons/tidal.png',
  soundcloud: '/dlna-icons/soundcloud.png',
  ytmusic: '/dlna-icons/youtube-music.png',
  youtube: '/dlna-icons/youtube.png',
};

const CD_NS = 'urn:schemas-upnp-org:service:ContentDirectory:1';

function buildSimpleCdsResponse(action: string, args: Record<string, string>): string {
  const body = Object.entries(args)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body>' +
    `<u:${action}Response xmlns:u="${CD_NS}">${body}</u:${action}Response>` +
    '</s:Body></s:Envelope>'
  );
}
