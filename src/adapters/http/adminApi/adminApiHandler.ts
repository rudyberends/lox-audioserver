import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import https from 'node:https';
import { createLogger } from '@/shared/logging/logger';
import { defaultMacId } from '@/shared/utils/mac';
import { defaultLocalIp } from '@/shared/utils/net';
import type { NotifierPort } from '@/ports/NotifierPort';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { SpotifyInputService } from '@/adapters/inputs/spotify/spotifyInputService';
import type { AudioServerConfig, ZoneTransportConfig } from '@/domain/config/types';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';
import type { SendspinLineInService } from '@/adapters/inputs/linein/sendspinLineInService';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { MusicAssistantStreamService } from '@/adapters/inputs/musicassistant/musicAssistantStreamService';
import { MusicAssistantApi } from '@/shared/musicassistant/musicAssistantApi';
import type { FavoritesManager } from '@/application/zones/favorites/favoritesManager';
import type { RecentsManager } from '@/application/zones/recents/recentsManager';
import type { CustomRadioStore } from '@/adapters/content/providers/customRadioStore';
import type { GroupManagerReadPort } from '@/application/groups/groupManager';
import type { AudioManager } from '@/application/playback/audioManager';
import { loadConfig as loadRuntimeConfig } from '@/config';
import type { SnapcastCore } from '@/adapters/outputs/snapcast/snapcastCore';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { SpotifyServiceManagerProvider } from '@/adapters/content/providers/spotifyServiceManager';
import type { SqueezeliteCore } from '@/adapters/outputs/squeezelite/squeezeliteCore';
import type { MdnsPort } from '@/ports/MdnsPort';

type AdminApiOptions = {
  onReinitialize?: () => Promise<boolean>;
  notifier: NotifierPort;
  loxoneNotifier: LoxoneWsNotifier;
  spotifyManagerProvider: SpotifyServiceManagerProvider;
  customRadioStore: CustomRadioStore;
  zoneManager: ZoneManagerFacade;
  configPort: ConfigPort;
  spotifyInputService: SpotifyInputService;
  sendspinLineInService: SendspinLineInService;
  musicAssistantStreamService: MusicAssistantStreamService;
  snapcastCore: SnapcastCore;
  squeezeliteCore: SqueezeliteCore;
  recentsManager: RecentsManager;
  favoritesManager: FavoritesManager;
  groupManager: GroupManagerReadPort;
  contentManager: ContentManager;
  audioManager: AudioManager;
  mdnsPort: MdnsPort;
};

import type { Route } from '@/adapters/http/adminApi/routeTypes';
import {
  AdminSessionStore,
  isPublicAdminApiRoute,
} from '@/adapters/http/adminApi/auth/adminSessionStore';
import { MiniserverAuthClient } from '@/adapters/http/adminApi/auth/miniserverAuthClient';
import { buildAuthRoutes } from '@/adapters/http/adminApi/auth/authHandlers';
import { buildAppleMusicRoutes } from '@/adapters/http/adminApi/applemusic/appleMusicHandlers';
import { buildAlertsRoutes } from '@/adapters/http/adminApi/alerts/alertsHandlers';
import { buildTransportsRoutes } from '@/adapters/http/adminApi/transports/transportsHandlers';
import { buildContentRoutes } from '@/adapters/http/adminApi/content/contentHandlers';
import {
  buildZonesRoutes,
  STATE_CONTROLLER_DEFINITIONS,
} from '@/adapters/http/adminApi/zones/zonesHandlers';
import { buildSpotifyRoutes } from '@/adapters/http/adminApi/spotify/spotifyHandlers';
import { buildMiscRoutes } from '@/adapters/http/adminApi/misc/miscHandlers';
import { buildConfigRoutes } from '@/adapters/http/adminApi/config/configHandlers';

export type AdminSqueezelitePlayerSnapshot = {
  mac: string | null;
  name: string | null;
  connected: boolean;
};

type SqueezelitePlayerLike = {
  playerId?: string | null;
  name?: string | null;
};

