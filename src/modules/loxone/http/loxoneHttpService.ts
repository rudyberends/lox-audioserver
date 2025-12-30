import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  connection as WebSocketConnection,
  Message,
  server as WebSocketServer,
} from 'websocket';
import { createLogger } from '@/core/logging/logger';
import type { LoxoneHttpConfig } from '@/config/loxone';
import { LoxoneCommandProcessor, type LoxoneCommandProcessorOptions } from '@/modules/loxone/http/commandProcessor';
import { LoxoneMdnsAdvertiser } from '@/modules/loxone/http/loxoneMdnsAdvertiser';
import type { LoxoneServerOptions } from '@/modules/loxone/http/types';
import { formatCommand } from '@/modules/loxone/commands/utils/commandFormatter';
import {
  registerConnection,
  unregisterConnection,
} from '@/modules/loxone/ws/connectionRegistry';

interface ServerRuntime {
  definition: LoxoneServerOptions;
  httpServer: http.Server;
  wsServer: WebSocketServer;
}

export interface LoxoneHttpServiceOptions {
  host: string;
  onRestart?: LoxoneCommandProcessorOptions['onRestart'];
}

/**
 * Hosts both Loxone HTTP/WebSocket endpoints (app + miniserver ports).
 */
export class LoxoneHttpService {
  private readonly log = createLogger('LoxoneHttp');
  private readonly processor: LoxoneCommandProcessor;
  private readonly servers: ServerRuntime[] = [];
  private readonly mdnsAdvertiser = new LoxoneMdnsAdvertiser();

  constructor(
    private readonly config: LoxoneHttpConfig,
    private readonly options: LoxoneHttpServiceOptions,
  ) {
    this.processor = new LoxoneCommandProcessor(config, {
      onRestart: options.onRestart,
    });
  }

  public async start(): Promise<void> {
    for (const definition of this.config.servers) {
      const runtime = this.createServer(definition);
      await this.listen(runtime);
      this.servers.push(runtime);
    }

    this.advertiseMdns();

    this.log.info('loxone servers ready', {
      ports: this.config.servers.map((s) => s.port).join(', '),
    });
  }

  public async stop(): Promise<void> {
    this.mdnsAdvertiser.stop();
    for (const runtime of this.servers) {
      await new Promise<void>((resolve) => runtime.httpServer.close(() => resolve()));
      runtime.wsServer.closeAllConnections();
    }
    this.servers.length = 0;
  }

  private createServer(definition: LoxoneServerOptions): ServerRuntime {
    const log = this.log;
    const httpServer = http.createServer((req, res) => {
      this.handleHttp(definition, req, res).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        log.error('loxone http handler failed', {
          name: definition.name,
          message,
        });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'loxone-http-internal-error' }));
      });
    });

    const wsServer = new WebSocketServer({
      httpServer,
      autoAcceptConnections: true,
    });

    wsServer.on('connect', (connection) =>
      this.handleWebSocket(definition, connection),
    );

    return { definition, httpServer, wsServer };
  }

  private listen(runtime: ServerRuntime): Promise<void> {
    return new Promise((resolve, reject) => {
      runtime.httpServer
        .listen(runtime.definition.port, this.options.host, () => {
          this.log.info('loxone server listening', {
            name: runtime.definition.name,
            port: runtime.definition.port,
          });
          resolve();
        })
        .on('error', reject);
    });
  }

  private async handleHttp(
    definition: LoxoneServerOptions,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    this.log.debug('loxone http request received', {
      name: definition.name,
      method: req.method,
      url: req.url,
      remote: req.socket.remoteAddress,
    });

    const url = req.url ?? '/';
    if (req.method === 'OPTIONS') {
      this.sendOptions(res);
      return;
    }

    const body = await this.readBody(req);
    const response = await this.processor.execute(url, body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(response);

    this.log.debug('handled loxone http command', {
      name: definition.name,
      url: formatCommand(url),
    });
  }

  private handleWebSocket(
    definition: LoxoneServerOptions,
    connection: WebSocketConnection,
  ): void {
    connection.sendUTF(definition.identification);
    registerConnection(connection);

    connection.on('message', (message) =>
      this.handleWebSocketMessage(message, connection, definition),
    );

    connection.on('close', () => unregisterConnection(connection));
    connection.on('error', () => unregisterConnection(connection));
  }

  private async handleWebSocketMessage(
    message: Message,
    connection: WebSocketConnection,
    definition: LoxoneServerOptions,
  ): Promise<void> {
    if (message.type !== 'utf8') {
      return;
    }

    const command = message.utf8Data ?? '';
    this.log.spam('loxone ws message received', {
      name: definition.name,
      command: formatCommand(command),
      remote: connection.socket.remoteAddress,
    });
    try {
      const response = await this.processor.execute(command);
      connection.sendUTF(response);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log.error('ws handler error', { name: definition.name, msg });
      connection.sendUTF('');
    }
  }

  private sendOptions(res: ServerResponse): void {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
  }

  private async readBody(req: IncomingMessage): Promise<Buffer | undefined> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }

    return chunks.length ? Buffer.concat(chunks) : undefined;
  }

  private advertiseMdns(): void {
    const appServer = this.config.servers.find((server) => server.name === 'appHttp');
    if (!appServer) {
      this.log.warn('skipping mDNS advertisement; app server missing');
      return;
    }

    this.mdnsAdvertiser.publish(
      { ...this.config.mdns, port: appServer.port },
      this.options.host,
    );
  }
}
