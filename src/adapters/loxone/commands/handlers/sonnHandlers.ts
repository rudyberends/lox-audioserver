import { buildResponse } from '@/adapters/loxone/commands/responses';
import type { HandlerFn } from '@/adapters/loxone/commands/types';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { SonnCorePeerRegistry } from '@/adapters/discovery/sonnCorePeerRegistry';
import { buildAudioServersList } from '@/adapters/discovery/audioServersList';
import { createLogger } from '@/shared/logging/logger';

export interface SonnHandlerDeps {
  configPort: ConfigPort;
  sonnCorePeers: SonnCorePeerRegistry;
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
  };
}
