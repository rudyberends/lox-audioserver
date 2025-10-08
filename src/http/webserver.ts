import { addWebSocketConnection, removeWebSocketConnection, wsConnections } from './broadcastEvent'; // Import functions and Set for managing WebSocket connections
import { server as WebSocketServer, connection as WebSocketConnection } from 'websocket'; // Importing WebSocket server and connection types
import { handleLoxoneCommand } from './handlers/requesthandler';
import { corsProxy } from './corsProxy'; // Import the CORS proxy function
import { config } from '../config/config'; // Import config from the configuration module
import logger from '../utils/troxorlogger'; // Importing the custom logger for logging messages
import * as http from 'http'; // Importing the HTTP module for server creation
import { handleConfigRequest } from './configHttp';
import { summariseLoxoneCommand } from './utils/requestSummary';

/**
 * Handles incoming HTTP requests.
 *
 * @param {http.IncomingMessage} req - The incoming HTTP request.
 * @param {http.ServerResponse} res - The response object to send back to the client.
 * @param {string} name - The name of the server instance for logging purposes.
 */
const handleHttpRequest = async (req: http.IncomingMessage, res: http.ServerResponse, name: string) => {
  const url = req.url || ''; // Get the requested URL

  if (await handleConfigRequest(req, res)) {
    return;
  }

  // Check if the request is for CORS proxying
  if (url.startsWith('/cors-proxy')) {
    await corsProxy(res, url); // Handle CORS proxy request
    return; // Exit after serving the resource
  }

  try {
    const response = await handleRequest(url, name); // Handle the request and get the response
    sendHttpResponse(res, 200, response); // Send success response
  } catch (error) {
    logger.error(`[HTTP] Unexpected error processing request for ${url}: ${error}`);
    sendHttpResponse(res, 500, JSON.stringify({ error: 'Internal Server Error' })); // Send a generic error response
  }
};

/**
 * Sends an HTTP response with the specified status and data.
 *
 * @param {http.ServerResponse} res - The response object to send back to the client.
 * @param {number} statusCode - The HTTP status code.
 * @param {string} data - The response data.
 */
const sendHttpResponse = (res: http.ServerResponse, statusCode: number, data: string) => {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(data); // End the response with the content
};

/**
 * Handles incoming requests for both HTTP and WebSocket connections based on the server name.
 *
 * @param {string} url - The requested URL.
 * @param {string} name - The name of the server instance for logging purposes.
 * @returns {string} The response data.
 * @throws {Error} If the request cannot be processed.
 */
const handleRequest = async (url: string, name: string): Promise<string> => {
  const normalizedUrl = url.trim().replace(/^\/+/, '');
  logger.info(`[${name}] Handling request: ${summariseLoxoneCommand(normalizedUrl)}`);
  const response = await handleLoxoneCommand!(normalizedUrl); // Type is now HandlerResponse

  try {
    const parsed = JSON.parse(response);
    if (parsed?.command) {
      //logger.info(`[${name}] Processing request for URL: ${parsed.command}`);
      return response;
    }
  } catch {
    // Ignore JSON parse errors and fall back to original URL
  }

  //logger.info(`[${name}] Processing request for URL: ${url}`);
  return response;
};

/**
 * Starts the HTTP and WebSocket servers.
 *
 * @param {number} port - The port on which the server should listen.
 * @param {string} name - The name of the server instance for logging purposes.
 * @returns {{ shutdown: Function }} An object containing the shutdown function for external use.
 */
export const startWebServer = (port: number, name: string): { shutdown: () => Promise<void> } => {
  const httpServer = http.createServer((req, res) => {
    void handleHttpRequest(req, res, name);
  }); // Use the HTTP request handler
  const wsServer = new WebSocketServer({ httpServer, autoAcceptConnections: true }); // Create a WebSocket server

  // Setup WebSocket connection handling
  wsServer.on('connect', (connection: WebSocketConnection) => handleWebSocketConnect(connection, name)); // Handle new WebSocket connections

  // Start listening on the given port
  httpServer.listen(port, () => logger.info(`[${name}] HTTP and WebSocket server is listening on port ${port}`)); // Log server listening status

  // Return an object containing the shutdown function for external use
  return { shutdown: () => shutdownServer(httpServer, name) };
};

/**
 * Handles WebSocket connection.
 *
 * @param {WebSocketConnection} connection - The WebSocket connection object.
 * @param {string} name - The name of the server instance for logging purposes.
 */
