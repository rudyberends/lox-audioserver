import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import https from 'node:https';
import { createLogger } from '@/shared/logging/logger';
import { defaultMacId, normalizeMacId } from '@/shared/utils/mac';
import { defaultLocalIp } from '@/shared/utils/net';
import type { NotifierPort } from '@/ports/NotifierPort';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { SpotifyInputService } from '@/adapters/inputs/spotify/spotifyInputService';
import type {
  AudioServerConfig,
  ZoneEqualizerConfig,
  ZoneTransportConfig,
  ZoneStateConfig,
} from '@/domain/config/types';
import { sendspinCore } from '@lox-audioserver/node-sendspin';
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
        getZoneOutputConfig: (zone) => this.getZoneOutputConfig(zone as any) as any,
        buildSqueezeliteAdminPlayerSnapshot: (primaryOutput, players) =>
          buildSqueezeliteAdminPlayerSnapshot(primaryOutput as any, players),
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
      {
        pattern: /^\/config(?:\/.*)?$/,
        handler: async (req, res, _match, path) => {
          await this.handleConfig(req, res, path);
        },
      },
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

  private async reloadZones(zoneIds?: number[]): Promise<void> {
    const cfg = this.configPort.getConfig();
    if (!zoneIds || zoneIds.length === 0) {
      await this.zoneManager.replaceAll(cfg.zones ?? [], cfg.inputs ?? null, cfg.groups ?? null);
      return;
    }
    const set = new Set(zoneIds);
    const targets = (cfg.zones ?? []).filter((z) => set.has(z.id));
    if (targets.length === 0) {
      await this.zoneManager.replaceAll(cfg.zones ?? [], cfg.inputs ?? null, cfg.groups ?? null);
      return;
    }
    await this.zoneManager.replaceZones(targets, cfg.inputs ?? null, cfg.groups ?? null);
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

  private async handleConfig(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const isImport = pathname.endsWith('/config/import');
    const isClear = pathname.endsWith('/config/clear');
    const isZonesUpdate = pathname.endsWith('/config/zones');
    const isContentUpdate = pathname.endsWith('/config/content');
    const isInputsUpdate = pathname.endsWith('/config/inputs');
    const isSystemUpdate = pathname.endsWith('/config/system');
    const isGroupsUpdate = pathname.endsWith('/config/groups');

    if (req.method === 'GET' && (pathname.endsWith('/config') || pathname.endsWith('/config/'))) {
      const cfg = this.configPort.getConfig();
      const snapshot = this.buildAdminConfigSnapshot(cfg);
      // Match legacy admin payload shape
      this.sendJson(res, 200, { config: snapshot });
      return;
    }

    if (req.method === 'POST' && isClear) {
      const currentMacId = this.configPort.getConfig()?.system?.audioserver?.macId;
      await this.configPort.updateConfig((cfg) => {
        Object.assign(cfg, this.defaultConfig());
        if (currentMacId) {
          cfg.system.audioserver.macId = currentMacId;
        }
      });
      await this.reloadZones();
      this.sendJson(res, 204, {});
      return;
    }

    if (req.method === 'POST' && isZonesUpdate) {
      const body = (await this.readJsonBody(req, res)) as { zones?: Partial<AudioServerConfig['zones']> } | null;
      if (res.writableEnded) {
        return;
      }
      if (!body?.zones || !Array.isArray(body.zones)) {
        this.sendJson(res, 400, { error: 'invalid-zones-payload' });
        return;
      }
      const updatedIds = Array.from(
        new Set(
          body.zones
            .map((z: any) => Number(z?.id))
            .filter((id) => Number.isFinite(id) && id > 0),
        ),
      );

      await this.configPort.updateConfig((cfg) => {
        if (!cfg.zones) cfg.zones = [];
        body.zones!.forEach((incoming: any) => {
          const target = cfg.zones!.find((z) => z.id === incoming.id);
          if (target) {
            if (incoming.inputs !== undefined) {
              target.inputs = incoming.inputs as any;
            }
            if (incoming.powerManager !== undefined) {
              target.powerManager = incoming.powerManager as any;
            }
            if (incoming.equalizer !== undefined) {
              target.equalizer = this.normalizeEqualizerPayload(target.equalizer, incoming.equalizer);
            }
            if (incoming.state !== undefined) {
              target.state = this.normalizeZoneStatePayload(incoming.state);
            }
            if (incoming.name !== undefined) target.name = incoming.name;
            if (incoming.source !== undefined) target.source = incoming.source;
            if (incoming.sourceSerial !== undefined) target.sourceSerial = incoming.sourceSerial;
            if (
              incoming.output !== undefined ||
              incoming.transport !== undefined ||
              incoming.transports !== undefined
            ) {
              target.output = this.normalizeOutputPayload(incoming);
              delete (target as any).transports;
            }
          } else {
            const nextZone = { ...(incoming as any) };
            if (
              incoming.output !== undefined ||
              incoming.transport !== undefined ||
              incoming.transports !== undefined
            ) {
              nextZone.output = this.normalizeOutputPayload(incoming);
              delete nextZone.transport;
              delete nextZone.transports;
            }
            if (incoming.state !== undefined) {
              nextZone.state = this.normalizeZoneStatePayload(incoming.state);
            }
            if (incoming.powerManager !== undefined) {
              nextZone.powerManager = incoming.powerManager as any;
            }
            if (incoming.equalizer !== undefined) {
              nextZone.equalizer = this.normalizeEqualizerPayload(undefined, incoming.equalizer);
            }
            cfg.zones!.push(nextZone as any);
          }
        });
      });
      await this.reloadZones(updatedIds);
      this.sendJson(res, 204, {});
      return;
    }

    if (req.method === 'POST' && isInputsUpdate) {
      const body = (await this.readJsonBody(req, res)) as
        | {
            airplay?: { enabled?: boolean };
            spotify?: { enabled?: boolean };
            bluetooth?: { enabled?: boolean };
            lineIn?: { inputs?: Array<Record<string, unknown>> | null };
          }
        | null;
      if (res.writableEnded) {
        return;
      }
      if (!body || typeof body !== 'object') {
        this.sendJson(res, 400, { error: 'invalid-inputs-payload' });
        return;
      }

      const lineInUpdated =
        typeof body.lineIn === 'object' &&
        body.lineIn !== null &&
        Object.prototype.hasOwnProperty.call(body.lineIn, 'inputs');
      const lineInInputs = lineInUpdated
        ? Array.isArray(body.lineIn?.inputs)
          ? body.lineIn?.inputs
          : []
        : null;

      await this.configPort.updateConfig((cfg) => {
        if (!cfg.inputs) cfg.inputs = this.defaultConfig().inputs;
        if (body.airplay && typeof body.airplay === 'object' && 'enabled' in body.airplay) {
          cfg.inputs!.airplay = { ...(cfg.inputs!.airplay ?? {}), enabled: Boolean(body.airplay.enabled) };
        }
        if (body.spotify && typeof body.spotify === 'object' && 'enabled' in body.spotify) {
          cfg.inputs!.spotify = { ...(cfg.inputs!.spotify ?? {}), enabled: Boolean(body.spotify.enabled) };
        }
        if (body.bluetooth && typeof body.bluetooth === 'object' && 'enabled' in body.bluetooth) {
          cfg.inputs!.bluetooth = {
            ...(cfg.inputs!.bluetooth ?? {}),
            enabled: Boolean(body.bluetooth.enabled),
          };
        }
        if (lineInUpdated) {
          cfg.inputs!.lineIn = { ...(cfg.inputs!.lineIn ?? {}), inputs: lineInInputs ?? [] };
        }
      });
      if (lineInUpdated) {
        this.loxoneNotifier.notifyLineInChanged();
        this.sendspinLineInService.refresh();
      }
      await this.reloadZones();
      this.sendJson(res, 204, {});
      return;
    }

    if (req.method === 'POST' && isSystemUpdate) {
      const body = (await this.readJsonBody(req, res)) as
        | {
            audioserver?: { macId?: string; ip?: string; authEnabled?: boolean };
            miniserver?: { ip?: string; port?: number; protocol?: 'http' | 'https' };
          }
        | null;
      if (res.writableEnded) {
        return;
      }
      if (!body || typeof body !== 'object') {
        this.sendJson(res, 400, { error: 'invalid-system-payload' });
        return;
      }
      const hasAudioserver = body.audioserver && typeof body.audioserver === 'object';
      const hasMiniserver = body.miniserver && typeof body.miniserver === 'object';
      if (!hasAudioserver && !hasMiniserver) {
        this.sendJson(res, 400, { error: 'invalid-system-payload' });
        return;
      }

      const rawMac = hasAudioserver ? body.audioserver!.macId : undefined;
      const rawIp = hasAudioserver ? body.audioserver!.ip : undefined;
      const rawAuthEnabled = hasAudioserver ? body.audioserver!.authEnabled : undefined;
      const rawMiniserverIp = hasMiniserver ? body.miniserver!.ip : undefined;
      const rawMiniserverPort = hasMiniserver ? body.miniserver!.port : undefined;
      const rawMiniserverProtocol = hasMiniserver ? body.miniserver!.protocol : undefined;
      if (
        typeof rawMac !== 'string' &&
        typeof rawIp !== 'string' &&
        typeof rawAuthEnabled !== 'boolean' &&
        typeof rawMiniserverIp !== 'string' &&
        typeof rawMiniserverPort !== 'number' &&
        typeof rawMiniserverProtocol !== 'string'
      ) {
        this.sendJson(res, 400, { error: 'invalid-system-payload' });
        return;
      }

      let normalizedMac: string | null = null;
      if (typeof rawMac === 'string') {
        const trimmed = rawMac.trim();
        if (!trimmed) {
          this.sendJson(res, 400, { error: 'invalid-macid' });
          return;
        }
        const normalized = normalizeMacId(trimmed);
        if (!normalized || normalized.length !== 12) {
          this.sendJson(res, 400, { error: 'invalid-macid' });
          return;
        }
        normalizedMac = normalized;
      }
      let normalizedIp: string | null = null;
      if (typeof rawIp === 'string') {
        const trimmedIp = rawIp.trim();
        if (!trimmedIp) {
          this.sendJson(res, 400, { error: 'invalid-ip' });
          return;
        }
        normalizedIp = trimmedIp;
      }
      let normalizedMiniserverIp: string | null = null;
      if (typeof rawMiniserverIp === 'string') {
        const trimmedIp = rawMiniserverIp.trim();
        if (!trimmedIp) {
          this.sendJson(res, 400, { error: 'invalid-miniserver-ip' });
          return;
        }
        normalizedMiniserverIp = trimmedIp;
      }
      let normalizedMiniserverPort: number | null = null;
      if (typeof rawMiniserverPort === 'number') {
        if (
          !Number.isInteger(rawMiniserverPort) ||
          rawMiniserverPort <= 0 ||
          rawMiniserverPort > 65535
        ) {
          this.sendJson(res, 400, { error: 'invalid-miniserver-port' });
          return;
        }
        normalizedMiniserverPort = rawMiniserverPort;
      }
      let normalizedMiniserverProtocol: 'http' | 'https' | null = null;
      if (typeof rawMiniserverProtocol === 'string') {
        const value = rawMiniserverProtocol.trim().toLowerCase();
        if (value !== 'http' && value !== 'https') {
          this.sendJson(res, 400, { error: 'invalid-miniserver-protocol' });
          return;
        }
        normalizedMiniserverProtocol = value;
      }
      await this.configPort.updateConfig((cfg) => {
        if (!cfg.system) cfg.system = this.defaultConfig().system;
        if (!cfg.system.audioserver) {
          cfg.system.audioserver = this.defaultConfig().system.audioserver;
        }
        if (!cfg.system.miniserver) {
          cfg.system.miniserver = this.defaultConfig().system.miniserver;
        }
        if (normalizedMac) {
          cfg.system.audioserver.macId = normalizedMac;
        }
        if (normalizedIp) {
          cfg.system.audioserver.ip = normalizedIp;
        }
        if (typeof rawAuthEnabled === 'boolean') {
          cfg.system.audioserver.authEnabled = rawAuthEnabled;
        }
        if (normalizedMiniserverIp) {
          cfg.system.miniserver.ip = normalizedMiniserverIp;
        }
        if (normalizedMiniserverPort !== null) {
          cfg.system.miniserver.port = normalizedMiniserverPort;
        }
        if (normalizedMiniserverProtocol) {
          cfg.system.miniserver.protocol = normalizedMiniserverProtocol;
        }
      });
      this.sendJson(res, 204, {});
      return;
    }

    if (req.method === 'POST' && isGroupsUpdate) {
      const body = (await this.readJsonBody(req, res)) as
        | {
            mixedGroupEnabled?: boolean;
            powerGroups?: AudioServerConfig['groups'] extends infer G
              ? G extends { powerGroups?: infer P }
                ? P
                : never
              : never;
          }
        | null;
      if (res.writableEnded) {
        return;
      }
      if (!body || typeof body !== 'object') {
        this.sendJson(res, 400, { error: 'invalid-groups-payload' });
        return;
      }
      if (!('mixedGroupEnabled' in body) && !('powerGroups' in body)) {
        this.sendJson(res, 400, { error: 'invalid-groups-payload' });
        return;
      }
      await this.configPort.updateConfig((cfg) => {
        if (!cfg.groups) cfg.groups = {};
        if ('mixedGroupEnabled' in body) {
          cfg.groups.mixedGroupEnabled = Boolean(body.mixedGroupEnabled);
        }
        if ('powerGroups' in body) {
          cfg.groups.powerGroups = Array.isArray(body.powerGroups) ? body.powerGroups : [];
        }
      });
      this.sendJson(res, 204, {});
      return;
    }

    if (req.method === 'POST' && isContentUpdate) {
      const body = (await this.readJsonBody(req, res)) as
        | {
            radio?: { tuneInUsername?: string | null };
            spotify?: { clientId?: string | null };
            library?: { enabled?: boolean; autoScan?: boolean };
            tts?: AudioServerConfig['content']['tts'];
          }
        | null;
      if (res.writableEnded) {
        return;
      }
      if (!body || typeof body !== 'object') {
        this.sendJson(res, 400, { error: 'invalid-content-payload' });
        return;
      }

      await this.configPort.updateConfig((cfg) => {
        if (!cfg.content) cfg.content = this.defaultConfig().content;
        if (body.radio) {
          cfg.content.radio = {
            ...(cfg.content.radio ?? {}),
            tuneInUsername:
              typeof body.radio.tuneInUsername === 'string'
                ? body.radio.tuneInUsername.trim()
                : '',
          };
        }
        if (body.spotify) {
          cfg.content.spotify = {
            ...(cfg.content.spotify ?? { accounts: [], bridges: [] }),
            clientId:
              typeof body.spotify.clientId === 'string'
                ? body.spotify.clientId.trim()
                : '',
            accounts: cfg.content.spotify?.accounts ?? [],
            bridges: cfg.content.spotify?.bridges ?? [],
          };
        }
        if (body.library) {
          cfg.content.library = {
            ...(cfg.content.library ?? {}),
            ...body.library,
          };
        }
        if (body.tts) {
          cfg.content.tts = {
            ...(cfg.content.tts ?? { provider: { type: 'internal' }, fallbackToInternal: true }),
            ...body.tts,
          };
        }
      });
      this.contentManager.refreshFromConfig();
      this.sendJson(res, 204, {});
      return;
    }

    if (req.method === 'POST' && isImport) {
      const body = await this.readJsonBody(req, res);
      if (res.writableEnded) {
        return;
      }
      if (!body || typeof body !== 'object') {
        this.sendJson(res, 400, { error: 'invalid-config' });
        return;
      }

      await this.configPort.updateConfig((cfg) => {
        // Replace top-level config keys with imported payload
        Object.assign(cfg, body as Partial<AudioServerConfig>);
      });
      await this.reloadZones();
      this.sendJson(res, 204, {});
      return;
    }

    this.handleNotImplemented(res, req.method ?? 'GET', pathname);
  }

  private buildAdminConfigSnapshot(config: AudioServerConfig): AudioServerConfig {
    const zones = (config.zones ?? []).map((zone) => {
      const primaryOutput = this.getZoneOutputConfig(zone);
      const transports = primaryOutput ? [primaryOutput] : [];
      const state = this.normalizeZoneStatePayload((zone as { state?: unknown }).state);
      const { output: _output, transports: _transports, ...rest } = zone as any;
      return { ...rest, transports, state };
    });
    return { ...config, zones };
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

  private normalizeOutputPayload(payload: any): ZoneTransportConfig | null {
    if (payload?.output === null || payload?.transport === null) {
      return null;
    }
    if (payload?.output && typeof payload.output === 'object') {
      return payload.output as ZoneTransportConfig;
    }
    if (payload?.transport && typeof payload.transport === 'object') {
      return payload.transport as ZoneTransportConfig;
    }
    if (Array.isArray(payload?.transports)) {
      return payload.transports[0] ?? null;
    }
    return null;
  }

  private normalizeEqualizerPayload(
    current: ZoneEqualizerConfig | null | undefined,
    payload: unknown,
  ): ZoneEqualizerConfig | null {
    if (payload === null) {
      // Explicit null: drop provider/callback but preserve any stored bands.
      const bands = current?.bands;
      return bands && Array.isArray(bands) && bands.length > 0 ? { bands: [...bands] } : null;
    }
    if (!payload || typeof payload !== 'object') {
      return current ?? null;
    }
    const record = payload as Record<string, unknown>;
    const next: ZoneEqualizerConfig = {};
    if (Array.isArray(current?.bands)) {
      next.bands = [...current!.bands!];
    }
    if (Array.isArray(record.bands)) {
      next.bands = record.bands.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry));
    }
    if (record.provider !== undefined) {
      const provider = String(record.provider).trim().toLowerCase();
      if (provider === 'squeezelite-mr') {
        next.provider = 'squeezelite-mr';
      } else if (provider === 'builtin') {
        next.provider = 'builtin';
      } else if (provider === 'off' || provider === '') {
        // 'off' is the default; omit to keep persisted config compact.
      } else {
        // Unknown value: fall back to default off (omit field).
      }
    } else if (current?.provider) {
      next.provider = current.provider;
    }
    if (record.callbackUrl !== undefined) {
      const raw = typeof record.callbackUrl === 'string' ? record.callbackUrl.trim() : '';
      if (raw) next.callbackUrl = raw;
    } else if (current?.callbackUrl) {
      next.callbackUrl = current.callbackUrl;
    }
    // callbackUrl only makes sense for the squeezelite-mr forwarder.
    if (next.provider !== 'squeezelite-mr') {
      delete next.callbackUrl;
    }
    return Object.keys(next).length > 0 ? next : null;
  }

  private normalizeZoneStatePayload(payload: unknown): ZoneStateConfig {
    if (payload && typeof payload === 'object') {
      const record = payload as Record<string, unknown>;
      const controllerRaw = typeof record.controller === 'string' ? record.controller.trim().toLowerCase() : '';
      const normalized = controllerRaw.replace(/[\s_-]+/g, '');
      const controller =
        normalized === 'beolink'
          ? 'beolink'
          : normalized === 'sonos'
            ? 'sonos'
            : 'internal';
      return {
        ...record,
        controller,
      };
    }
    return { controller: 'internal' };
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
