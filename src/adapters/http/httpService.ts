import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { createLogger } from '@/shared/logging/logger';
import type { HttpServerConfig } from '@/config/http';
import { AdminApiHandler } from '@/adapters/http/adminApi/adminApiHandler';
import { MusicStreamingHandler } from '@/adapters/http/music/musicStreamingHandler';
import { StaticFileHandler } from '@/adapters/http/static/staticFileHandler';
import { SendspinGateway } from '@/adapters/http/sendspin/sendspinGateway';
import { SnapcastGateway } from '@/adapters/http/snapcast/snapcastGateway';
import { AudioStreamHandler } from '@/adapters/http/streams/audioStreamHandler';
import { AudioProxyHandler } from '@/adapters/http/streams/audioProxyHandler';
import { LineInIngestWebSocket } from '@/adapters/http/streams/lineInIngestWs';
import { LineInApiHandler } from '@/adapters/http/lineInApi/lineInApiHandler';
import type { NotifierPort } from '@/ports/NotifierPort';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { RecentsManager } from '@/application/zones/recents/recentsManager';
import type { FavoritesManager } from '@/application/zones/favorites/favoritesManager';
import type { GroupManagerReadPort } from '@/application/groups/groupManager';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { EnginePort } from '@/ports/EnginePort';
import type { LineInIngestRegistry } from '@/adapters/inputs/linein/lineInIngestRegistry';
import type { LineInMetadataService } from '@/adapters/inputs/linein/lineInMetadataService';
import type { SendspinLineInService } from '@/adapters/inputs/linein/sendspinLineInService';
import type { MusicAssistantStreamService } from '@/adapters/inputs/musicassistant/musicAssistantStreamService';
import type { SpotifyInputService } from '@/adapters/inputs/spotify/spotifyInputService';
import type { SnapcastCore } from '@/adapters/outputs/snapcast/snapcastCore';
import type { StreamEvents } from '@/adapters/http/streams/streamEvents';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';
import type { SpotifyServiceManagerProvider } from '@/adapters/content/providers/spotifyServiceManager';
import type { CustomRadioStore } from '@/adapters/content/providers/customRadioStore';
import type { AudioManager } from '@/application/playback/audioManager';
import type { SqueezeliteCore } from '@/adapters/outputs/squeezelite/squeezeliteCore';
import type { LmsCliServer } from '@/adapters/outputs/squeezelite/lmsCliServer';

/**
 * Hosts the public HTTP gateway (admin UI, API stub, music streaming, Sendspin).
 */
export class HttpService {
  private readonly log = createLogger('Http');
  private readonly adminApi: AdminApiHandler;
  private readonly music: MusicStreamingHandler;
  private readonly staticFiles: StaticFileHandler;
  private readonly audioStream: AudioStreamHandler;
  private readonly audioProxy: AudioProxyHandler;
  private readonly lineInIngestWs: LineInIngestWebSocket;
  private readonly lineInApi: LineInApiHandler;
  private readonly sendspin: SendspinGateway;
  private readonly snapcast: SnapcastGateway;
  private readonly lmsCli: LmsCliServer;
  private server?: http.Server;

