import { connection as WebSocketConnection } from 'websocket'; // Importing WebSocket connection type
import logger from '../utils/troxorlogger'; // Importing the custom logger for logging messages

// Global Set to hold active WebSocket connections
export const wsConnections = new Set<WebSocketConnection>();

/**
 * Adds a new WebSocket connection to the global set.
 *
 * @param {WebSocketConnection} connection - The WebSocket connection to add.
 */
export const addWebSocketConnection = (connection: WebSocketConnection) => {
  wsConnections.add(connection); // Add the connection to the set
};

/**
 * Removes a WebSocket connection from the global set.
 *
 * @param {WebSocketConnection} connection - The WebSocket connection to remove.
 */
export const removeWebSocketConnection = (connection: WebSocketConnection) => {
  wsConnections.delete(connection); // Remove the connection from the set
};

/**
 * Broadcasts an event message to all connected WebSocket clients.
 * Each client will receive the event message if their connection is still active.
 *
 * @param {string} eventMessage - The message to send to all connected clients.
 */
export const broadcastEvent = (eventMessage: any) => {
  wsConnections.forEach((connection) => {
    if (connection.connected) {
      // Check if the connection is still active
      connection.sendUTF(eventMessage); // Send the event message to the client
    }
  });
  logger.debug(`Broadcasted event: ${eventMessage}`); // Log the broadcast event
};
