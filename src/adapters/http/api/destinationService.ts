/**
 * Destinations: everywhere audio can be sent.
 *
 * This server does not require zones. It can run as a DLNA source with a streaming account
 * and nothing else, and a client can play audio itself without any zone existing. The zone
 * concept comes from the Loxone clients, which need everything to be one — a browser tab was
 * given a synthetic zone in the reserved 9000 range purely so it would be visible. That is a
 * translation artefact, and a public API should not inherit it.
 *
 * So this exposes the smaller idea — an id you can play to — and lets a zone be one kind of
 * destination rather than the only kind. Zones keep their own routes for what only they have:
 * grouping, favourites, a queue.
 *
 * Underneath, a local destination is still implemented as an ephemeral zone, because that is
 * what the sendspin output pipeline attaches to. That is an implementation detail and
 * deliberately not in the payload: the day it stops being a zone internally, nothing a caller
 * sees needs to change.
 */
import type { BrowserZoneRegistry } from '@/application/zones/browserZoneRegistry';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { ApiDestination, ApiLocalDestination } from '@/domain/zones/apiTypes';
import { createLogger } from '@/shared/logging/logger';

/**
 * The id range the browser-zone registry allocates from. Used only to tell a local
 * destination from a configured zone when listing.
 */
const LOCAL_ID_BASE = 9000;
const LOCAL_ID_LIMIT = 9999;

const isLocalZoneId = (zoneId: number): boolean =>
  zoneId >= LOCAL_ID_BASE && zoneId <= LOCAL_ID_LIMIT;

export class DestinationService {
  private readonly log = createLogger('Api', 'Destinations');

  constructor(
    private readonly zoneManager: ZoneManagerFacade,
    private readonly browserZones: BrowserZoneRegistry | undefined,
    /** Fallback port, for when a caller sent no Host header to derive one from. */
    private readonly httpPort: number,
    private readonly resolveProtocol: (zoneId: number) => string | null,
  ) {}

  /** The client that owns a zone, or null for a configured one. */
  public ownerOf(zoneId: number): string | null {
    return this.browserZones?.ownerOf(zoneId) ?? null;
  }

  /**
   * Everywhere this caller can send audio.
   *
   * Configured zones are shared; a local destination belongs to the browser that registered it
   * and is filtered out for everyone else. A caller with no client id sees the zones only,
   * which is right for a script — it has no browser to play to.
   */
  public list(clientId?: string): ApiDestination[] {
    const mine = clientId?.trim() ?? '';
    return this.zoneManager
      .getAllZoneStates()
      .filter((state) => {
        const owner = this.ownerOf(state.id);
        return !owner || owner === mine;
      })
      .map((state) => ({
      // A zone's destination id is its zone id as a string, so the two are trivially
      // relatable — a caller holding one can use the other's routes.
      id: String(state.id),
      name: state.name ?? '',
      kind: isLocalZoneId(state.id) ? 'local' : 'zone',
      protocol: this.resolveProtocol(state.id) ?? '',
      // A configured zone is always addressable; whether its device answers is
      // `output.device.connected` on the zone itself.
      available: true,
    }));
  }

  /**
   * Registers the caller as a destination that plays the audio itself.
   *
   * Returns what it needs to start receiving: a client id to announce, and the socket to
   * connect to. Nothing is played until it connects — this only reserves the identity.
   *
   * A `clientId` may be supplied to reclaim an existing registration, which is what a page
   * reload needs: without it every refresh would leave an orphan behind until it timed out.
   */
  public async registerLocal(options: {
    name?: string;
    clientId?: string;
    /**
     * The request's `Host` header, which is the only address known to work for this caller.
     *
     * The configured bind address is not usable: a server listening on `0.0.0.0` would hand
     * out `ws://0.0.0.0:7090`, and picking one interface would be wrong for a client on
     * another subnet. Whatever host reached us is by definition reachable from there.
     */
    host?: string;
  }): Promise<ApiLocalDestination | null> {
    if (!this.browserZones) {
      // Built without the registry: say so rather than pretending to register.
      return null;
    }
    const record = await this.browserZones.register({
      name: options.name,
      // The registry calls this a serial and matches on it across reconnects.
      serial: options.clientId,
    });
    this.log.info('local destination registered', {
      id: record.zoneId,
      clientId: record.serial,
    });
    return {
      id: String(record.zoneId),
      name: record.name,
      kind: 'local',
      protocol: 'sendspin',
      available: true,
      clientId: record.serial,
      streamUrl: `ws://${options.host?.trim() || `127.0.0.1:${this.httpPort}`}/sendspin`,
    };
  }

  /**
   * Removes a local destination.
   *
   * Only a local one: a configured zone is not this API's to delete, and a caller asking for
   * that has confused the two. Returns false so it answers 404 rather than 204 on a no-op.
   */
  public async removeLocal(id: string): Promise<boolean> {
    const zoneId = Number(id);
    if (!Number.isFinite(zoneId) || !isLocalZoneId(zoneId) || !this.browserZones) {
      return false;
    }
    return this.browserZones.unregister(zoneId);
  }
}
