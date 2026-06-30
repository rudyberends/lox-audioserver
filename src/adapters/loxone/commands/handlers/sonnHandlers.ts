import { buildResponse } from '@/adapters/loxone/commands/responses';
import type { HandlerFn } from '@/adapters/loxone/commands/types';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { SonnCorePeerRegistry } from '@/adapters/discovery/sonnCorePeerRegistry';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import { buildAudioServersList } from '@/adapters/discovery/audioServersList';
import { createLogger } from '@/shared/logging/logger';

export interface SonnHandlerDeps {
  configPort: ConfigPort;
  sonnCorePeers: SonnCorePeerRegistry;
  zoneManager: ZoneManagerFacade;
}

/**
 * sonn-core command extensions. These deliberately live OUTSIDE the official
 * Loxone command namespace (`audio/*`, `secure/*`) under a dedicated `sonn/*`
 * prefix, so it is explicit on the wire that they are additions of our stack and
 * not part of the Loxone API. A real Loxone audioserver does not answer them;
 * clients that probe over the control WS fall back accordingly.
 */
export function createSonnHandlers(deps: SonnHandlerDeps) {
  const log = createLogger('Loxone', 'SonnHandlers');

  return {
    /**
     * sonn/audioservers — the list of audioservers this server knows about (self
     * + peers from the Miniserver config, enriched with the mDNS peer registry).
     * Mirrors the admin HTTP route GET /admin/api/audioservers so the player can
     * fetch it over its existing control WebSocket instead of a cross-origin HTTP
     * call to the serving origin.
     */
    audioServers: ((command) => {
      try {
        const list = buildAudioServersList(deps.configPort, deps.sonnCorePeers);
        return buildResponse(command, 'audioservers', list);
      } catch (err) {
        log.warn('sonn/audioservers failed', { err });
        return buildResponse(command, 'audioservers', { self: null, servers: [] });
      }
    }) satisfies HandlerFn,

    /**
     * sonn/handoff/<sourceZoneId>/<targetZoneId> — atomically transfer playback
     * (queue + current track + position) from the source zone to the target, then
     * stop and clear the source. Server-side so the queue/position move exactly,
     * unlike a client-side rebuild.
     */
    handoff: (async (command) => {
      const parts = command.split('/');
      const sourceId = Number(parts[2]);
      const targetId = Number(parts[3]);
      if (!Number.isFinite(sourceId) || !Number.isFinite(targetId)) {
        return buildResponse(command, 'handoff', { ok: false, error: 'invalid-zones' });
      }
      try {
        const ok = await deps.zoneManager.handoff(sourceId, targetId);
        return buildResponse(command, 'handoff', { ok });
      } catch (err) {
        log.warn('sonn/handoff failed', { err });
        return buildResponse(command, 'handoff', { ok: false });
      }
    }) satisfies HandlerFn,
  };
}
