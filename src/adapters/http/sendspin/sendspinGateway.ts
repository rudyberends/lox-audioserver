import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { createLogger } from '@/shared/logging/logger';
import { ConnectionReason, GoodbyeReason, sendspinCore } from '@lox-audioserver/node-sendspin';
import type { BrowserZoneRegistry } from '@/application/zones/browserZoneRegistry';

/** Sendspin clientIds the player webapp uses are prefixed so we can recognise a
 *  browser tab (vs. a real receiver / Cast output) and give it its own zone. */
const BROWSER_CLIENT_PREFIX = 'browser-';

/** Grace period before a disconnected browser zone is torn down. A reload or
 *  app restart that reconnects with the same sticky serial within this window
 *  re-attaches to the *same* zoneId — so it doesn't churn through ids (and
 *  leave stale "Browser" zones behind) on every restart. Mirrors the reference
 *  server's CLIENT_CLEANUP_DELAY (30s). */
const BROWSER_ZONE_GRACE_MS = 30000;

/** Goodbye reasons that mean the client left on purpose — tear its zone down
 *  immediately instead of holding the grace window. Matches the reference
 *  server's IMMEDIATE_CLEANUP_REASONS. */
const IMMEDIATE_TEARDOWN_REASONS = new Set<GoodbyeReason>([
  GoodbyeReason.USER_REQUEST,
  GoodbyeReason.SHUTDOWN,
]);

/**
 * WebSocket gateway for the Sendspin protocol.
 *
 * The player webapp connects here as an ordinary Sendspin client; its arrival
 * (clientId `browser-…`) auto-registers an ephemeral browser zone and its
 * departure tears it down — so local playback needs no separate (auth'd) call.
 */
export class SendspinGateway {
  private readonly log = createLogger('Http', 'Sendspin');
  private readonly wsServer = new WebSocketServer({ noServer: true });
  private readonly knownClients = new Set<string>();
  // serial(clientId) -> zoneId for the browser zones we spun up from sessions.
  private readonly browserZones = new Map<string, number>();
  // serial -> epoch ms after which a disconnected browser zone may be reaped.
  private readonly teardownDeadlines = new Map<string, number>();
  // serials currently mid-(un)register, to avoid double work across polls.
  private readonly pendingBrowser = new Set<string>();
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(private readonly browserZoneRegistry?: BrowserZoneRegistry) {
    this.wsServer.on('connection', (socket, req) => {
      if (!req) return;
      sendspinCore.handleConnection(socket, req, ConnectionReason.DISCOVERY);
    });
    this.pollTimer = setInterval(() => this.pollConnections(), 2000);
  }

  public handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): boolean {
    const path = (request.url ?? '').split('?')[0];
    if (path !== '/sendspin') {
      return false;
    }

    this.wsServer.handleUpgrade(request, socket, head, (ws) => {
      this.wsServer.emit('connection', ws, request);
    });
    return true;
  }

  public close(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.wsServer.close();
  }

  private pollConnections(): void {
    const activeClients = new Set<string>();
    const browserNames = new Map<string, string>();
    for (const session of sendspinCore.getSessions()) {
      const clientId = session.getClientId();
      if (!clientId) {
        continue;
      }
      activeClients.add(clientId);
      if (clientId.startsWith(BROWSER_CLIENT_PREFIX)) {
        browserNames.set(clientId, session.getClientName() || '');
      }
      if (!this.knownClients.has(clientId)) {
        this.knownClients.add(clientId);
        this.log.info('sendspin client connected', {
          clientId,
          name: session.getClientName(),
          roles: session.getRoles(),
          remote: session.getRemoteAddress(),
          reason: session.getConnectionReason(),
        });
      }
    }
    for (const clientId of this.knownClients) {
      if (!activeClients.has(clientId)) {
        this.knownClients.delete(clientId);
      }
    }
    this.reconcileBrowserZones(browserNames);
  }

  /** Create a zone for each connected browser client, remove zones whose client
   *  has gone. Register/unregister are async; guard with `pendingBrowser` so a
   *  slow call isn't started twice across polls. */
  private reconcileBrowserZones(active: Map<string, string>): void {
    const registry = this.browserZoneRegistry;
    if (!registry) return;

    for (const [serial, name] of active) {
      // Client is back (or still here) — cancel any pending teardown and drop a
      // stale goodbye from a prior session so it can't trip an early teardown.
      this.teardownDeadlines.delete(serial);
      sendspinCore.takeGoodbyeReason(serial);
      if (this.browserZones.has(serial) || this.pendingBrowser.has(serial)) continue;
      this.pendingBrowser.add(serial);
      registry
        .register({ serial, name: name || undefined })
        .then((record) => {
          this.browserZones.set(serial, record.zoneId);
        })
        .catch((err) => {
          this.log.warn('browser zone auto-register failed', {
            serial,
            message: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => this.pendingBrowser.delete(serial));
    }

    const now = Date.now();
    for (const [serial, zoneId] of this.browserZones) {
      if (active.has(serial) || this.pendingBrowser.has(serial)) continue;
      const deadline = this.teardownDeadlines.get(serial);
      if (deadline === undefined) {
        // First poll that sees this client gone. An intentional leave
        // (user_request/shutdown) is reaped now; anything else (dropped socket,
        // restart) gets a grace window so a quick reconnect reuses the zone.
        const reason = sendspinCore.takeGoodbyeReason(serial);
        if (reason === null || !IMMEDIATE_TEARDOWN_REASONS.has(reason)) {
          this.teardownDeadlines.set(serial, now + BROWSER_ZONE_GRACE_MS);
          continue;
        }
      } else if (now < deadline) {
        continue;
      } else {
        this.teardownDeadlines.delete(serial);
      }
      this.pendingBrowser.add(serial);
      this.browserZones.delete(serial);
      Promise.resolve(registry.unregister(zoneId))
        .catch((err) => {
          this.log.warn('browser zone auto-unregister failed', {
            serial,
            zoneId,
            message: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => this.pendingBrowser.delete(serial));
    }
  }
}