  constructor(
    private readonly config: HttpServerConfig,
    private readonly options: {
      onReinitialize?: () => Promise<boolean>;
      notifier: NotifierPort;
      loxoneNotifier: LoxoneWsNotifier;
      spotifyManagerProvider: SpotifyServiceManagerProvider;
      customRadioStore: CustomRadioStore;
      zoneManager: ZoneManagerFacade;
      configPort: ConfigPort;
      engine: EnginePort;
      streamEvents: StreamEvents;
      lineInRegistry: LineInIngestRegistry;
      lineInMetadataService: LineInMetadataService;
      sendspinLineInService: SendspinLineInService;
      musicAssistantStreamService: MusicAssistantStreamService;
      spotifyInputService: SpotifyInputService;
      snapcastCore: SnapcastCore;
      squeezeliteCore: SqueezeliteCore;
      recentsManager: RecentsManager;
      favoritesManager: FavoritesManager;
      groupManager: GroupManagerReadPort;
      contentManager: ContentManager;
      audioManager: AudioManager;
      squeezeliteCli: LmsCliServer;
    },
  ) {
    this.adminApi = new AdminApiHandler({
      onReinitialize: options.onReinitialize,
      notifier: options.notifier,
      loxoneNotifier: options.loxoneNotifier,
      spotifyManagerProvider: options.spotifyManagerProvider,
      customRadioStore: options.customRadioStore,
      zoneManager: options.zoneManager,
      configPort: options.configPort,
      spotifyInputService: options.spotifyInputService,
      sendspinLineInService: options.sendspinLineInService,
      musicAssistantStreamService: options.musicAssistantStreamService,
      snapcastCore: options.snapcastCore,
      squeezeliteCore: options.squeezeliteCore,
      recentsManager: options.recentsManager,
      favoritesManager: options.favoritesManager,
      groupManager: options.groupManager,
      contentManager: options.contentManager,
      audioManager: options.audioManager,
    });
    this.music = new MusicStreamingHandler(config.musicDir);
    this.staticFiles = new StaticFileHandler(config.publicDir);
    this.audioStream = new AudioStreamHandler(options.engine, options.streamEvents, options.audioManager);
    this.audioProxy = new AudioProxyHandler(options.zoneManager);
    this.lineInIngestWs = new LineInIngestWebSocket(options.lineInRegistry);
    this.lineInApi = new LineInApiHandler(options.configPort, options.lineInMetadataService);
    this.sendspin = new SendspinGateway();
    this.snapcast = new SnapcastGateway(options.snapcastCore);
    this.lmsCli = options.squeezeliteCli;
  }

  public async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log.error('http request failed', { message });
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'http-internal-error' }));
        } else {
          res.end();
        }
      });
    });

    this.server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!
        .listen(this.config.port, this.config.host, () => {
          this.log.info('http gateway listening', {
            port: this.config.port,
            host: this.config.host,
          });
          resolve();
        })
        .on('error', reject);
    });
  }

  public async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      this.server = undefined;
    });
    this.sendspin.close();
    this.snapcast.close();
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    this.applyCors(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const pathname = this.normalizePath(req.url ?? '/');

    if (pathname === '/') {
      res.writeHead(302, { Location: '/admin/' });
      res.end();
      return;
    }

    if (pathname === '/sendspin') {
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('Upgrade Required');
      return;
    }

    if (pathname === '/jsonrpc.js') {
      await this.lmsCli.handleJsonRpcRequest(req, res);
      return;
    }

    if (this.adminApi.matches(pathname)) {
      await this.adminApi.handle(req, res);
      return;
    }

    if (this.audioProxy.matches(pathname)) {
      await this.audioProxy.handle(req, res);
      return;
    }

    if (this.audioStream.matches(pathname)) {
      await this.audioStream.handle(req, res, pathname);
      return;
    }

    if (this.lineInApi.matches(pathname)) {
      await this.lineInApi.handle(req, res, pathname);
      return;
    }

    if (this.music.matches(pathname)) {
      await this.music.handle(req, res, pathname);
      return;
    }

    await this.staticFiles.handle(pathname, res);
  }

  private handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    if (this.sendspin.handleUpgrade(req, socket, head)) {
      return;
    }
    if (this.snapcast.handleUpgrade(req, socket, head)) {
      return;
    }
    if (this.lineInIngestWs.handleUpgrade(req, socket, head)) {
      return;
    }
    socket.destroy();
  }

  private applyCors(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    );
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Cache-Control', 'no-cache');
  }

  private normalizePath(url: string): string {
    const [path] = url.split('?');
    try {
      return decodeURIComponent(path || '/');
    } catch {
      return path || '/';
    }
  }
}
