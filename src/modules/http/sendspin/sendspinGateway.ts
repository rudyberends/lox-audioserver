import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
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
      sendspinCore.handleConnection(socket, req, 'discovery');
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

}
