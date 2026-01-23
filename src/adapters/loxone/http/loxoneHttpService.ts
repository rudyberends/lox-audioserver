import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  connection as WebSocketConnection,
  Message,
  server as WebSocketServer,
} from 'websocket';
import { createLogger } from '@/shared/logging/logger';
import type { LoxoneHttpConfig } from '@/config/loxone';
import { LoxoneCommandProcessor, type LoxoneCommandProcessorOptions } from '@/adapters/loxone/http/commandProcessor';
import { LoxoneUdpDiscovery } from '@/adapters/loxone/http/loxoneUdpDiscovery';
import type { LoxoneServerOptions } from '@/adapters/loxone/http/types';
import { formatCommand } from '@/adapters/loxone/commands/utils/commandFormatter';
import type { ConnectionRegistry } from '@/adapters/loxone/ws/connectionRegistry';
import type { ServerHeartbeat } from '@/adapters/loxone/ws/serverHeartbeat';
import type { NotifierPort } from '@/ports/NotifierPort';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { RecentsManager } from '@/application/zones/recents/recentsManager';
import type { FavoritesManager } from '@/application/zones/favorites/favoritesManager';
import type { GroupManager } from '@/application/groups/groupManager';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { LineInIngestRegistry } from '@/adapters/inputs/linein/lineInIngestRegistry';
import type { SendspinLineInService } from '@/adapters/inputs/linein/sendspinLineInService';
import type { SpotifyInputService } from '@/adapters/inputs/spotify/spotifyInputService';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';
import type { LoxoneConfigService } from '@/adapters/loxone/services/loxoneConfigService';

interface ServerRuntime {
  definition: LoxoneServerOptions;
  httpServer: http.Server;
  wsServer: WebSocketServer;
}

export interface LoxoneHttpServiceOptions {
  host: string;
  onRestart?: LoxoneCommandProcessorOptions['onRestart'];
  notifier: NotifierPort;
  loxoneNotifier: LoxoneWsNotifier;
  configService: LoxoneConfigService;
  connectionRegistry: ConnectionRegistry;
  serverHeartbeat: ServerHeartbeat;
  zoneManager: ZoneManagerFacade;
  configPort: ConfigPort;
  lineInRegistry: LineInIngestRegistry;
  sendspinLineInService: SendspinLineInService;
  spotifyInputService: SpotifyInputService;
  recentsManager: RecentsManager;
  favoritesManager: FavoritesManager;
  groupManager: GroupManager;
  contentManager: ContentManager;
}

/**
 * Hosts both Loxone HTTP/WebSocket endpoints (app + miniserver ports).
 */
export class LoxoneHttpService {
  private readonly log = createLogger('LoxoneHttp');
  private readonly processor: LoxoneCommandProcessor;
  private readonly servers: ServerRuntime[] = [];
  private readonly udpDiscovery = new LoxoneUdpDiscovery();

  constructor(
    private readonly config: LoxoneHttpConfig,
    private readonly options: LoxoneHttpServiceOptions,
  ) {
    this.processor = new LoxoneCommandProcessor(config, {
      onRestart: options.onRestart,
      notifier: options.notifier,
      loxoneNotifier: options.loxoneNotifier,
      configService: options.configService,
      zoneManager: options.zoneManager,
      configPort: options.configPort,
      lineInRegistry: options.lineInRegistry,
      sendspinLineInService: options.sendspinLineInService,
      spotifyInputService: options.spotifyInputService,
      recentsManager: options.recentsManager,
      favoritesManager: options.favoritesManager,
      groupManager: options.groupManager,
      contentManager: options.contentManager,
    });
  }

  public async start(): Promise<void> {
    for (const definition of this.config.servers) {
      const runtime = this.createServer(definition);
      await this.listen(runtime);
      this.servers.push(runtime);
    }

    this.udpDiscovery.start(this.config, this.options.configPort);

    this.log.info('loxone servers ready', {
      ports: this.config.servers.map((s) => s.port).join(', '),
    });
  }

  public async stop(): Promise<void> {
    this.udpDiscovery.stop();
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
    this.options.connectionRegistry.registerConnection(connection);
    if (definition.name === 'msHttp') {
      this.options.serverHeartbeat.emit(this.options.configPort);
    }

    connection.on('message', (message) =>
      this.handleWebSocketMessage(message, connection, definition),
    );

    connection.on('close', () => this.options.connectionRegistry.unregisterConnection(connection));
    connection.on('error', () => this.options.connectionRegistry.unregisterConnection(connection));
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
}
