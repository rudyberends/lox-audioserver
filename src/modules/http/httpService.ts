import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { createLogger } from '@/core/logging/logger';
import type { HttpServerConfig } from '@/config/http';
import { AdminApiHandler } from '@/modules/http/adminApi/adminApiHandler';
import { MusicStreamingHandler } from '@/modules/http/music/musicStreamingHandler';
import { StaticFileHandler } from '@/modules/http/static/staticFileHandler';
import { SendspinGateway } from '@/modules/http/sendspin/sendspinGateway';
import { sendspinClientConnector } from '@/modules/http/sendspin/sendspinClientConnector';
import { SnapcastGateway } from '@/modules/http/snapcast/snapcastGateway';
import { AudioStreamHandler } from '@/modules/http/streams/audioStreamHandler';
import { AudioProxyHandler } from '@/modules/http/streams/audioProxyHandler';
import { LineInIngestWebSocket } from '@/modules/http/streams/lineInIngestWs';
import { LineInIngestTcp } from '@/modules/http/streams/lineInIngestTcp';
import { getSystemConfig } from '@/domain/config/configStore';
import { networkInterfaces } from 'node:os';

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
  private readonly lineInIngestTcp: LineInIngestTcp;
  private readonly sendspin = new SendspinGateway();
  private readonly snapcast = new SnapcastGateway();
  private server?: http.Server;
  private stopMdnsAdvert?: () => void;

  constructor(
    private readonly config: HttpServerConfig,
    private readonly options: { onReinitialize?: () => Promise<boolean> } = {},
  ) {
    this.adminApi = new AdminApiHandler({ onReinitialize: options.onReinitialize });
    this.music = new MusicStreamingHandler(config.musicDir);
    this.staticFiles = new StaticFileHandler(config.publicDir);
    this.audioStream = new AudioStreamHandler();
    this.audioProxy = new AudioProxyHandler();
    this.lineInIngestWs = new LineInIngestWebSocket();
    this.lineInIngestTcp = new LineInIngestTcp();
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
          this.advertiseSendspinMdns();
          resolve();
        })
        .on('error', reject);
    });
    await this.lineInIngestTcp.start();
  }

  public async stop(): Promise<void> {
    if (this.stopMdnsAdvert) {
      this.stopMdnsAdvert();
      this.stopMdnsAdvert = undefined;
    }
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      this.server = undefined;
    });
    await this.lineInIngestTcp.stop();
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

  private advertiseSendspinMdns(): void {
    const systemName = getSystemConfig()?.audioserver?.name || 'Lox Audio Server';
    const host =
      this.config.host && this.config.host !== '0.0.0.0' ? this.config.host : this.pickLocalAddress();
    const mdnsHost = host === '0.0.0.0' ? undefined : host;
    sendspinClientConnector.advertiseServer({
      port: this.config.port,
      host: mdnsHost,
      path: '/sendspin',
      name: systemName,
    });
    this.stopMdnsAdvert = () => sendspinClientConnector.stopAdvertising();
  }

  private pickLocalAddress(): string {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal && net.address) {
          return net.address;
        }
      }
    }
    return '0.0.0.0';
  }
}
