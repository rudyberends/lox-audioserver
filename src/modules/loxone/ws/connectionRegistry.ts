import type { connection as WebSocketConnection } from 'websocket';
import { createLogger } from '@/core/logging/logger';

const log = createLogger('LoxoneHttp', 'WS');
const connections = new Set<WebSocketConnection>();

export function registerConnection(connection: WebSocketConnection): void {
  connections.add(connection);
  log.debug('ws connected', { total: connections.size });
}

export function unregisterConnection(connection: WebSocketConnection): void {
  if (connections.delete(connection)) {
    log.debug('ws disconnected', { total: connections.size });
  }
}

export function broadcastMessage(payload: string): void {
  for (const connection of connections) {
    if (!connection.connected) {
      continue;
    }
    try {
      connection.sendUTF(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('failed to broadcast message', { message });
    }
  }
}
