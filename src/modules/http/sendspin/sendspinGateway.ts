import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { URL } from 'node:url';
import { createLogger } from '@/core/logging/logger';
import { sendspinCore } from '@/modules/http/sendspin/sendspinCore';

/**
 * WebSocket gateway for the Sendspin protocol.
 */
export class SendspinGateway {
  private readonly log = createLogger('Http', 'Sendspin');
  private readonly wsServer = new WebSocketServer({ noServer: true });

  constructor() {
    this.wsServer.on('connection', (socket, req) => {
      if (!req) return;
      const reason = this.getConnectionReason(req);
      sendspinCore.handleConnection(socket, req, reason);
    });
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
    this.wsServer.close();
  }

  private getConnectionReason(req: IncomingMessage): 'discovery' | 'playback' | 'cast-tunnel' {
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      if ((url.searchParams.get('tunnel') ?? '').toLowerCase() === 'cast') {
        return 'cast-tunnel';
      }
    } catch {
      /* ignore */
    }
    return 'discovery';
  }
}
