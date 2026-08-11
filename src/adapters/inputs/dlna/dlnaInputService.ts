import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '@/shared/logging/logger';
import type { ZoneConfig } from '@/domain/config/types';
import type { AirplayController } from '@/ports/InputsPort';
import type { ConfigPort } from '@/ports/ConfigPort';
import { buildBaseUrl } from '@/shared/streamUrl';
import { resolveCoverHost } from '@/shared/utils/net';
import type { ZoneState } from '@/domain/zones/zoneState';
import {
  SsdpAdvertiser,
  UpnpMediaRenderer,
  RENDERER_PATHS,
  type TransportState,
} from '@sonn-audio/node-upnp';
import { DlnaRendererHandler } from '@/adapters/inputs/dlna/dlnaRendererHandler';

/** Absolute path prefix for one zone's renderer, under the shared HTTP server. */
function rendererBasePath(zoneId: number): string {
  return `/dlna-renderer/${zoneId}`;
}

/** Stable per-zone UDN so control points keep a single renderer entry across restarts. */
function rendererUdn(zoneId: number): string {
  return `uuid:sonn-renderer-${String(zoneId).padStart(4, '0')}-0000-0000-000000000000`;
}

type ZoneRenderer = {
  renderer: UpnpMediaRenderer;
  name: string;
  /** Last position/duration the zone reported, for GetPositionInfo. Null until it plays. */
  timing: { elapsed: number; duration: number } | null;
};

/**
 * How a zone's playback mode reads as a UPnP transport state. `STOPPED` and
 * `NO_MEDIA_PRESENT` are both "not playing", and the difference matters to a
 * control point: the first offers a play button, the second tells it there is
 * nothing to press it for.
 */
function transportStateFor(state: ZoneState): TransportState {
  if (state.mode === 'play') {
    return 'PLAYING';
  }
  if (state.mode === 'pause') {
    return 'PAUSED_PLAYBACK';
  }
  return state.audiopath ? 'STOPPED' : 'NO_MEDIA_PRESENT';
}

/**
 * Per-zone DLNA MediaRenderer input. Mirrors AirplayInputService: it syncs one
 * renderer per zone that has the DLNA input enabled, registers each as a
 * MediaRenderer device on the shared SSDP advertiser, and dispatches
 * `/dlna-renderer/:zoneId/*` HTTP requests to the right renderer.
 *
 * The UPnP protocol is owned by the module's {@link UpnpMediaRenderer}; this
 * service owns lifecycle/wiring and a per-zone {@link DlnaRendererHandler} that
 * turns a cast into the zone's playback (a `{kind:'url'}` engine source), so
 * casting to a zone works like AirPlay but over open UPnP.
 */
export class DlnaInputService {
  private readonly log = createLogger('Input', 'DlnaService');
  private readonly instances = new Map<number, ZoneRenderer>();
  private controller: AirplayController | null = null;

  constructor(
    private readonly config: ConfigPort,
    private readonly ssdp: SsdpAdvertiser,
    private readonly httpPort: number,
  ) {}

  public configure(controller: AirplayController): void {
    this.controller = controller;
  }

  private baseUrl(): string {
    const host = resolveCoverHost(this.config.getConfig().system.audioserver.ip);
    return buildBaseUrl({ host, port: this.httpPort });
  }

  /** DLNA is opt-in per player: a zone gets a renderer iff its own input is on. */
  public syncZones(zones: ZoneConfig[]): void {
    if (!this.controller) {
      this.log.debug('dlna input controller not configured; skipping sync');
      return;
    }
    const controller = this.controller;
    const desired = new Set<number>();
    for (const zone of zones) {
      const dlna = zone.inputs?.dlna;
      if (!dlna?.enabled) {
        this.removeInstance(zone.id);
        continue;
      }
      desired.add(zone.id);
      const name = dlna.publishName?.trim() || zone.name;
      const existing = this.instances.get(zone.id);
      if (existing) {
        existing.name = name; // friendlyName() closure reads this live
        continue;
      }
      const entry: ZoneRenderer = {
        renderer: null as unknown as UpnpMediaRenderer,
        name,
        timing: null,
      };
      const renderer = new UpnpMediaRenderer({
        udn: rendererUdn(zone.id),
        friendlyName: () => entry.name,
        baseUrl: () => `${this.baseUrl()}${rendererBasePath(zone.id)}`,
        handler: new DlnaRendererHandler(zone.id, controller, () => entry.timing),
        identity: {
          manufacturer: 'Sonn Audio',
          modelName: 'Sonn Audio',
          modelDescription: 'Sonn Audio DLNA Renderer',
        },
        logger: this.log,
      });
      entry.renderer = renderer;
      this.instances.set(zone.id, entry);
      this.ssdp.addDevice({
        udn: renderer.udn,
        ...renderer.deviceTypeAndServices(),
        location: () => `${this.baseUrl()}${rendererBasePath(zone.id)}/${RENDERER_PATHS.device}`,
      });
      this.log.info('dlna renderer advertised', { zoneId: zone.id, name });
    }
    for (const zoneId of this.instances.keys()) {
      if (!desired.has(zoneId)) {
        this.removeInstance(zoneId);
      }
    }
  }

  public shutdown(): void {
    this.removeAll();
  }

  private removeInstance(zoneId: number): void {
    const entry = this.instances.get(zoneId);
    if (!entry) {
      return;
    }
    this.ssdp.removeDevice(entry.renderer.udn);
    entry.renderer.dispose();
    this.instances.delete(zoneId);
  }

  private removeAll(): void {
    for (const zoneId of Array.from(this.instances.keys())) {
      this.removeInstance(zoneId);
    }
  }

  /**
   * Reflect a zone's own state onto its renderer, so a subscribed control point is
   * told what the zone is actually doing — not just what that control point cast at
   * it. Playback started from our app, a pause from a Loxone panel and a queue
   * advance all happen outside UPnP; without this the renderer reports the state it
   * was last *asked* for, which for a zone that never received a cast is `STOPPED`
   * forever.
   *
   * Cheap enough to call on every zone change: both reflect calls dedupe internally
   * (`setState` returns early on an unchanged state, so no GENA event is sent), and
   * zones without a renderer fall out on the map lookup.
   */
  public reflectZoneState(state: ZoneState): void {
    const entry = this.instances.get(state.id);
    if (!entry) {
      return;
    }
    entry.timing = { elapsed: state.time, duration: state.duration };
    entry.renderer.reflectTransportState(transportStateFor(state));
    entry.renderer.reflectVolume(state.volume);
  }

  // ── HTTP dispatch (registered on the gateway for /dlna-renderer/*) ────────────

  public matches(pathname: string): boolean {
    return pathname.startsWith('/dlna-renderer/');
  }

  public async handle(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    // /dlna-renderer/<zoneId>/<sub...>
    const rest = pathname.slice('/dlna-renderer/'.length);
    const slash = rest.indexOf('/');
    const zoneStr = slash >= 0 ? rest.slice(0, slash) : rest;
    const sub = slash >= 0 ? rest.slice(slash + 1) : '';
    const zoneId = Number(zoneStr);
    const entry = Number.isFinite(zoneId) ? this.instances.get(zoneId) : undefined;
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('renderer-not-found');
      return;
    }
    await entry.renderer.handle(req, res, sub);
  }
}
