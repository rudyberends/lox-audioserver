import { connection as WebSocketConnection } from 'websocket';
import logger from '@/utils/troxorLogger';

/**
 * Global registry of active WebSocket connections across all LoxoneHttp servers.
 */
const activeConnections: Set<WebSocketConnection> = new Set<WebSocketConnection>();

/**
 * Registers a new WebSocket connection.
 * @param connection - The WebSocket connection to register.
 */
export function registerConnection(connection: WebSocketConnection): void {
  activeConnections.add(connection);
  logger.debug(`[WebSocketManager] Registered connection. Total: ${activeConnections.size}`);
}

/**
 * Unregisters (removes) a WebSocket connection from the global set.
 * @param connection - The WebSocket connection to unregister.
 */
export function unregisterConnection(connection: WebSocketConnection): void {
  if (activeConnections.delete(connection)) {
    logger.debug(`[WebSocketManager] Connection removed. Total: ${activeConnections.size}`);
  }
}

/**
 * Broadcasts a UTF-8 message to all connected WebSocket clients.
 * Only sends to clients whose connections are still open.
 * @param message - The message string to broadcast.
 */
export function broadcastMessage(message: string): void {
  for (const conn of activeConnections) {
    if (conn.connected) {
      try {
        //logger.debug('[WebSocketManager] Outgoing message preview:', message.slice(0, 200));
        conn.sendUTF(message);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[WebSocketManager] Broadcast error: ${msg}`);
      }
    }
  }
  //logger.debug(`[WebSocketManager] Broadcasted message to ${activeConnections.size} clients.`);
}

/**
 * Gracefully closes all active WebSocket connections.
 * @param reason - Optional reason message sent to clients on close.
 */
export function closeAllConnections(reason = 'Server shutting down'): void {
  logger.info(`[WebSocketManager] Closing ${activeConnections.size} WebSocket connections...`);

  for (const conn of activeConnections) {
    try {
      conn.close(1000, reason);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[WebSocketManager] Error closing connection: ${msg}`);
    }
  }

  activeConnections.clear();
  logger.info('[WebSocketManager] All WebSocket connections closed.');
}

/**
 * Returns the number of currently active WebSocket connections.
 */
export function getConnectionCount(): number {
  return activeConnections.size;
}