export function buildSqueezeliteAdminPlayerSnapshot(
  output: ZoneTransportConfig | null | undefined,
  players: SqueezelitePlayerLike[],
): AdminSqueezelitePlayerSnapshot | undefined {
  const outputId = stringValue(output?.id).toLowerCase();
  if (outputId !== 'squeezelite') {
    return undefined;
  }
  const configuredPlayerId = stringValue((output as { playerId?: unknown }).playerId);
  const configuredPlayerName = stringValue((output as { playerName?: unknown }).playerName);
  const normalizedPlayerId = normalizeSqueezelitePlayerId(configuredPlayerId);
  const normalizedPlayerName = normalizeSqueezelitePlayerName(configuredPlayerName);
  const player =
    players.find((entry) => {
      if (normalizedPlayerId) {
        return normalizeSqueezelitePlayerId(entry.playerId) === normalizedPlayerId;
      }
      if (normalizedPlayerName) {
        return normalizeSqueezelitePlayerName(entry.name) === normalizedPlayerName;
      }
      return false;
    }) ?? (!normalizedPlayerId && !normalizedPlayerName && players.length === 1 ? players[0] : null);
  return {
    mac: formatSqueezeliteMac(player?.playerId) ?? formatSqueezeliteMac(configuredPlayerId),
    name: stringValue(player?.name) || configuredPlayerName || null,
    connected: Boolean(player),
  };
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSqueezelitePlayerId(value: unknown): string {
  return stringValue(value).replace(/[^a-f0-9]/gi, '').toLowerCase();
}

function normalizeSqueezelitePlayerName(value: unknown): string {
  return stringValue(value).toLowerCase();
}

function formatSqueezeliteMac(value: unknown): string | null {
  const normalized = normalizeSqueezelitePlayerId(value);
  if (normalized.length !== 12) {
    return null;
  }
  return normalized
    .match(/.{2}/g)!
    .join(':')
    .toUpperCase();
}

const MAX_JSON_BODY_BYTES = 1 * 1024 * 1024;
/**
 * Temporary admin API stub that returns 501 for every endpoint.
 */
export class AdminApiHandler {
  private readonly log = createLogger('Http', 'AdminApi');
  private readonly runtimeConfig = loadRuntimeConfig();
  private readonly onReinitialize?: () => Promise<boolean>;
  private readonly notifier: NotifierPort;
  private readonly loxoneNotifier: LoxoneWsNotifier;
  private readonly spotifyManagerProvider: SpotifyServiceManagerProvider;
  private readonly customRadioStore: CustomRadioStore;
  private readonly zoneManager: ZoneManagerFacade;
  private readonly configPort: ConfigPort;
  private readonly spotifyInputService: SpotifyInputService;
  private readonly sendspinLineInService: SendspinLineInService;
  private readonly musicAssistantStreamService: MusicAssistantStreamService;
  private readonly snapcastCore: SnapcastCore;
  private readonly squeezeliteCore: SqueezeliteCore;
  private readonly recentsManager: RecentsManager;
  private readonly favoritesManager: FavoritesManager;
  private readonly groupManager: GroupManagerReadPort;
  private readonly contentManager: ContentManager;
  private readonly audioManager: AudioManager;
  private readonly mdns: MdnsPort;
  private clockOffsetCache: { offsetMs: number | null; sampledAt: number } = { offsetMs: null, sampledAt: 0 };
  private clockOffsetFailureLog: { message: string | null; loggedAt: number } = { message: null, loggedAt: 0 };
  private readonly routes: Route[];
  private readonly sessionStore = new AdminSessionStore();
  private readonly miniserverAuthClient = new MiniserverAuthClient();

  constructor(options: AdminApiOptions) {
    this.onReinitialize = options.onReinitialize;
    this.notifier = options.notifier;
    this.loxoneNotifier = options.loxoneNotifier;
    this.spotifyManagerProvider = options.spotifyManagerProvider;
    this.customRadioStore = options.customRadioStore;
    this.zoneManager = options.zoneManager;
    this.configPort = options.configPort;
    this.spotifyInputService = options.spotifyInputService;
    this.sendspinLineInService = options.sendspinLineInService;
    this.musicAssistantStreamService = options.musicAssistantStreamService;
    this.snapcastCore = options.snapcastCore;
    this.squeezeliteCore = options.squeezeliteCore;
    this.recentsManager = options.recentsManager;
    this.favoritesManager = options.favoritesManager;
    this.groupManager = options.groupManager;
    this.contentManager = options.contentManager;
    this.audioManager = options.audioManager;
    this.mdns = options.mdnsPort;
    this.routes = this.buildRoutes();
  }

  public matches(pathname: string): boolean {
    return this.normalizeApiPath(pathname) !== null;
  }

  private normalizeApiPath(pathname: string): string | null {
    const raw = (pathname.split('?')[0] ?? '').trim() || '/';
    if (!raw.startsWith('/admin/api')) {
      return null;
    }
    const suffix = raw.slice('/admin/api'.length);
    const trimmed = suffix.replace(/\/+$/, '');
    if (!trimmed) {
      return '/';
    }
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  }

  private buildRoutes(): Route[] {
    return [
      ...buildAppleMusicRoutes({
        log: this.log,
        readBinaryBody: (req, res, max) => this.readBinaryBody(req, res, max),
        sendJson: (res, status, payload) => this.sendJson(res, status, payload),
        sendHtml: (res, status, html) => this.sendHtml(res, status, html),
      }),
      ...buildSpotifyRoutes({
        log: this.log,
        configPort: this.configPort,
        notifier: this.notifier,
        contentManager: this.contentManager,
        spotifyInputService: this.spotifyInputService,
        spotifyManagerProvider: this.spotifyManagerProvider,
        zoneManager: this.zoneManager,
        musicAssistantStreamService: this.musicAssistantStreamService,
        isValidMusicAssistantHost: (host) => this.isValidMusicAssistantHost(host),
        testMusicAssistantBridge: (host, port, key) => this.testMusicAssistantBridge(host, port, key),
        defaultConfig: () => this.defaultConfig(),
        readJsonBody: (req, res, max) => this.readJsonBody(req, res, max),
        sendJson: (res, status, payload) => this.sendJson(res, status, payload),
      }),
      ...buildAuthRoutes({
        configPort: this.configPort,
        sessionStore: this.sessionStore,
        miniserverAuthClient: this.miniserverAuthClient,
        log: this.log,
        readJsonBody: (req, res) => this.readJsonBody(req, res),
        sendJson: (res, status, payload) => this.sendJson(res, status, payload),
      }),
      ...buildMiscRoutes({
        log: this.log,
        configPort: this.configPort,
        groupManager: this.groupManager,
        snapcastCore: this.snapcastCore,
        runtimeConfig: this.runtimeConfig,
        onReinitialize: this.onReinitialize,
        defaultConfig: () => this.defaultConfig(),
        readJsonBody: (req, res, max) => this.readJsonBody(req, res, max),
        sendJson: (res, status, payload) => this.sendJson(res, status, payload),
      }),
      ...buildZonesRoutes({
        log: this.log,
        configPort: this.configPort,
        audioManager: this.audioManager,
        zoneManager: this.zoneManager,
        favoritesManager: this.favoritesManager,
        recentsManager: this.recentsManager,
        squeezeliteCore: this.squeezeliteCore,
        getClockOffsetMs: () => this.getClockOffsetMs(),
        getZoneOutputConfig: (zone) => this.getZoneOutputConfig(zone as {
          output?: ZoneTransportConfig | null;
          transports?: ZoneTransportConfig[];
        }) ?? undefined,
        buildSqueezeliteAdminPlayerSnapshot: (primaryOutput, players) =>
          buildSqueezeliteAdminPlayerSnapshot(primaryOutput as ZoneTransportConfig | undefined, players),
        readJsonBody: (req, res, max) => this.readJsonBody(req, res, max),
        sendJson: (res, status, payload) => this.sendJson(res, status, payload),
      }),
      ...buildTransportsRoutes({
        log: this.log,
        configPort: this.configPort,
        mdns: this.mdns,
        snapcastCore: this.snapcastCore,
        squeezeliteCore: this.squeezeliteCore,
        musicAssistantStreamService: this.musicAssistantStreamService,
        spotifyManagerProvider: this.spotifyManagerProvider,
        stateControllerDefinitions: STATE_CONTROLLER_DEFINITIONS,
        readJsonBody: (req, res, max) => this.readJsonBody(req, res, max),
        sendJson: (res, status, payload) => this.sendJson(res, status, payload),
      }),
      ...buildContentRoutes({
        log: this.log,
        contentManager: this.contentManager,
        customRadioStore: this.customRadioStore,
        loxoneNotifier: this.loxoneNotifier,
        readJsonBody: (req, res, max) => this.readJsonBody(req, res, max),
        sendJson: (res, status, payload) => this.sendJson(res, status, payload),
      }),
      ...buildConfigRoutes({
        log: this.log,
        configPort: this.configPort,
        contentManager: this.contentManager,
        loxoneNotifier: this.loxoneNotifier,
        sendspinLineInService: this.sendspinLineInService,
        zoneManager: this.zoneManager,
        defaultConfig: () => this.defaultConfig(),
        getZoneOutputConfig: (zone) => this.getZoneOutputConfig(zone),
        readJsonBody: (req, res, max) => this.readJsonBody(req, res, max),
        sendJson: (res, status, payload) => this.sendJson(res, status, payload),
      }),
      ...buildAlertsRoutes({
        log: this.log,
        readJsonBody: (req, res, max) => this.readJsonBody(req, res, max),
        sendJson: (res, status, payload) => this.sendJson(res, status, payload),
      }),
    ];
  }

  private async dispatchRoute(
    pathname: string,
    method: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    for (const route of this.routes) {
      if (route.method && route.method !== method) {
        continue;
      }
      const match = pathname.match(route.pattern);
      if (!match) {
        continue;
      }
      await route.handler(req, res, match, pathname);
      return true;
    }
    return false;
  }

  public async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const rawUrl = req.url ?? '';
    const rawPathname = (rawUrl.split('?')[0] ?? '').trim() || '/';
    const pathname = this.normalizeApiPath(rawPathname);
    if (!pathname) {
      this.sendJson(res, 404, { error: 'not-found' });
      return;
    }
    const method = (req.method ?? 'GET').toUpperCase();

    try {
      const cfg = this.configPort.getConfig();
      if (cfg.system.audioserver.paired && cfg.system.audioserver.authEnabled !== false && !isPublicAdminApiRoute(pathname, method)) {
        const session = this.sessionStore.getFromRequest(req);
        if (!session) {
          this.sendJson(res, 401, { error: 'auth-required' });
          return;
        }
      }
      const handled = await this.dispatchRoute(pathname, method, req, res);
      if (!handled) {
        this.handleNotImplemented(res, method, rawPathname);
      }
    } catch (err) {
      this.log.error('admin api error', { err });
      this.sendJson(res, 500, { error: 'admin-api-error' });
    }
  }

  private async getClockOffsetMs(): Promise<number | null> {
    const now = Date.now();
    const maxAgeMs = 5 * 60 * 1000; // 5 minutes
    if (now - this.clockOffsetCache.sampledAt < maxAgeMs) {
      return this.clockOffsetCache.offsetMs;
    }
    try {
      const offset = await this.fetchClockOffset();
      this.clockOffsetCache = { offsetMs: offset, sampledAt: Date.now() };
      this.clockOffsetFailureLog = { message: null, loggedAt: 0 };
      return offset;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logClockOffsetFailure(message);
      return this.clockOffsetCache.offsetMs;
    }
  }

  private fetchClockOffset(): Promise<number | null> {
    const providers: Array<{ name: string; url: string; parse: (body: string) => number | null }> = [
      {
        name: 'timeapi',
        url: 'https://timeapi.io/api/Time/current/zone?timeZone=Etc/UTC',
        parse: (body) => {
          const parsed = JSON.parse(body) as {
            year?: number;
            month?: number;
            day?: number;
            hour?: number;
            minute?: number;
            seconds?: number;
            milliSeconds?: number;
            dateTime?: string;
          };
          if (
            typeof parsed.year === 'number' &&
            typeof parsed.month === 'number' &&
            typeof parsed.day === 'number' &&
            typeof parsed.hour === 'number' &&
            typeof parsed.minute === 'number' &&
            typeof parsed.seconds === 'number'
          ) {
            const ms = typeof parsed.milliSeconds === 'number' ? parsed.milliSeconds : 0;
            return Date.UTC(
              parsed.year,
              parsed.month - 1,
              parsed.day,
              parsed.hour,
              parsed.minute,
              parsed.seconds,
              ms,
            );
          }
          if (typeof parsed.dateTime === 'string') {
            const ts = Date.parse(parsed.dateTime);
            return Number.isNaN(ts) ? null : ts;
          }
          return null;
        },
      },
    ];

    return new Promise((resolve, reject) => {
      const tryProvider = (index: number, errors: string[]): void => {
        if (index >= providers.length) {
          reject(new Error(`clock offset providers unavailable: ${errors.join('; ')}`));
          return;
        }
        const provider = providers[index]!;
        const req = https.get(
          provider.url,
          {
            timeout: 1500,
            headers: { Accept: 'application/json' },
          },
          (res) => {
            let body = '';
            res.on('data', (chunk) => {
              body += chunk;
            });
            res.on('end', () => {
              if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
                tryProvider(index + 1, [...errors, `${provider.name}:http-${res.statusCode ?? 0}`]);
                return;
              }
              try {
                const remoteMs = provider.parse(body);
                if (!remoteMs) {
                  tryProvider(index + 1, [...errors, `${provider.name}:invalid-payload`]);
                  return;
                }
                resolve(Date.now() - remoteMs);
              } catch {
                tryProvider(index + 1, [...errors, `${provider.name}:parse-error`]);
              }
            });
          },
        );
        req.on('error', () => {
          tryProvider(index + 1, [...errors, `${provider.name}:network-error`]);
        });
        req.on('timeout', () => {
          req.destroy(new Error('timeout'));
          tryProvider(index + 1, [...errors, `${provider.name}:timeout`]);
        });
      };
      tryProvider(0, []);
    });
  }

  private logClockOffsetFailure(message: string): void {
    const now = Date.now();
    const minLogIntervalMs = 30 * 60 * 1000;
    const sameMessage = this.clockOffsetFailureLog.message === message;
    const recentlyLogged = now - this.clockOffsetFailureLog.loggedAt < minLogIntervalMs;
    if (sameMessage && recentlyLogged) {
      return;
    }
    this.clockOffsetFailureLog = { message, loggedAt: now };
    this.log.debug('clock offset fetch failed', { message });
  }

  private isValidMusicAssistantHost(host: string): boolean {
    const trimmed = host.trim();
    if (!trimmed || trimmed === '0.0.0.0') return false;
    const bracketed =
      trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1).trim() : trimmed;
    if (isIP(bracketed)) return true;
    if (trimmed.includes('://')) return false;
    if (trimmed.length > 253) return false;
    const labels = trimmed.split('.');
    if (labels.some((label) => !label || label.length > 63)) return false;
    return labels.every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
  }

  private async testMusicAssistantBridge(
    host: string,
    port: number,
    apiKey: string,
  ): Promise<{ ok: boolean; checkedAt: number; message?: string; host: string; port: number }> {
    const checkedAt = Date.now();
    const api = MusicAssistantApi.acquire(host, port, apiKey);
    try {
      await this.withTimeout(api.connect(), 8000, 'music assistant connection timed out');
      return { ok: true, checkedAt, host, port };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, checkedAt, message, host, port };
    } finally {
      api.release();
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private handleNotImplemented(
    res: ServerResponse,
    method: string,
    url: string,
  ): void {
    this.log.info('admin api stub hit', { method, url });
    this.sendJson(res, 501, { error: 'admin-api-not-implemented' });
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private sendHtml(res: ServerResponse, status: number, html: string): void {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  }

  private getZoneOutputConfig(zone: {
    output?: ZoneTransportConfig | null;
    transports?: ZoneTransportConfig[];
  }): ZoneTransportConfig | null {
    if (zone.output && typeof zone.output === 'object') {
      return zone.output;
    }
    if (Array.isArray(zone.transports) && zone.transports.length > 0) {
      return zone.transports[0] ?? null;
    }
    return null;
  }

  private async readJsonBody(
    req: IncomingMessage,
    res: ServerResponse,
    maxBytes = MAX_JSON_BODY_BYTES,
  ): Promise<unknown | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;

      const cleanup = () => {
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('error', onError);
        req.off('aborted', onAborted);
      };

      const done = (value: unknown | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const closeSocket = () => {
        const socket = req.socket;
        if (socket && !socket.destroyed) {
          socket.destroy();
        }
      };

      const rejectTooLarge = () => {
        if (!res.writableEnded) {
          this.sendJson(res, 413, { error: 'payload-too-large' });
        }
        req.pause();
        res.once('finish', closeSocket);
        res.once('close', closeSocket);
        done(null);
      };

      const onData = (chunk: Buffer | string) => {
        if (settled) return;
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        totalBytes += buffer.length;
        if (totalBytes > maxBytes) {
          rejectTooLarge();
          return;
        }
        chunks.push(buffer);
      };

      const onEnd = () => {
        if (settled) return;
        if (totalBytes === 0) {
          done(null);
          return;
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          done(JSON.parse(raw));
        } catch {
          if (!res.writableEnded) {
            this.sendJson(res, 400, { error: 'invalid-json' });
          }
          done(null);
        }
      };

      const onError = () => {
        if (!res.writableEnded) {
          this.sendJson(res, 400, { error: 'invalid-json' });
        }
        done(null);
      };

      const onAborted = () => {
        done(null);
      };

      req.on('data', onData);
      req.once('end', onEnd);
      req.once('error', onError);
      req.once('aborted', onAborted);
    });
  }

  private async readBinaryBody(
    req: IncomingMessage,
    res: ServerResponse,
    maxBytes: number,
  ): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;

      const cleanup = () => {
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('error', onError);
        req.off('aborted', onAborted);
      };

      const done = (value: Buffer | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const closeSocket = () => {
        const socket = req.socket;
        if (socket && !socket.destroyed) {
          socket.destroy();
        }
      };

      const rejectTooLarge = () => {
        if (!res.writableEnded) {
          this.sendJson(res, 413, { error: 'payload-too-large' });
        }
        req.pause();
        res.once('finish', closeSocket);
        res.once('close', closeSocket);
        done(null);
      };

      const onData = (chunk: Buffer | string) => {
        if (settled) return;
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        totalBytes += buffer.length;
        if (totalBytes > maxBytes) {
          rejectTooLarge();
          return;
        }
        chunks.push(buffer);
      };

      const onEnd = () => {
        if (settled) return;
        if (totalBytes === 0) {
          done(null);
          return;
        }
        done(Buffer.concat(chunks));
      };

      const onError = () => {
        if (!res.writableEnded) {
          this.sendJson(res, 400, { error: 'invalid-body' });
        }
        done(null);
      };

      const onAborted = () => {
        done(null);
      };

      req.on('data', onData);
      req.once('end', onEnd);
      req.once('error', onError);
      req.once('aborted', onAborted);
    });
  }

  private defaultConfig(): AudioServerConfig {
    return {
      system: {
        miniserver: { ip: '', serial: '', port: 80, protocol: 'http' },
        audioserver: {
          ip: defaultLocalIp(),
          name: 'Unconfigured',
          uuid: '',
          macId: defaultMacId(),
          paired: false,
          extensions: [],
        },
        logging: {
          consoleLevel: 'none',
          fileLevel: 'none',
        },
        adminHttp: { enabled: true },
      },
      content: {
        radio: {
          tuneInUsername: '',
        },
        spotify: {
          clientId: '',
          accounts: [],
          bridges: [],
        },
        library: {
          enabled: true,
          autoScan: true,
        },
      },
      inputs: {
        airplay: {
          enabled: true,
        },
        spotify: {
          enabled: true,
        },
        bluetooth: {
          enabled: false,
        },
        lineIn: {
          inputs: [],
        },
      },
      groups: {
        mixedGroupEnabled: false,
        powerGroups: [],
      },
      zones: [],
      rawAudioConfig: {
        raw: null,
        rawString: null,
        crc32: null,
      },
    };
  }
}
