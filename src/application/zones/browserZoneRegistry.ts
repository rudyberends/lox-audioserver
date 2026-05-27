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

/** Client-side static buffer (ms) pushed to the Sendspin player. Browsers
 *  introduce more jitter than dedicated Sendspin receivers (GC pauses, WS
 *  scheduling, ffmpeg pacing) so we give the player a sizeable head start.
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
    const name = options.name?.trim() || `Browser ${zoneId - BROWSER_ZONE_ID_BASE + 1}`;
    const finalSerial = serial || `browser-${zoneId}`;

    const cfg: ZoneConfig = {
      id: zoneId,
      name,
      sourceMac: finalSerial,
      transports: [{ id: 'sendspin', clientId: finalSerial, latencyMs: BROWSER_SENDSPIN_LATENCY_MS }],
      volumes: { ...BROWSER_ZONE_VOLUMES },
    };

    await this.zoneManager.replaceZones([cfg]);

    const record: BrowserZoneRecord = { zoneId, name, serial: finalSerial, registeredAt: Date.now() };
    this.zones.set(zoneId, record);
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

  public list(): BrowserZoneRecord[] {
    return Array.from(this.zones.values());
  }

  public async shutdown(): Promise<void> {
    const ids = Array.from(this.zones.keys());
    for (const id of ids) {
      await this.unregister(id);
    }
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
