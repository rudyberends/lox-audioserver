import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '@/shared/logging/logger';
import type { NotifierPort } from '@/ports/NotifierPort';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { SpotifyInputService } from '@/adapters/inputs/spotify/spotifyInputService';
import type { ZoneTransportConfig } from '@/domain/config/types';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';
import type { SendspinLineInService } from '@/adapters/inputs/linein/sendspinLineInService';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { MusicAssistantStreamService } from '@/adapters/inputs/musicassistant/musicAssistantStreamService';
import type { FavoritesManager } from '@/application/zones/favorites/favoritesManager';
import type { RecentsManager } from '@/application/zones/recents/recentsManager';
import type { CustomRadioStore } from '@/adapters/content/providers/customRadioStore';
import type { GroupManagerReadPort } from '@/application/groups/groupManager';
import type { AudioManager } from '@/application/playback/audioManager';
import type { ZoneAudioPreferences } from '@/application/playback/ZoneAudioPreferences';
import { loadConfig as loadRuntimeConfig } from '@/config';
import type { SnapcastCore } from '@/adapters/outputs/snapcast/snapcastCore';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { SpotifyServiceManagerProvider } from '@/adapters/content/providers/spotifyServiceManager';
import type { SqueezeliteCore } from '@/adapters/outputs/squeezelite/squeezeliteCore';
import type { MdnsPort } from '@/ports/MdnsPort';
import type { LoxAudioPeerRegistry } from '@/adapters/discovery/loxAudioPeerRegistry';

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
  zoneAudioPrefs: ZoneAudioPreferences;
  mdnsPort: MdnsPort;
  loxAudioPeers: LoxAudioPeerRegistry;
  alertFiles: AlertFilesPort;
  browserZoneRegistry: BrowserZoneRegistry;
  lineInApi: LineInApiHandler;
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
import type { AlertFilesPort } from '@/ports/AlertFilesPort';
import { buildTransportsRoutes } from '@/adapters/http/adminApi/transports/transportsHandlers';
import { buildContentRoutes } from '@/adapters/http/adminApi/content/contentHandlers';
import {
  buildZonesRoutes,
  STATE_CONTROLLER_DEFINITIONS,
} from '@/adapters/http/adminApi/zones/zonesHandlers';
import { buildBrowserZonesRoutes } from '@/adapters/http/adminApi/browserZones/browserZonesHandlers';
import type { BrowserZoneRegistry } from '@/application/zones/browserZoneRegistry';
import { buildSpotifyRoutes } from '@/adapters/http/adminApi/spotify/spotifyHandlers';
import { buildMiscRoutes } from '@/adapters/http/adminApi/misc/miscHandlers';
import { buildConfigRoutes } from '@/adapters/http/adminApi/config/configHandlers';
import { buildLineInRoutes } from '@/adapters/http/adminApi/linein/lineInAdminHandlers';
import type { LineInApiHandler } from '@/adapters/http/lineInApi/lineInApiHandler';
import {
  readBinaryBody,
  readJsonBody,
  sendHtml,
  sendJson,
} from '@/adapters/http/adminApi/helpers/httpUtils';
import { ClockOffsetTracker } from '@/adapters/http/adminApi/helpers/clockOffset';

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
  private readonly zoneAudioPrefs: ZoneAudioPreferences;
  private readonly mdns: MdnsPort;
  private readonly loxAudioPeers: LoxAudioPeerRegistry;
  private readonly alertFiles: AlertFilesPort;
  private readonly browserZoneRegistry: BrowserZoneRegistry;
  private readonly lineInApi: LineInApiHandler;
  private readonly clockOffsetTracker = new ClockOffsetTracker(this.log);
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
    this.zoneAudioPrefs = options.zoneAudioPrefs;
    this.mdns = options.mdnsPort;
    this.loxAudioPeers = options.loxAudioPeers;
    this.alertFiles = options.alertFiles;
    this.browserZoneRegistry = options.browserZoneRegistry;
    this.lineInApi = options.lineInApi;
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
        readBinaryBody: (req, res, max) => readBinaryBody(req, res, max),
        sendJson: (res, status, payload) => sendJson(res, status, payload),
        sendHtml: (res, status, html) => sendHtml(res, status, html),
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
        readJsonBody: (req, res, max) => readJsonBody(req, res, max),
        sendJson: (res, status, payload) => sendJson(res, status, payload),
      }),
      ...buildAuthRoutes({
        configPort: this.configPort,
        sessionStore: this.sessionStore,
        miniserverAuthClient: this.miniserverAuthClient,
        log: this.log,
        readJsonBody: (req, res) => readJsonBody(req, res),
        sendJson: (res, status, payload) => sendJson(res, status, payload),
      }),
      ...buildMiscRoutes({
        log: this.log,
        configPort: this.configPort,
        groupManager: this.groupManager,
        snapcastCore: this.snapcastCore,
        runtimeConfig: this.runtimeConfig,
        onReinitialize: this.onReinitialize,
        loxoneNotifier: this.loxoneNotifier,
        loxAudioPeers: this.loxAudioPeers,
        readJsonBody: (req, res, max) => readJsonBody(req, res, max),
        sendJson: (res, status, payload) => sendJson(res, status, payload),
      }),
      ...buildZonesRoutes({
        log: this.log,
        configPort: this.configPort,
        audioManager: this.audioManager,
        zoneAudioPrefs: this.zoneAudioPrefs,
        zoneManager: this.zoneManager,
        favoritesManager: this.favoritesManager,
        recentsManager: this.recentsManager,
        squeezeliteCore: this.squeezeliteCore,
        getClockOffsetMs: () => this.clockOffsetTracker.get(),
        buildSqueezeliteAdminPlayerSnapshot: (primaryOutput, players) =>
          buildSqueezeliteAdminPlayerSnapshot(primaryOutput as ZoneTransportConfig | undefined, players),
        readJsonBody: (req, res, max) => readJsonBody(req, res, max),
        sendJson: (res, status, payload) => sendJson(res, status, payload),
      }),
      ...buildBrowserZonesRoutes({
        log: this.log,
        registry: this.browserZoneRegistry,
        readJsonBody: (req, res, max) => readJsonBody(req, res, max),
        sendJson: (res, status, payload) => sendJson(res, status, payload),
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
        readJsonBody: (req, res, max) => readJsonBody(req, res, max),
        sendJson: (res, status, payload) => sendJson(res, status, payload),
      }),
      ...buildContentRoutes({
        log: this.log,
        contentManager: this.contentManager,
        customRadioStore: this.customRadioStore,
        loxoneNotifier: this.loxoneNotifier,
        readJsonBody: (req, res, max) => readJsonBody(req, res, max),
        sendJson: (res, status, payload) => sendJson(res, status, payload),
      }),
      ...buildConfigRoutes({
        log: this.log,
        configPort: this.configPort,
        contentManager: this.contentManager,
        loxoneNotifier: this.loxoneNotifier,
        sendspinLineInService: this.sendspinLineInService,
        zoneManager: this.zoneManager,
        readJsonBody: (req, res, max) => readJsonBody(req, res, max),
        sendJson: (res, status, payload) => sendJson(res, status, payload),
      }),
      ...buildLineInRoutes({
        log: this.log,
        lineInApi: this.lineInApi,
        sendJson: (res, status, payload) => sendJson(res, status, payload),
      }),
      ...buildAlertsRoutes({
        log: this.log,
        readJsonBody: (req, res, max) => readJsonBody(req, res, max),
        sendJson: (res, status, payload) => sendJson(res, status, payload),
        alertFiles: this.alertFiles,
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
      sendJson(res, 404, { error: 'not-found' });
      return;
    }
    const method = (req.method ?? 'GET').toUpperCase();

    try {
      const cfg = this.configPort.getConfig();
      if (cfg.system.audioserver.paired && cfg.system.audioserver.authEnabled !== false && !isPublicAdminApiRoute(pathname, method)) {
        const session = this.sessionStore.getFromRequest(req);
        if (!session) {
          sendJson(res, 401, { error: 'auth-required' });
          return;
        }
      }
      const handled = await this.dispatchRoute(pathname, method, req, res);
      if (!handled) {
        this.handleNotImplemented(res, method, rawPathname);
      }
    } catch (err) {
      this.log.error('admin api error', { err });
      sendJson(res, 500, { error: 'admin-api-error' });
    }
  }

  private handleNotImplemented(
    res: ServerResponse,
    method: string,
    url: string,
  ): void {
    this.log.info('admin api stub hit', { method, url });
    sendJson(res, 501, { error: 'admin-api-not-implemented' });
  }
}
