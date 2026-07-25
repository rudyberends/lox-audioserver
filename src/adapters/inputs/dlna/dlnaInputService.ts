import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '@/shared/logging/logger';
import type { ZoneConfig, GlobalDlnaConfig } from '@/domain/config/types';
import type { AirplayController } from '@/ports/InputsPort';
import type { ConfigPort } from '@/ports/ConfigPort';
import { buildBaseUrl } from '@/shared/streamUrl';
import { resolveCoverHost } from '@/shared/utils/net';
import type { SsdpAdvertiser } from '@/adapters/mediaserver/ssdpAdvertiser';
import { DlnaRendererInstance } from '@/adapters/inputs/dlna/dlnaRendererInstance';
import { rendererBasePath } from '@/adapters/inputs/dlna/rendererDescription';

/**
 * Per-zone DLNA MediaRenderer input. Mirrors AirplayInputService: it syncs one
 * DlnaRendererInstance per zone that has the DLNA input enabled, registers each
 * as a MediaRenderer device on the shared SSDP advertiser, and dispatches
 * `/dlna-renderer/:zoneId/*` HTTP requests to the right instance.
 *
 * The renderer turns a control point's SetAVTransportURI+Play into the zone's
 * playback via the shared input controller (a `{kind:'url'}` engine source), so
 * casting to a zone works like AirPlay but over open UPnP.
 */
export class DlnaInputService {
  private readonly log = createLogger('Input', 'DlnaService');
  private readonly instances = new Map<number, DlnaRendererInstance>();
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

  public syncZones(zones: ZoneConfig[], dlnaConfig?: GlobalDlnaConfig | null): void {
    const enabled = dlnaConfig?.enabled ?? false;
    if (!enabled) {
      this.removeAll();
      return;
    }
    if (!this.controller) {
      this.log.debug('dlna input controller not configured; skipping sync');
      return;
    }
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
        existing.setName(name);
        continue;
      }
      const instance = new DlnaRendererInstance(
        zone.id,
        name,
        this.controller,
        () => this.baseUrl(),
      );
      this.instances.set(zone.id, instance);
      this.ssdp.addDevice({
        udn: instance.udn(),
        deviceType: 'urn:schemas-upnp-org:device:MediaRenderer:1',
        serviceTypes: [
          'urn:schemas-upnp-org:service:AVTransport:1',
          'urn:schemas-upnp-org:service:RenderingControl:1',
          'urn:schemas-upnp-org:service:ConnectionManager:1',
        ],
        location: () => `${this.baseUrl()}${rendererBasePath(zone.id)}/device.xml`,
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
    const instance = this.instances.get(zoneId);
    if (!instance) {
      return;
    }
    this.ssdp.removeDevice(instance.udn());
    instance.dispose();
    this.instances.delete(zoneId);
  }

  private removeAll(): void {
    for (const zoneId of Array.from(this.instances.keys())) {
      this.removeInstance(zoneId);
    }
  }

  /** Optionally reflect a zone's volume back to its renderer's RenderingControl. */
  public reflectVolume(zoneId: number, volumePercent: number): void {
    this.instances.get(zoneId)?.reflectVolume(volumePercent);
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
    const instance = Number.isFinite(zoneId) ? this.instances.get(zoneId) : undefined;
    if (!instance) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('renderer-not-found');
      return;
    }
    await instance.handle(req, res, sub);
  }
}
