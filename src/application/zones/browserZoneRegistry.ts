import { createLogger } from '@/shared/logging/logger';
import type { ZoneConfig } from '@/domain/config/types';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';

/**
 * Manages ephemeral "browser" zones — virtual zones created at runtime by the
 * player webapp so a browser tab can act as its own audio destination. Zones
 * are NOT persisted to the configuration file; they disappear from the audio
 * server when the registry is shut down or the browser unregisters.
 *
 * Each registered zone:
 *   - Gets an id in the reserved 9000-9999 range (separate from config zones).
 *   - Has a single `sendspin` transport keyed on a sticky `clientId` so the
 *     browser's WebSocket connection on `/sendspin` is matched to this zone.
 *   - Audio is delivered by the standard Sendspin output pipeline; the player
 *     uses `@sendspin/sendspin-js` to receive and play chunks.
 */

const BROWSER_ZONE_ID_BASE = 9000;
const BROWSER_ZONE_ID_LIMIT = 9999;

/**
 * Whether a zone id belongs to a browser tab rather than a room.
 *
 * Exported because anything that gives a zone something lasting — a device registered with a
 * streaming service, a process of its own — has to leave these alone: they come and go with a
 * page, and are never written to the configuration.
 */
export function isBrowserZoneId(zoneId: number): boolean {
  return zoneId >= BROWSER_ZONE_ID_BASE && zoneId <= BROWSER_ZONE_ID_LIMIT;
}

/**
 * Client-side static buffer (ms) pushed to the Sendspin player.
 *
 * This tells the *client* to play later, which absorbs jitter on its own side. It does
 * nothing for a frame the server sent too late to place — that needs the server's send lead,
 * which is separate and set in `sendspinOutput.resolveAnchorLeadUs` (a browser client id gets
 * a second there rather than the 250 ms a dedicated receiver uses).
 *
 * Both exist because browsers introduce jitter a real-time scheduler does not: garbage
 * collection, event-loop scheduling, and the pacing of the pipe feeding them.
 */
const BROWSER_SENDSPIN_LATENCY_MS = 1500;

const BROWSER_ZONE_VOLUMES = {
  default: 40,
  alarm: 80,
  fire: 100,
  bell: 60,
  buzzer: 60,
  tts: 60,
  volstep: 5,
  fading: 2,
  maxVolume: 100,
} as const;

export type BrowserZoneRecord = {
  zoneId: number;
  name: string;
  serial: string;
  registeredAt: number;
};

export type RegisterOptions = {
  name?: string;
  /** Optional MAC-like serial for grouping (sticky across reconnects). */
  serial?: string;
};

export class BrowserZoneRegistry {
  private readonly log = createLogger('Zones', 'BrowserRegistry');
  private readonly zones = new Map<number, BrowserZoneRecord>();
  private nextId = BROWSER_ZONE_ID_BASE;

  constructor(private readonly zoneManager: ZoneManagerFacade) {}

  public async register(options: RegisterOptions = {}): Promise<BrowserZoneRecord> {
    const serial = options.serial?.trim() || '';
    if (serial) {
      // Same browser identity coming back (page reload, reconnect) — return the
      // existing record so the player keeps its zoneId stable across mounts.
      for (const record of this.zones.values()) {
        if (record.serial === serial) {
          return record;
        }
      }
    }
    const zoneId = this.allocateId();
    const name = this.uniqueName(
      options.name?.trim() || `Browser ${zoneId - BROWSER_ZONE_ID_BASE + 1}`,
    );
    const finalSerial = serial || `browser-${zoneId}`;

    const cfg: ZoneConfig = {
      id: zoneId,
      name,
      sourceMac: finalSerial,
      transports: [{ id: 'sendspin', clientId: finalSerial, latencyMs: BROWSER_SENDSPIN_LATENCY_MS }],
      volumes: { ...BROWSER_ZONE_VOLUMES },
    };

    const record: BrowserZoneRecord = { zoneId, name, serial: finalSerial, registeredAt: Date.now() };
    // Publish ownership before replacing the zone. replaceZones emits the first state/snapshot
    // synchronously from the zone manager; registering afterwards lets a fresh browser zone
    // briefly look like a normal room and leak into every SSE client's zone list.
    this.zones.set(zoneId, record);
    try {
      await this.zoneManager.replaceZones([cfg]);
    } catch (error) {
      this.zones.delete(zoneId);
      throw error;
    }
    this.log.info('browser zone registered', { zoneId, name, serial: finalSerial });
    return record;
  }

  public async unregister(zoneId: number): Promise<boolean> {
    if (!this.zones.has(zoneId)) {
      return false;
    }
    try {
      await this.zoneManager.removeZone(zoneId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('removeZone failed', { zoneId, message });
    }
    this.zones.delete(zoneId);
    this.log.info('browser zone unregistered', { zoneId });
    return true;
  }

  /**
   * The client that owns a zone, or null when it is not a local destination.
   *
   * A local destination belongs to one browser: it is that person's tab, not a room in the
   * house, so it must not appear in anyone else's list or be playable from another client.
   */
  public ownerOf(zoneId: number): string | null {
    return this.zones.get(zoneId)?.serial ?? null;
  }

  public list(): BrowserZoneRecord[] {
    return Array.from(this.zones.values());
  }

  public async shutdown(): Promise<void> {
    const ids = Array.from(this.zones.keys());
    for (const id of ids) {
      await this.unregister(id);
    }
  }

  /**
   * A name no other live destination is using.
   *
   * Every tab sends the same name — a player has no way to know it is the second one — so
   * without this a room list shows four entries called "This browser" and a user cannot tell
   * which is playing. Numbering happens here rather than in the client because only the server
   * can see the others.
   */
  private uniqueName(desired: string): string {
    const taken = new Set(Array.from(this.zones.values(), (record) => record.name));
    if (!taken.has(desired)) {
      return desired;
    }
    for (let suffix = 2; suffix < 100; suffix += 1) {
      const candidate = `${desired} ${suffix}`;
      if (!taken.has(candidate)) {
        return candidate;
      }
    }
    // Beyond that something is registering in a loop; a duplicate name is the lesser problem.
    return desired;
  }

  private allocateId(): number {
    for (let attempt = 0; attempt < BROWSER_ZONE_ID_LIMIT - BROWSER_ZONE_ID_BASE + 1; attempt += 1) {
      const candidate = this.nextId;
      this.nextId = this.nextId + 1 > BROWSER_ZONE_ID_LIMIT ? BROWSER_ZONE_ID_BASE : this.nextId + 1;
      if (!this.zones.has(candidate)) {
        return candidate;
      }
    }
    throw new Error('browser zone id space exhausted');
  }
}