const handleWebSocketConnect = (connection: WebSocketConnection, name: string) => {
  addWebSocketConnection(connection); // Add the new connection to the global Set

  logger.info(`[${name}] WebSocket connection accepted from ${connection.remoteAddress}. Current connections: ${wsConnections.size}`);

  // Send identification string to the client
  connection.sendUTF(getApiIdentificationString(name));

  // Handle incoming WebSocket messages
  connection.on('message', (message) => {
    void handleWebSocketRequest(message, name, connection);
  }); // Use the WebSocket request handler

  // Handle connection closure
  connection.on('close', (reasonCode, description) => handleWebSocketClose(reasonCode, description, name, connection));

  // Log errors if any
  connection.on('error', (error) => logger.error(`[${name}] WebSocket error: ${error.message}`)); // Log WebSocket errors
};

/**
 * Handles incoming WebSocket messages.
 *
 * @param {any} message - The incoming message from the WebSocket connection.
 * @param {string} name - The name of the server instance for logging purposes.
 * @param {WebSocketConnection} connection - The WebSocket connection object.
 */
const handleWebSocketRequest = async (message: any, name: string, connection: WebSocketConnection) => {
  if (message.type === 'utf8') {
    const url = message.utf8Data; // Get the message data
    //logger.info(`[${name}] Received message: ${summariseLoxoneCommand(url)}`); // Log received message

    try {
      const response = await handleRequest(url, name); // Handle the request and get the response
      connection.sendUTF(response || ''); // Send the response back to the client
    } catch (error) {
      logger.error(`[${name}] Error handling WebSocket request: ${error}`);
      connection.sendUTF('');
    }
  } else {
    logger.error(`[${name}] Unknown message type: ${message.type}`); // Log unknown message type
  }
};

/**
 * Handles WebSocket connection closure.
 *
 * @param {number} reasonCode - The reason for connection closure.
 * @param {string} description - Description of the closure reason.
 * @param {string} name - The name of the server instance for logging purposes.
 * @param {WebSocketConnection} connection - The WebSocket connection object.
 */
const handleWebSocketClose = (reasonCode: number, description: string, name: string, connection: WebSocketConnection) => {
  logger.info(`[${name}] WebSocket connection closed. Reason: ${reasonCode} - ${description}`); // Log connection closure
  removeWebSocketConnection(connection); // Remove the closed connection from the Set
  logger.info(`[${name}] Current connections: ${wsConnections.size}`); // Log current connections
};

/**
 * Generates an API identification string based on the server instance name.
 *
 * @param {string} name - The name of the server instance.
 * @returns {string} The API identification string for the server instance.
 */
const getApiIdentificationString = (name: string): string => {
  //LWSS V 15.2.09.27 | ~API:1.6~ | Session-Token: 51Gw9ZjGWLqOqyz8DpizfhDKRQ0I7DdL9z8dnsStEBUVoSzbc2WiWWqndvPSLda3
  //const serverIdentificationString = 'LWSS V 2.3.9.2'; // Common server identification part
  //const serverIdentificationString = 'LWSS V 15.2.09.27'; // Common server identification part
  const serverIdentificationString = 'LWSS V 16.1.10.01'; // Common server identification part
  const apiIdentificationString = '~API:1.6~'; // Common API identification part
  const sessionToken = '8WahwAfULwEQce9Yu0qIE9L7QMkXFHbi0M9ch9vKcgYArPPojXHpSiNcq0fT3lqL'; // Hardcoded session token


  // Identification strings based on instance name
  const identificationStrings: { [key: string]: string } = {
    'AppHttp': `${serverIdentificationString} | ${apiIdentificationString} | Session-Token: ${sessionToken}`,
    'msHttp': `MINISERVER V ${serverIdentificationString} ${config.audioserver?.macID} | ${apiIdentificationString} | Session-Token: ${sessionToken}`,
  };

  return identificationStrings[name] || ''; // Return the corresponding identification string or an empty string if not found
};

/**
 * Gracefully shuts down the server.
 *
 * @param {http.Server} httpServer - The HTTP server instance to close.
 * @param {string} name - The name of the server instance for logging purposes.
 */
const shutdownServer = (httpServer: http.Server, name: string): Promise<void> => {
  logger.info(`[${name}] Shutting down server...`); // Log shutdown initiation
  wsConnections.forEach((conn: WebSocketConnection) =>
    conn.close(1000, 'Server shutting down'),
  );

  return new Promise((resolve) => {
    httpServer.close((err) => {
      if (err) {
        logger.error(`[${name}] Error shutting down server: ${err}`);
      } else {
        logger.info(`[${name}] Server shut down successfully.`);
      }
      resolve();
    });
  });
};
