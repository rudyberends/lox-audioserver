import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { createLogger } from '@/shared/logging/logger';
import { ConnectionReason, sendspinCore } from '@lox-audioserver/node-sendspin';

/**
 * WebSocket gateway for the Sendspin protocol.
 */
export class SendspinGateway {
  private readonly log = createLogger('Http', 'Sendspin');
  private readonly wsServer = new WebSocketServer({ noServer: true });
  private readonly knownClients = new Set<string>();
  private pollTimer: NodeJS.Timeout | null = null;

  constructor() {
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
    for (const session of sendspinCore.getSessions()) {
      const clientId = session.getClientId();
      if (!clientId) {
        continue;
      }
      activeClients.add(clientId);
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
  }
}
