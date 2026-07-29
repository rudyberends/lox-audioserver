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
import { BeoremoteApiHandler } from '@/adapters/http/beoremote/beoremoteApiHandler';
import { ApiHandler } from '@/adapters/http/api/apiHandler';
import { getZoneEqualizerBands } from '@/domain/zones/equalizer';
import type { ApiEventHub } from '@/adapters/http/api/apiEventHub';
import type { ApiOutput, ApiVolumeLimits } from '@/domain/zones/apiTypes';
import { isLocalRequest } from '@/shared/utils/net';
import type { StreamProxyRoute } from '@/shared/streamProxyRoute';
import type { NotifierPort } from '@/ports/NotifierPort';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { RecentsManager } from '@/application/zones/recents/recentsManager';
import type { FavoritesManager } from '@/application/zones/favorites/favoritesManager';
import type { GroupManagerReadPort } from '@/application/groups/groupManager';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { EnginePort } from '@/ports/EnginePort';
import type { AlertFilesPort } from '@/ports/AlertFilesPort';
import type { LineInIngestRegistry } from '@/adapters/inputs/linein/lineInIngestRegistry';
import type { LineInMetadataService } from '@/adapters/inputs/linein/lineInMetadataService';
import type { LineInActivationRegistry } from '@/adapters/inputs/linein/lineInActivationRegistry';
import type { LineInActivationService } from '@/application/inputs/lineInActivationService';
import type { SendspinLineInService } from '@/adapters/inputs/linein/sendspinLineInService';
import type { MusicAssistantStreamService } from '@/adapters/inputs/musicassistant/musicAssistantStreamService';
import type { SpotifyInputService } from '@/adapters/inputs/spotify/spotifyInputService';
import type { SnapcastCore } from '@/adapters/outputs/snapcast/snapcastCore';
import type { StreamEvents } from '@/adapters/http/streams/streamEvents';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';
import type { LoxoneCommandProcessor } from '@/adapters/loxone/http/commandProcessor';
import type { ConnectionRegistry } from '@/adapters/loxone/ws/connectionRegistry';
import type { BrowserZoneRegistry } from '@/application/zones/browserZoneRegistry';
import {
  connection as WebSocketConnection,
  server as WebSocketServer,
} from 'websocket';
import type { SpotifyServiceManagerProvider } from '@/adapters/content/providers/spotifyServiceManager';
import type { CustomRadioStore } from '@/adapters/content/providers/customRadioStore';
import type { AudioManager } from '@/application/playback/audioManager';
import type { ZoneAudioPreferences } from '@/application/playback/ZoneAudioPreferences';
import type { SqueezeliteCore } from '@/adapters/outputs/squeezelite/squeezeliteCore';
import type { LmsCliServer } from '@/adapters/outputs/squeezelite/lmsCliServer';
import type { MdnsPort } from '@/ports/MdnsPort';
import type { SonnCorePeerRegistry } from '@/adapters/discovery/sonnCorePeerRegistry';
import type { MediaServer } from '@/adapters/mediaserver/mediaServer';
import type { SubsonicApi } from '@/adapters/subsonic/subsonicApi';
import type { WebdavServer } from '@/adapters/webdav/webdavServer';
import type { DlnaInputService } from '@/adapters/inputs/dlna/dlnaInputService';

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
  private readonly mediaServer?: MediaServer;
  private readonly subsonic?: SubsonicApi;
  private readonly webdav?: WebdavServer;
  private readonly dlnaInput?: DlnaInputService;
  private readonly streamProxyRoutes: StreamProxyRoute[];
  private readonly lineInIngestWs: LineInIngestWebSocket;
  private readonly lineInApi: LineInApiHandler;
  private readonly beoremoteApi: BeoremoteApiHandler;
  private readonly api: ApiHandler;
  private readonly sendspin: SendspinGateway;
  private readonly snapcast: SnapcastGateway;
  private readonly lmsCli: LmsCliServer;
  // Mutable: the Loxone command engine is attached/detached at runtime when the
  // Loxone integration is connected/disconnected, without restarting this server.
  private loxoneProcessor: LoxoneCommandProcessor | null;
  private readonly connectionRegistry: ConnectionRegistry;
  private readonly zoneManager: ZoneManagerFacade;
  private server?: http.Server;
  private eventsWsServer?: WebSocketServer;

  constructor(
    private readonly config: HttpServerConfig,
    options: {
      onReinitialize?: () => Promise<boolean>;
      onSoftRestart?: () => Promise<boolean>;
      onLoxoneToggle?: (enabled: boolean) => Promise<void>;
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
      lineInActivation: LineInActivationRegistry;
      lineInActivationService: LineInActivationService;
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
      zoneAudioPrefs: ZoneAudioPreferences;
      squeezeliteCli: LmsCliServer;
      mdnsPort: MdnsPort;
      sonnCorePeers: SonnCorePeerRegistry;
      alertFiles: AlertFilesPort;
      loxoneProcessor: LoxoneCommandProcessor | null;
      connectionRegistry: ConnectionRegistry;
      apiEventHub: ApiEventHub;
      /** Resolves which device a zone's output plays to; see ApiOutput.device. */
      resolveOutputDevice: (zoneId: number) => ApiOutput['device'] | undefined;
      /** Resolves a zone's volume cap, power-on level and step. */
      resolveVolumeLimits: (zoneId: number) => ApiVolumeLimits | undefined;
      serverVersion: string;
      browserZoneRegistry: BrowserZoneRegistry;
      streamProxyRoutes: StreamProxyRoute[];
      mediaServer?: MediaServer;
      subsonic?: SubsonicApi;
      webdav?: WebdavServer;
      dlnaInput?: DlnaInputService;
    },
  ) {
    this.lineInApi = new LineInApiHandler(
      options.configPort,
      options.lineInMetadataService,
      options.lineInActivation,
    );
    this.api = new ApiHandler({
      eventHub: options.apiEventHub,
      getAllZoneStates: () => options.zoneManager.getAllZoneStates(),
      getZoneState: (zoneId) => options.zoneManager.getZoneState(zoneId),
      handleCommand: (zoneId, command, payload) =>
        options.zoneManager.handleCommand(zoneId, command, payload),
      getOutputDevice: (zoneId) => options.resolveOutputDevice(zoneId),
      getVolumeLimits: (zoneId) => options.resolveVolumeLimits(zoneId),
      getEqualizerBands: (zoneId) => {
        const zone = options.configPort.getConfig().zones?.find((z) => z.id === zoneId);
        return zone ? [...getZoneEqualizerBands(zone)] : null;
      },
      setEqualizerBands: async (zoneId, bands) => {
        const updated = await options.zoneManager.setEqualizerBands(zoneId, bands);
        return updated ? [...updated.bands] : null;
      },
      serverVersion: options.serverVersion,
      startedAt: Date.now(),
    });
    this.beoremoteApi = new BeoremoteApiHandler({
      configPort: options.configPort,
      favorites: options.favoritesManager,
      contentManager: options.contentManager,
      zoneManager: options.zoneManager,
      lineIn: options.lineInActivationService,
    });
    this.adminApi = new AdminApiHandler({
      onReinitialize: options.onReinitialize,
      onSoftRestart: options.onSoftRestart,
      onLoxoneToggle: options.onLoxoneToggle,
      notifier: options.notifier,
      loxoneNotifier: options.loxoneNotifier,
      spotifyManagerProvider: options.spotifyManagerProvider,
      customRadioStore: options.customRadioStore,
      zoneManager: options.zoneManager,
      configPort: options.configPort,
      spotifyInputService: options.spotifyInputService,
      sendspinLineInService: options.sendspinLineInService,
      // Start/stop the DLNA advertisement to match its enabled flag, so the Access
      // toggle takes effect at runtime instead of only on the next boot.
      syncMediaServer: async () => {
        const ms = options.mediaServer;
        if (!ms) return;
        if (ms.isEnabled()) await ms.start();
        else await ms.stop();
      },
      musicAssistantStreamService: options.musicAssistantStreamService,
      // Lets the admin UI's drop zone write through the same streaming path the
      // WebDAV share uses, instead of its own base64 endpoint.
      webdav: options.webdav,
      snapcastCore: options.snapcastCore,
      squeezeliteCore: options.squeezeliteCore,
      recentsManager: options.recentsManager,
      favoritesManager: options.favoritesManager,
      groupManager: options.groupManager,
      contentManager: options.contentManager,
      audioManager: options.audioManager,
      zoneAudioPrefs: options.zoneAudioPrefs,
      mdnsPort: options.mdnsPort,
      sonnCorePeers: options.sonnCorePeers,
      alertFiles: options.alertFiles,
      browserZoneRegistry: options.browserZoneRegistry,
      lineInApi: this.lineInApi,
      beoremoteApi: this.beoremoteApi,
      httpPort: config.port,
    });
    this.music = new MusicStreamingHandler(config.musicDir);
    this.staticFiles = new StaticFileHandler(config.publicDir);
    this.audioStream = new AudioStreamHandler(
      options.engine,
      options.streamEvents,
      options.audioManager,
      options.zoneAudioPrefs,
    );
    this.audioProxy = new AudioProxyHandler(options.zoneManager);
    this.mediaServer = options.mediaServer;
    this.subsonic = options.subsonic;
    this.webdav = options.webdav;
    this.dlnaInput = options.dlnaInput;
    this.streamProxyRoutes = options.streamProxyRoutes;
    this.lineInIngestWs = new LineInIngestWebSocket(options.lineInRegistry);
    // Commands prefer the live ingest socket and fall back to the polled queue, so control latency
    // drops from the poll interval to a round trip wherever the bridge speaks WebSocket.
    options.lineInActivation.setCommandPusher((inputId, command, args) =>
      this.lineInIngestWs.sendCommand(inputId, command, args),
    );
    this.sendspin = new SendspinGateway(options.browserZoneRegistry);
    this.snapcast = new SnapcastGateway(options.snapcastCore);
    this.lmsCli = options.squeezeliteCli;
    this.loxoneProcessor = options.loxoneProcessor;
    this.connectionRegistry = options.connectionRegistry;
    this.zoneManager = options.zoneManager;
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

    // WebSocket endpoint that mirrors the Loxone audio_event broadcast on the
    // main HTTP port so the admin UI can subscribe to live zone state without
    // hitting the separate Loxone WS port (cross-origin).
    this.eventsWsServer = new WebSocketServer({
      httpServer: this.server,
      autoAcceptConnections: false,
    });
    this.eventsWsServer.on('request', (request) => {
      if (request.resourceURL.pathname !== '/audio/events') {
        return;
      }
      const connection = request.accept(null, request.origin);
      this.handleEventsConnection(connection);
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
      const server = this.server;
      this.server = undefined;
      server.close(() => resolve());
      // Force-drop keep-alive and /audio/events WebSocket connections so close()
      // resolves promptly instead of waiting on idle clients. Without this a soft
      // restart triggered over HTTP would stall on the caller's own still-open
      // socket (and any admin UI events stream); clients simply reconnect after.
      server.closeAllConnections?.();
    });
    this.sendspin.close();
    this.snapcast.close();
  }

  /** Attach or detach the Loxone command engine at runtime. With it attached, the
   *  shared :7090 gateway accepts /audio/... commands; with null it rejects them. */
  public setLoxoneProcessor(processor: LoxoneCommandProcessor | null): void {
    this.loxoneProcessor = processor;
  }

  private handleEventsConnection(connection: WebSocketConnection): void {
    this.connectionRegistry.registerConnection(connection);

    // Send initial snapshot so clients render immediately, without waiting
    // for the next zone-state mutation.
    for (const state of this.zoneManager.getAllZoneStates()) {
      try {
        connection.sendUTF(JSON.stringify({ audio_event: [state] }));
      } catch {
        break;
      }
    }

    connection.on('close', () => this.connectionRegistry.unregisterConnection(connection));
    connection.on('error', () => this.connectionRegistry.unregisterConnection(connection));
  }

  private async handleLoxoneCommand(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = req.url ?? '/';
    const command = url.replace(/^\//, '');
    // Standalone: the Loxone command dialect is disabled on the shared gateway.
    if (!this.loxoneProcessor) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'loxone-disabled' }));
      return;
    }
    try {
      const body = await this.readRequestBody(req);
      const response = await this.loxoneProcessor.execute(command, body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(response);
    } catch (err) {
      this.log.warn('loxone command dispatch failed', {
        command,
        message: err instanceof Error ? err.message : String(err),
      });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'command-failed' }));
    }
  }

  private async readRequestBody(req: IncomingMessage): Promise<Buffer | undefined> {
    if (req.method === 'GET' || req.method === 'HEAD') return undefined;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    this.applyCors(res);

    const pathname = this.normalizePath(req.url ?? '/');

    // WebDAV owns its own OPTIONS: clients read the DAV/Allow headers from it to
    // decide the mount is writable, and a bare 204 reads as "not a WebDAV share".
    if (req.method === 'OPTIONS' && !this.webdav?.matches(pathname)) {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/') {
      res.writeHead(302, { Location: '/admin/?chooser=1' });
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

    // Mirror the standard Loxone audio command surface on the main port so
    // browser clients (admin UI) can drive playback via the same routes the
    // Loxone webclient uses (audio/<zoneId>/<command>).
    if (pathname.startsWith('/audio/') || pathname === '/audio') {
      await this.handleLoxoneCommand(req, res);
      return;
    }

    if (this.audioProxy.matches(pathname)) {
      await this.audioProxy.handle(req, res);
      return;
    }

    // Per-provider stream proxies (Tidal/Deezer/Apple Music) registered by the
    // content services. These replace per-service ephemeral http.Servers; they
    // are consumed only by local ffmpeg, so reject non-local clients even though
    // the gateway binds 0.0.0.0.
    for (const route of this.streamProxyRoutes) {
      if (!route.matches(pathname)) {
        continue;
      }
      if (!isLocalRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end();
        return;
      }
      try {
        await route.handle(req, res);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn('stream proxy request failed', { pathname, message });
        if (!res.headersSent) {
          try {
            res.writeHead(500);
          } catch {
            /* ignore */
          }
        }
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      return;
    }

    // DLNA/UPnP MediaServer: serves the ContentDirectory, description/SCPD XML
    // and the zone-less `/dlna/track/<id>` stream endpoint. LAN-reachable by
    // design (renderers pull from it), so no local-only gate here.
    // Per-zone DLNA MediaRenderer inputs: SOAP control + device/SCPD XML under
    // /dlna-renderer/:zoneId/*. LAN-reachable by design (apps cast to it).
    if (this.dlnaInput?.matches(pathname)) {
      await this.dlnaInput.handle(req, res, pathname);
      return;
    }

    if (this.mediaServer?.matches(pathname)) {
      await this.mediaServer.handle(req, res, pathname);
      return;
    }

    // Subsonic API: the same content the MediaServer exposes over DLNA, served
    // as an authenticated REST surface at /rest/*. Reachable from anywhere the
    // gateway is, by design — it carries its own credential check.
    if (this.subsonic?.matches(pathname)) {
      await this.subsonic.handle(req, res, pathname);
      return;
    }

    // WebDAV share over the music library, so the folder can be mounted as a
    // network drive. Carries its own Basic-auth check, like Subsonic above.
    if (this.webdav?.matches(pathname)) {
      await this.webdav.handle(req, res, pathname);
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

    if (this.beoremoteApi.matches(pathname)) {
      await this.beoremoteApi.handle(req, res, pathname);
      return;
    }

    // The server's own public API. Deliberately last of the /api/* handlers: the
    // device-facing linein and beoremote surfaces claimed their subpaths first.
    if (ApiHandler.owns(pathname)) {
      await this.api.handle(req, res);
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
    // Let the `WebSocketServer` (attached to the same http.Server for
    // `/audio/events`) handle its own upgrades — its 'upgrade' listener is
    // registered on the same emitter and will fire alongside this one.
    // Destroying the socket here would race with the WS accept handshake.
    const pathname = this.normalizePath(req.url ?? '/');
    if (pathname === '/audio/events') {
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
