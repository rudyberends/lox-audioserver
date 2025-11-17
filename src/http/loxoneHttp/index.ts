import * as http from 'node:http';
import {
  server as WebSocketServer,
  connection as WebSocketConnection,
  Message,
} from 'websocket';
import logger from '@/utils/troxorLogger';
import { handleLoxoneCommand } from './handlers/requestHandler';
import {
  registerConnection,
  unregisterConnection,
  closeAllConnections,
} from './websocketManager';
import { formatLoxoneCommandForLog } from './utils/loxoneCommandLogFormatter';

/**
 * Represents a single Loxone HTTP + WebSocket server instance.
 */
interface ServerInstance {
  http: http.Server;
  ws: WebSocketServer;
  name: 'appHttp' | 'msHttp';
}

/**
 * Loxone HTTP + WebSocket emulation layer.
 * Simulates a real Loxone AudioServer API endpoint on ports 7091 and 7095.
 */
export class LoxoneHttp {
  private readonly ports: [7091, 7095] = [7091, 7095];
  private readonly servers: ServerInstance[] = [];

  // Static protocol identity
  private readonly macId = '504F94FF1BB3';
  private readonly version = 'LWSS V 16.1.10.01';
  private readonly api = '~API:1.6~';
  private readonly sessionToken = '8WahwAfULwEQce9Yu0qIE9L7QMkXFHbi0M9ch9vKcgYArPPojXHpSiNcq0fT3lqL';

  constructor() {
    this.start().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[LoxoneHttp] Failed to start: ${message}`);
    });
  }

  /**
   * Starts both HTTP and WebSocket servers on the Loxone ports.
   */
  private async start(): Promise<void> {
    for (const port of this.ports) {
      const name: 'appHttp' | 'msHttp' = port === 7091 ? 'appHttp' : 'msHttp';

      const httpServer: http.Server = http.createServer(
        (req: http.IncomingMessage, res: http.ServerResponse): void => {
          this.handleHttp(req, res, name).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            logger.error(`[LoxoneHttp][${name}] HTTP handler failed: ${message}`);
          });
        },
      );

      const wsServer: WebSocketServer = new WebSocketServer({
        httpServer,
        autoAcceptConnections: true,
      });

      wsServer.on('connect', (conn: WebSocketConnection): void => {
        this.handleWsConnect(conn, name);
      });

      await new Promise<void>((resolve, reject) => {
        httpServer
          .listen(port, (): void => {
            logger.info(`[LoxoneHttp][${name}] Listening on port ${port}`);
            if (name === 'appHttp') {
              //startServerHeartbeat(); Nog nodig??
            }
            resolve();
          })
          .on('error', (err: Error): void => reject(err));
      });

      this.servers.push({ http: httpServer, ws: wsServer, name });
    }

    logger.info('[LoxoneHttp] Loxone Http API server active.');
  }

  /**
   * Handles HTTP requests directed to the Loxone API.
   */
  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse, name: 'appHttp' | 'msHttp' ): Promise<void> {
    const url = req.url ?? '';
    logger.info(`[LoxoneHttp][${name}] HTTP ${req.method} request: ${formatLoxoneCommandForLog(url)}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    try {
      const data = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
      });

      const response = await this.handleRequest(url, name, data);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[LoxoneHttp][${name}] Error processing request ${url}: ${message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    }
  }

  /**
   * Handles a single Loxone API command (used by HTTP and WS).
   */
  private async handleRequest(url: string, name: 'appHttp' | 'msHttp', data?: Buffer,
  ): Promise<string> {
    const normalized = url.trim().replace(/^\/+/, '');
    logger.debug(`[LoxoneHttp][${name}] Command: ${formatLoxoneCommandForLog(normalized)}`);
    return handleLoxoneCommand(normalized, data);
  }

  // ---------------------------------------------------------------------------
  // WebSocket handling
  // ---------------------------------------------------------------------------

  private handleWsConnect(
    conn: WebSocketConnection,
    name: 'appHttp' | 'msHttp',
  ): void {
    registerConnection(conn);
    logger.debug(
      `[LoxoneHttp][${name}] WebSocket connected from ${conn.remoteAddress ?? 'unknown'}`,
    );

    conn.sendUTF(this.getApiIdentificationString(name));

    conn.on('message', (msg: Message): void => {
      this.handleWsMessage(msg, name, conn).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[LoxoneHttp][${name}] WS message handler failed: ${message}`);
      });
    });

    conn.on('close', (code: number, desc: string): void => {
      this.handleWsClose(code, desc, name, conn);
    });

    conn.on('error', (err: Error): void => {
      logger.error(`[LoxoneHttp][${name}] WS error: ${err.message}`);
    });
  }

  private async handleWsMessage(
    message: Message,
    name: 'appHttp' | 'msHttp',
    conn: WebSocketConnection,
  ): Promise<void> {
    if (message.type !== 'utf8') {
      return;
    }

    const command = message.utf8Data ?? '';
    logger.debug(`[LoxoneHttp][${name}] WS message: ${formatLoxoneCommandForLog(command)}`);

    try {
      const response = await this.handleRequest(command, name);
      conn.sendUTF(response || '');
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[LoxoneHttp][${name}] WS error: ${msg}`);
      conn.sendUTF('');
    }
  }

  private handleWsClose(
    code: number,
    desc: string,
    name: 'appHttp' | 'msHttp',
    conn: WebSocketConnection,
  ): void {
    unregisterConnection(conn);
    logger.debug(`[LoxoneHttp][${name}] WS closed (${code}: ${desc})`);
  }

  /**
   * Builds the Loxone-style identification string per connection.
   */
  private getApiIdentificationString(name: 'appHttp' | 'msHttp'): string {
    const map: Record<'appHttp' | 'msHttp', string> = {
      appHttp: `${this.version} | ${this.api} | Session-Token: ${this.sessionToken}`,
      msHttp: `MINISERVER V ${this.version} ${this.macId} | ${this.api} | Session-Token: ${this.sessionToken}`,
    };
    return map[name];
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Gracefully shuts down all active HTTP and WebSocket servers.
   */
  public async shutdown(): Promise<void> {
    logger.info('[LoxoneHttp] Shutting down...');
    closeAllConnections('Server shutting down');

    for (const { http: srv, name } of this.servers) {
      await new Promise<void>((resolve) => {
        srv.close((err?: Error): void => {
          if (err) {
            logger.error(`[LoxoneHttp][${name}] Error on shutdown: ${err.message}`);
          }
          resolve();
        });
      });
    }

    logger.info('[LoxoneHttp] Shutdown complete.');
  }
}