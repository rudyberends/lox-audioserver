import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import {
  constants as cryptoConstants,
  createCipheriv,
  createPublicKey,
  createDecipheriv,
  createHash,
  createHmac,
  publicEncrypt,
  randomBytes,
  randomUUID,
  X509Certificate,
} from 'node:crypto';
import { createConnection, isIP } from 'node:net';
import { createWriteStream, promises as fs, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createLogger, logManager } from '@/shared/logging/logger';
import type { LogLevel } from '@/types/logLevel';
import { bestEffort } from '@/shared/bestEffort';
import { logBuffer } from '@/shared/logging/logBuffer';
import { defaultMacId, normalizeMacId } from '@/shared/utils/mac';
import { defaultLocalIp } from '@/shared/utils/net';
import {
  handleSpotifyOAuthCallback,
  handleSpotifyLibrespotOAuth,
  handleSpotifyLibrespotExport,
  deleteSpotifyAccount,
  buildSpotifyAuthLink,
} from '@/adapters/content/providers/spotify/serviceAuth';
import type { NotifierPort } from '@/ports/NotifierPort';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { SpotifyInputService } from '@/adapters/inputs/spotify/spotifyInputService';
import type {
  AudioServerConfig,
  SpotifyBridgeConfig,
  ZoneTransportConfig,
  ZoneStateConfig,
} from '@/domain/config/types';
import { OUTPUT_DEFINITIONS } from '@/adapters/outputs';
import { discoverAirplayDevices } from '@/adapters/outputs/airplay/airplayDiscovery';
import { discoverGoogleCastDevices } from '@/adapters/outputs/googleCast/googleCastDiscovery';
import { discoverDlnaDevices } from '@/adapters/outputs/dlna/dlnaDiscovery';
import { discoverSonosDevices } from '@/adapters/outputs/sonos/sonosDiscovery';
import { sendspinCore } from '@lox-audioserver/node-sendspin';
import { discoverSpotifyConnectDevices } from '@/adapters/content/providers/spotify/spotifyConnectDiscovery';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';
import type { SendspinLineInService } from '@/adapters/inputs/linein/sendspinLineInService';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { MusicAssistantStreamService } from '@/adapters/inputs/musicassistant/musicAssistantStreamService';
import { MusicAssistantApi } from '@/shared/musicassistant/musicAssistantApi';
import type { StorageConfig } from '@/adapters/content/storage/storageManager';
import { listAlertFiles, revertAlertFile, updateAlertFile } from '@/application/alerts/alertFileManager';
import type { FavoritesManager } from '@/application/zones/favorites/favoritesManager';
import type { RecentsManager } from '@/application/zones/recents/recentsManager';
import type { CustomRadioStore } from '@/adapters/content/providers/customRadioStore';
import { TuneInClient } from '@/adapters/content/providers/tunein/tuneinClient';
import type { GroupManagerReadPort } from '@/application/groups/groupManager';
import type { AudioManager } from '@/application/playback/audioManager';
import { audioResampler } from '@/ports/types/audioFormat';
import https from 'node:https';
import { loadConfig as loadRuntimeConfig } from '@/config';
import type { SnapcastCore } from '@/adapters/outputs/snapcast/snapcastCore';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { SpotifyServiceManagerProvider } from '@/adapters/content/providers/spotifyServiceManager';
import type { SqueezeliteCore } from '@/adapters/outputs/squeezelite/squeezeliteCore';
import { invalidateWidevineArtifactsCache, loadWidevineArtifacts, WidevineArtifactsError } from '@/adapters/content/providers/applemusic/widevine';
import { ensureDir, resolveDataDir } from '@/shared/utils/file';
import type { MdnsPort, MdnsServiceRecord } from '@/ports/MdnsPort';

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

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  match: RegExpMatchArray,
  pathname: string,
) => Promise<void> | void;

type Route = {
  method?: string;
  pattern: RegExp;
  handler: RouteHandler;
};

type AdminUiUpdateRequest = {
  release?: string;
};

type AdminUiUpdateResult = {
  ok: boolean;
  release: string;
  distUrl: string;
  targetDir: string;
  updatedAt?: string;
  error?: string;
};

type ComponentPackageUpdateRequest = {
  name?: string;
  version?: string;
};

type ComponentPackageUpdateResult = {
  ok: boolean;
  name: string;
  requestedVersion: string | null;
  installed: string | null;
  declared: string | null;
  updatedAt?: string;
  error?: string;
};

type AdminServerSession = {
  id: string;
  username: string;
  createdAt: number;
  expiresAt: number;
};

const MAX_JSON_BODY_BYTES = 1 * 1024 * 1024;
const MAX_LIBRARY_UPLOAD_JSON_BODY_BYTES = 32 * 1024 * 1024;
const MAX_EVENT_SOUND_UPLOAD_JSON_BODY_BYTES = 32 * 1024 * 1024;
const MAX_WIDEVINE_PRIVATE_KEY_BYTES = 256 * 1024;
const MAX_WIDEVINE_CLIENT_ID_BYTES = 10 * 1024 * 1024;
const EVENT_SOUNDS_DIR = resolve(process.cwd(), 'public', 'alerts', 'Event_Sounds');
const ALLOWED_EVENT_SOUND_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']);
const ADDON_PACKAGE_PREFIX = '@lox-audioserver/node-';
const MINISERVER_ADMIN_PERMISSION = 1;
const AUTH_COOKIE_NAME = 'lox_admin_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
type HashAlgorithm = 'SHA1' | 'SHA256';
class MiniserverAuthError extends Error {
  constructor(
    public readonly code:
      | 'invalid-credentials'
      | 'insufficient-permissions'
      | 'miniserver-unreachable'
      | 'miniserver-protocol'
      | 'miniserver-not-configured',
    message: string,
  ) {
    super(message);
    this.name = 'MiniserverAuthError';
  }
}
const STATE_CONTROLLER_DEFINITIONS = [
  { id: 'internal', label: 'Internal', description: 'Use internal playback state only.' },
  { id: 'beolink', label: 'BeoLink', description: 'Use BeoLink external playback state.' },
  { id: 'sonos', label: 'Sonos', description: 'Use Sonos external playback state.' },
] as const;

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
  private readonly containerized: boolean;
  private adminUiUpdateInFlight: Promise<AdminUiUpdateResult> | null = null;
  private componentPackageUpdateInFlight: Promise<ComponentPackageUpdateResult> | null = null;
  private clockOffsetCache: { offsetMs: number | null; sampledAt: number } = { offsetMs: null, sampledAt: 0 };
  private clockOffsetFailureLog: { message: string | null; loggedAt: number } = { message: null, loggedAt: 0 };
  private readonly routes: Route[];
  private readonly adminSessions = new Map<string, AdminServerSession>();

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
    this.containerized = this.detectContainerized();
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
      {
        method: 'GET',
        pattern: /^\/applemusic\/auth$/,
        handler: async (req, res) => this.handleAppleMusicAuth(req, res),
      },
      {
        method: 'GET',
        pattern: /^\/applemusic\/widevine\/status$/,
        handler: async (_req, res) => this.handleAppleMusicWidevineStatus(res),
      },
      {
        method: 'PUT',
        pattern: /^\/applemusic\/widevine\/private-key$/,
        handler: async (req, res) => this.handleAppleMusicWidevineUpload(req, res, 'privateKey'),
      },
      {
        method: 'PUT',
        pattern: /^\/applemusic\/widevine\/client-id$/,
        handler: async (req, res) => this.handleAppleMusicWidevineUpload(req, res, 'clientId'),
      },
      {
        pattern: /^\/spotify\/auth\/callback/,
        handler: async (req, res) =>
          handleSpotifyOAuthCallback(
            req,
            res,
            this.notifier,
            this.configPort,
            this.contentManager,
            this.spotifyInputService,
          ),
      },
      {
        method: 'POST',
        pattern: /^\/spotify\/librespot\/oauth$/,
        handler: async (req, res) =>
          handleSpotifyLibrespotOAuth(
            req,
            res,
            this.configPort,
            this.spotifyInputService,
            this.spotifyManagerProvider,
          ),
      },
      {
        pattern: /^\/spotify\/librespot\/credentials/,
        handler: async (req, res) => handleSpotifyLibrespotExport(req, res, this.configPort),
      },
      {
        method: 'GET',
        pattern: /^\/spotify\/librespot\/status$/,
        handler: async (_req, res) => this.handleSpotifyLibrespotStatus(res),
      },
      {
        method: 'POST',
        pattern: /^\/auth\/login$/,
        handler: async (req, res) => this.handleAuthLogin(req, res),
      },
      {
        method: 'GET',
        pattern: /^\/auth\/me$/,
        handler: async (req, res) => this.handleAuthMe(req, res),
      },
      {
        method: 'POST',
        pattern: /^\/auth\/logout$/,
        handler: async (req, res) => this.handleAuthLogout(req, res),
      },
      {
        method: 'POST',
        pattern: /^\/snapcast\/clients\/([^/]+)\/stream$/,
        handler: async (req, res, match) => {
          const clientId = decodeURIComponent(match[1] ?? '').trim();
          const body = (await this.readJsonBody(req, res)) as { streamId?: string } | null;
          if (res.writableEnded) {
            return;
          }
          const streamId = body?.streamId?.trim();
          if (!clientId || !streamId) {
            this.sendJson(res, 400, { error: 'invalid-snapcast-mapping' });
            return;
          }
          const result = this.snapcastCore.setClientStream(clientId, streamId);
          this.sendJson(res, 200, { clientId, streamId, ...result });
        },
      },
      {
        method: 'DELETE',
        pattern: /^\/spotify\/accounts\/([^/]+)$/,
        handler: async (_req, res, match) => {
          const accountId = decodeURIComponent(match[1] ?? '');
          await this.handleSpotifyAccountDelete(accountId, res);
        },
      },
      {
        method: 'GET',
        pattern: /^\/spotify\/accounts\/link$/,
        handler: async (_req, res) => {
          await this.handleSpotifyAccountLink(res);
        },
      },
      {
        method: 'POST',
        pattern: /^\/spotify\/bridges$/,
        handler: async (req, res) => {
          await this.handleSpotifyBridgeCreate(req, res);
        },
      },
      {
        method: 'DELETE',
        pattern: /^\/spotify\/bridges\/([^/]+)$/,
        handler: async (_req, res, match) => {
          const bridgeId = decodeURIComponent(match[1] ?? '');
          await this.handleSpotifyBridgeDelete(bridgeId, res);
        },
      },
      {
        method: 'POST',
        pattern: /^\/setup\/reinitialize$/,
        handler: async (_req, res) => {
          await this.handleReinitialize(res);
        },
      },
      {
        method: 'POST',
        pattern: /^\/adminui\/update$/,
        handler: async (req, res) => {
          await this.handleAdminUiUpdate(req, res);
        },
      },
      {
        method: 'POST',
        pattern: /^\/components\/update$/,
        handler: async (req, res) => {
          await this.handleComponentPackageUpdate(req, res);
        },
      },
      { method: 'GET', pattern: /^\/info$/, handler: (_req, res) => this.handleInfo(res) },
      { method: 'GET', pattern: /^\/zones\/states$/, handler: async (_req, res) => this.handleZoneStates(res) },
      {
        method: 'GET',
        pattern: /^\/zones\/state-controllers$/,
        handler: async (_req, res) => this.handleZoneStateControllerDefinitions(res),
      },
      { method: 'GET', pattern: /^\/transports$/, handler: (_req, res) => this.handleTransportDefinitions(res) },
      {
        method: 'GET',
        pattern: /^\/transports\/airplay\/devices$/,
        handler: async (_req, res) => this.handleAirplayDiscovery(res),
      },
      {
        method: 'GET',
        pattern: /^\/transports\/googlecast\/devices$/,
        handler: async (req, res) => this.handleGoogleCastDiscovery(req, res),
      },
      {
        method: 'GET',
        pattern: /^\/transports\/dlna\/devices$/,
        handler: async (req, res) => this.handleDlnaDiscovery(req, res),
      },
      {
        method: 'GET',
        pattern: /^\/transports\/sonos\/devices$/,
        handler: async (req, res) => this.handleSonosDiscovery(req, res),
      },
      {
        method: 'GET',
        pattern: /^\/transports\/musicassistant\/devices$/,
        handler: async (_req, res) => this.handleMusicAssistantPlayerDiscovery(res),
      },
      {
        method: 'GET',
        pattern: /^\/transports\/musicassistant\/status$/,
        handler: async (_req, res) => this.handleMusicAssistantStatus(res),
      },
      {
        method: 'POST',
        pattern: /^\/transports\/ping$/,
        handler: async (req, res) => this.handleTransportPing(req, res),
      },
      { method: 'GET', pattern: /^\/logs$/, handler: (_req, res) => this.handleLogsSnapshot(res) },
      { method: 'GET', pattern: /^\/logs\/stream$/, handler: (req, res) => this.handleLogsStream(req, res) },
      { method: 'GET', pattern: /^\/groups$/, handler: (_req, res) => this.handleGroups(res) },
      { method: 'POST', pattern: /^\/logs\/level$/, handler: async (req, res) => this.handleLogLevelUpdate(req, res) },
      {
        method: 'GET',
        pattern: /^\/transports\/sendspin\/clients$/,
        handler: async (req, res) => this.handleSendspinDiscovery(req, res),
      },
      {
        method: 'GET',
        pattern: /^\/transports\/sendspin\/mdns-clients$/,
        handler: async (req, res) => this.handleSendspinMdnsDiscovery(req, res),
      },
      {
        method: 'GET',
        pattern: /^\/transports\/sendspin\/sources$/,
        handler: async (_req, res) => this.handleSendspinSourceDiscovery(res),
      },
      {
        method: 'GET',
        pattern: /^\/transports\/snapcast\/clients$/,
        handler: async (_req, res) => this.handleSnapcastDiscovery(res),
      },
      {
        method: 'GET',
        pattern: /^\/transports\/squeezelite\/clients$/,
        handler: async (_req, res) => this.handleSqueezeliteDiscovery(res),
      },
      {
        method: 'GET',
        pattern: /^\/transports\/spotify\/devices$/,
        handler: async (_req, res) => this.handleSpotifyDeviceDiscovery(res),
      },
      {
        method: 'GET',
        pattern: /^\/content\/library\/status$/,
        handler: (_req, res) => this.handleLibraryStatus(res),
      },
      {
        method: 'GET',
        pattern: /^\/content\/library\/covers$/,
        handler: async (req, res) => this.handleLibraryCovers(req, res),
      },
      {
        method: 'POST',
        pattern: /^\/content\/library\/upload$/,
        handler: async (req, res) => this.handleLibraryUpload(req, res),
      },
      {
        method: 'DELETE',
        pattern: /^\/content\/library\/tracks$/,
        handler: async (req, res) => this.handleLibraryTrackDelete(req, res),
      },
      {
        method: 'DELETE',
        pattern: /^\/content\/library\/albums$/,
        handler: async (req, res) => this.handleLibraryAlbumDelete(req, res),
      },
      {
        method: 'DELETE',
        pattern: /^\/content\/library\/artists$/,
        handler: async (req, res) => this.handleLibraryArtistDelete(req, res),
      },
      {
        method: 'POST',
        pattern: /^\/content\/library\/rescan$/,
        handler: async (_req, res) => this.handleLibraryRescan(res),
      },
      {
        method: 'GET',
        pattern: /^\/content\/library\/storages\/([^/]+)\/status$/,
        handler: async (_req, res, match) => {
          const storageId = decodeURIComponent(match[1] ?? '');
          this.handleLibraryStorageStatus(storageId, res);
        },
      },
      {
        method: 'GET',
        pattern: /^\/content\/library\/storages\/([^/]+)\/covers$/,
        handler: async (req, res, match) => {
          const storageId = decodeURIComponent(match[1] ?? '');
          await this.handleLibraryStorageCovers(storageId, req, res);
        },
      },
      {
        method: 'DELETE',
        pattern: /^\/content\/library\/storages\/([^/]+)$/,
        handler: async (_req, res, match) => {
          const storageId = decodeURIComponent(match[1] ?? '');
          await this.handleLibraryStorageDelete(storageId, res);
        },
      },
      {
        method: 'GET',
        pattern: /^\/content\/library\/storages$/,
        handler: async (_req, res) => this.handleLibraryStorageList(res),
      },
      {
        method: 'POST',
        pattern: /^\/content\/library\/storages$/,
        handler: async (req, res) => this.handleLibraryStorageAdd(req, res),
      },
      {
        pattern: /^\/config(?:\/.*)?$/,
        handler: async (req, res, _match, path) => {
          await this.handleConfig(req, res, path);
        },
      },
      {
        method: 'GET',
        pattern: /^\/content\/radio\/custom$/,
        handler: async (_req, res) => this.handleCustomRadioList(res),
      },
      {
        method: 'POST',
        pattern: /^\/content\/radio\/custom$/,
        handler: async (req, res) => this.handleCustomRadioAdd(req, res),
      },
      {
        method: 'POST',
        pattern: /^\/content\/radio\/tunein\/validate$/,
        handler: async (req, res) => this.handleTuneInValidate(req, res),
      },
      {
        method: 'DELETE',
        pattern: /^\/content\/radio\/custom\/([^/]+)$/,
        handler: async (_req, res, match) => {
          const stationId = decodeURIComponent(match[1] ?? '');
          if (!stationId) {
            this.sendJson(res, 400, { error: 'invalid-station-id' });
            return;
          }
          await this.handleCustomRadioDelete(stationId, res);
        },
      },
      {
        method: 'POST',
        pattern: /^\/zones\/(\d+)\/favorites\/(purge|copy)$/,
        handler: async (req, res, match) => {
          const zoneId = Number(match[1]);
          const action = match[2];
          if (!Number.isFinite(zoneId) || zoneId <= 0) {
            this.sendJson(res, 400, { error: 'invalid-zone-id' });
            return;
          }
          if (action === 'purge') {
            await this.handleZoneFavoritesPurge(zoneId, res);
          } else {
            await this.handleZoneFavoritesCopy(zoneId, req, res);
          }
        },
      },
      {
        method: 'POST',
        pattern: /^\/zones\/(\d+)\/recents\/purge$/,
        handler: async (_req, res, match) => {
          const zoneId = Number(match[1]);
          if (!Number.isFinite(zoneId) || zoneId <= 0) {
            this.sendJson(res, 400, { error: 'invalid-zone-id' });
            return;
          }
          await this.handleZoneRecentsPurge(zoneId, res);
        },
      },
      {
        method: 'POST',
        pattern: /^\/zones\/favorites\/purge$/,
        handler: async (_req, res) => this.handleFavoritesPurge(res),
      },
      {
        method: 'POST',
        pattern: /^\/zones\/recents\/purge$/,
        handler: async (_req, res) => this.handleRecentsPurge(res),
      },
      {
        method: 'POST',
        pattern: /^\/alerts\/event-sounds\/upload$/,
        handler: async (req, res) => this.handleEventSoundUpload(req, res),
      },
      {
        method: 'GET',
        pattern: /^\/alerts\/files$/,
        handler: async (_req, res) => this.handleAlertFilesList(res),
      },
      {
        method: 'POST',
        pattern: /^\/alerts\/files\/([^/]+)(?:\/([^/]+))?$/,
        handler: async (req, res, match) => {
          const alertId = decodeURIComponent(match[1] ?? '');
          const action = match[2];
          if (!alertId) {
            this.sendJson(res, 400, { error: 'invalid-alert-id' });
            return;
          }
          if (action === 'revert') {
            await this.handleAlertFileRevert(alertId, res);
          } else {
            await this.handleAlertFileUpdate(req, res, alertId);
          }
        },
      },
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

  private isPublicRoute(pathname: string, method: string): boolean {
    if (method === 'OPTIONS') return true;
    if (pathname === '/info' && method === 'GET') return true;
    if (pathname === '/auth/login' && method === 'POST') return true;
    if (pathname === '/auth/logout' && method === 'POST') return true;
    if (pathname === '/auth/me' && method === 'GET') return true;
    if (/^\/spotify\/auth\/callback/.test(pathname)) return true;
    if (/^\/spotify\/librespot\/credentials/.test(pathname)) return true;
    return false;
  }

  private parseCookies(req: IncomingMessage): Record<string, string> {
    const raw = req.headers.cookie;
    if (!raw) return {};
    const cookies: Record<string, string> = {};
    for (const entry of raw.split(';')) {
      const [key, ...rest] = entry.split('=');
      const name = key?.trim();
      if (!name) continue;
      const value = rest.join('=').trim();
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        cookies[name] = value;
      }
    }
    return cookies;
  }

  private cleanupExpiredAdminSessions(now = Date.now()): void {
    for (const [id, session] of this.adminSessions.entries()) {
      if (session.expiresAt <= now) {
        this.adminSessions.delete(id);
      }
    }
  }

  private getAdminSessionFromRequest(req: IncomingMessage): AdminServerSession | null {
    this.cleanupExpiredAdminSessions();
    const sessionId = this.parseCookies(req)[AUTH_COOKIE_NAME];
    if (!sessionId) return null;
    const session = this.adminSessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.adminSessions.delete(sessionId);
      return null;
    }
    return session;
  }

  private createAdminSession(username: string): AdminServerSession {
    this.cleanupExpiredAdminSessions();
    const now = Date.now();
    const session: AdminServerSession = {
      id: randomBytes(32).toString('hex'),
      username,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    this.adminSessions.set(session.id, session);
    return session;
  }

  private clearAdminSessionFromRequest(req: IncomingMessage): void {
    const sessionId = this.parseCookies(req)[AUTH_COOKIE_NAME];
    if (!sessionId) return;
    this.adminSessions.delete(sessionId);
  }

  private buildAuthCookie(req: IncomingMessage, session: AdminServerSession): string {
    const parts = [
      `${AUTH_COOKIE_NAME}=${encodeURIComponent(session.id)}`,
      'Path=/admin/api',
      'HttpOnly',
      'SameSite=Lax',
    ];
    if (Boolean((req.socket as { encrypted?: boolean }).encrypted)) {
      parts.push('Secure');
    }
    return parts.join('; ');
  }

  private buildExpiredAuthCookie(req: IncomingMessage): string {
    const parts = [
      `${AUTH_COOKIE_NAME}=`,
      'Path=/admin/api',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=0',
    ];
    if (Boolean((req.socket as { encrypted?: boolean }).encrypted)) {
      parts.push('Secure');
    }
    return parts.join('; ');
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
      if (cfg.system.audioserver.paired && !this.isPublicRoute(pathname, method)) {
        const session = this.getAdminSessionFromRequest(req);
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
        const provider = providers[index];
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

  private handleInfo(res: ServerResponse): void {
    try {
      const cfg = this.configPort.getConfig();
      const pkgVersion = this.readPackageVersion();
      const buildVersion = this.readBuildVersion(pkgVersion);
      const packages = this.readAddonPackageVersions();

      const payload = {
        version: buildVersion,
        uptime: Math.floor(process.uptime()),
        name: cfg.system.audioserver.name ?? 'Unconfigured',
        serial: cfg.system.audioserver.macId ?? '',
        firmwareVersion: this.runtimeConfig.loxone.firmwareVersion,
        apiVersion: this.runtimeConfig.loxone.apiVersion,
        miniserverIp: cfg.system.miniserver.ip ?? '',
        miniserverSerial: cfg.system.miniserver.serial ?? '',
        zones: cfg.zones?.length ?? 0,
        activeAdapters: cfg.system.audioserver.extensions?.length ?? 0,
        paired: !!cfg.system.audioserver.paired,
        packages,
        containerized: this.containerized,
      };

      this.sendJson(res, 200, payload);
    } catch (err) {
      this.log.error('failed to produce admin info', { err });
      this.sendJson(res, 500, { error: 'info-unavailable' });
    }
  }

  private async handleAuthLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readJsonBody(req, res)) as { username?: string; password?: string } | null;
    if (res.writableEnded) return;

    const username = body?.username?.trim() ?? '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!username || !password) {
      this.sendJson(res, 400, { error: 'invalid-auth-payload' });
      return;
    }

    const cfg = this.configPort.getConfig();
    if (!cfg.system.audioserver.paired) {
      this.sendJson(res, 409, { error: 'miniserver-auth-required' });
      return;
    }
    const miniserverBaseUrl = this.readMiniserverBaseUrlFromConfig(cfg);
    if (!miniserverBaseUrl) {
      this.sendJson(res, 409, { error: 'miniserver-not-configured' });
      return;
    }

    try {
      const result = await this.verifyMiniserverAdminCredentials(miniserverBaseUrl, username, password);
      const session = this.createAdminSession(username);
      res.setHeader('Set-Cookie', this.buildAuthCookie(req, session));
      this.sendJson(res, 200, {
        ok: true,
        username,
        tokenRights: result.tokenRights,
        loginAt: session.createdAt,
        expiresAt: session.expiresAt,
      });
    } catch (err) {
      if (err instanceof MiniserverAuthError) {
        this.log.warn('miniserver auth failed', { code: err.code, message: err.message, username, miniserverBaseUrl });
        if (err.code === 'invalid-credentials') {
          this.sendJson(res, 401, { error: err.code });
          return;
        }
        if (err.code === 'insufficient-permissions') {
          this.sendJson(res, 403, { error: err.code });
          return;
        }
        if (err.code === 'miniserver-not-configured') {
          this.sendJson(res, 409, { error: err.code });
          return;
        }
        this.sendJson(res, 502, { error: err.code, miniserverHost: miniserverBaseUrl, message: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('miniserver auth failed', { message, username });
      this.sendJson(res, 502, { error: 'miniserver-unreachable', miniserverHost: miniserverBaseUrl });
    }
  }

  private async handleAuthMe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const session = this.getAdminSessionFromRequest(req);
    if (!session) {
      this.sendJson(res, 401, { error: 'auth-required' });
      return;
    }
    this.sendJson(res, 200, { ok: true, username: session.username, loginAt: session.createdAt, expiresAt: session.expiresAt });
  }

  private async handleAuthLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.clearAdminSessionFromRequest(req);
    res.setHeader('Set-Cookie', this.buildExpiredAuthCookie(req));
    this.sendJson(res, 204, {});
  }

  private async verifyMiniserverAdminCredentials(
    baseUrl: string,
    username: string,
    password: string,
  ): Promise<{ tokenRights: number | null }> {
    let salts: { oneTimeSalt: string; salt: string; hashAlg: HashAlgorithm };
    let authHash: string;
    let tokenRights: number | null;
    try {
      const publicKey = await this.fetchMiniserverPublicKey(baseUrl);
      salts = await this.fetchMiniserverTokenSalts(baseUrl, publicKey, username);
      authHash = this.buildMiniserverAuthHash(username, password, salts);
      tokenRights = await this.requestMiniserverAdminToken(baseUrl, publicKey, username, authHash);
    } catch (err) {
      if (!(err instanceof MiniserverAuthError) || err.code !== 'miniserver-protocol') {
        throw err;
      }
      salts = await this.fetchMiniserverTokenSaltsPlain(baseUrl, username);
      authHash = this.buildMiniserverAuthHash(username, password, salts);
      tokenRights = await this.requestMiniserverAdminTokenPlain(baseUrl, username, authHash);
    }

    if (tokenRights !== null && (tokenRights & MINISERVER_ADMIN_PERMISSION) === 0) {
      throw new MiniserverAuthError('insufficient-permissions', 'miniserver user is not admin');
    }
    return { tokenRights };
  }

  private readMiniserverBaseUrlFromConfig(cfg: AudioServerConfig): string {
    const host = cfg.system?.miniserver?.ip?.trim() ?? '';
    if (!host) {
      return '';
    }
    const port = cfg.system?.miniserver?.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) {
      return '';
    }
    const protocol = cfg.system?.miniserver?.protocol === 'https' ? 'https' : 'http';
    return this.buildMiniserverBaseUrl(host, port, protocol);
  }

  private buildMiniserverBaseUrl(host: string, port: number, protocol: 'http' | 'https'): string {
    const includePort = (protocol === 'https' && port !== 443) || (protocol === 'http' && port !== 80);
    if (includePort) {
      return `${protocol}://${host}:${port}`;
    }
    return `${protocol}://${host}`;
  }

  private async fetchMiniserverPublicKey(baseUrl: string): Promise<string> {
    const payload = await this.requestMiniserverJson(baseUrl, 'jdev/sys/getPublicKey');
    const value = this.extractMiniserverValue(payload);
    if (typeof value !== 'string' || !value.trim()) {
      throw new MiniserverAuthError('miniserver-protocol', 'missing miniserver public key');
    }
    return this.normalizeMiniserverPublicKey(value);
  }

  private async fetchMiniserverTokenSalts(
    baseUrl: string,
    publicKey: string,
    username: string,
  ): Promise<{ oneTimeSalt: string; salt: string; hashAlg: HashAlgorithm }> {
    const payload = await this.requestMiniserverEncryptedJson(baseUrl, `jdev/sys/getkey2/${encodeURIComponent(username)}`, publicKey);
    const value = this.extractMiniserverValue(payload);
    const obj = this.asObject(value);
    const oneTimeSalt = this.readString(obj.key);
    const salt = this.readString(obj.salt);
    const hashAlg = this.normalizeHashAlgorithm(this.readString(obj.hashAlg) || 'SHA1');
    if (!oneTimeSalt || !salt) {
      throw new MiniserverAuthError('miniserver-protocol', 'missing miniserver salt data');
    }
    return { oneTimeSalt, salt, hashAlg };
  }

  private async fetchMiniserverTokenSaltsPlain(
    baseUrl: string,
    username: string,
  ): Promise<{ oneTimeSalt: string; salt: string; hashAlg: HashAlgorithm }> {
    const payload = await this.requestMiniserverJson(baseUrl, `jdev/sys/getkey2/${encodeURIComponent(username)}`);
    const value = this.extractMiniserverValue(payload);
    const obj = this.asObject(value);
    const oneTimeSalt = this.readString(obj.key);
    const salt = this.readString(obj.salt);
    const hashAlg = this.normalizeHashAlgorithm(this.readString(obj.hashAlg) || 'SHA1');
    if (!oneTimeSalt || !salt) {
      throw new MiniserverAuthError('miniserver-protocol', 'missing miniserver salt data');
    }
    return { oneTimeSalt, salt, hashAlg };
  }

  private buildMiniserverAuthHash(
    username: string,
    password: string,
    salts: { oneTimeSalt: string; salt: string; hashAlg: HashAlgorithm },
  ): string {
    const hashName = salts.hashAlg === 'SHA256' ? 'sha256' : 'sha1';
    const pwHash = createHash(hashName).update(`${password}:${salts.salt}`, 'utf8').digest('hex').toUpperCase();
    return createHmac(hashName, Buffer.from(salts.oneTimeSalt, 'hex'))
      .update(`${username}:${pwHash}`, 'utf8')
      .digest('hex');
  }

  private async requestMiniserverAdminToken(
    baseUrl: string,
    publicKey: string,
    username: string,
    authHash: string,
  ): Promise<number | null> {
    const deviceUuid = randomUUID();
    const deviceInfo = encodeURIComponent('Lox-AudioServer Admin UI').replace(/\//g, ' ');
    const jwtCmd =
      `jdev/sys/getjwt/${authHash}/${encodeURIComponent(username)}/${MINISERVER_ADMIN_PERMISSION}/` +
      `${deviceUuid}/${deviceInfo}`;
    const tokenCmd =
      `jdev/sys/gettoken/${authHash}/${encodeURIComponent(username)}/${MINISERVER_ADMIN_PERMISSION}/` +
      `${deviceUuid}/${deviceInfo}`;

    let payload: unknown;
    try {
      payload = await this.requestMiniserverEncryptedJson(baseUrl, jwtCmd, publicKey);
    } catch (err) {
      if (err instanceof MiniserverAuthError && err.code === 'invalid-credentials') {
        throw err;
      }
      payload = await this.requestMiniserverEncryptedJson(baseUrl, tokenCmd, publicKey);
    }
    const value = this.extractMiniserverValue(payload);
    const obj = this.asObject(value);
    const rights = this.readNumber(obj.tokenRights);
    if (rights !== null) return rights;
    return this.readNumber(obj.msPermission);
  }

  private async requestMiniserverAdminTokenPlain(
    baseUrl: string,
    username: string,
    authHash: string,
  ): Promise<number | null> {
    const deviceUuid = randomUUID();
    const deviceInfo = encodeURIComponent('Lox-AudioServer Admin UI').replace(/\//g, ' ');
    const jwtCmd =
      `jdev/sys/getjwt/${authHash}/${encodeURIComponent(username)}/${MINISERVER_ADMIN_PERMISSION}/` +
      `${deviceUuid}/${deviceInfo}`;
    const tokenCmd =
      `jdev/sys/gettoken/${authHash}/${encodeURIComponent(username)}/${MINISERVER_ADMIN_PERMISSION}/` +
      `${deviceUuid}/${deviceInfo}`;

    let payload: unknown;
    try {
      payload = await this.requestMiniserverJson(baseUrl, jwtCmd);
    } catch (err) {
      if (err instanceof MiniserverAuthError && err.code === 'invalid-credentials') {
        throw err;
      }
      payload = await this.requestMiniserverJson(baseUrl, tokenCmd);
    }
    const value = this.extractMiniserverValue(payload);
    const obj = this.asObject(value);
    const rights = this.readNumber(obj.tokenRights);
    if (rights !== null) return rights;
    return this.readNumber(obj.msPermission);
  }

  private async requestMiniserverJson(baseUrl: string, command: string): Promise<unknown> {
    const raw = await this.fetchMiniserverText(baseUrl, command);
    const parsed = this.tryParseJson(raw) ?? this.tryParseLooseJson(raw);
    if (parsed === null) {
      const lower = raw.toLowerCase();
      if (lower.includes('401') || lower.includes('403') || lower.includes('unauthorized') || lower.includes('forbidden')) {
        throw new MiniserverAuthError('invalid-credentials', 'invalid miniserver credentials');
      }
      throw new MiniserverAuthError('miniserver-protocol', 'invalid miniserver response');
    }
    this.ensureMiniserverSuccess(parsed);
    return parsed;
  }

  private async requestMiniserverEncryptedJson(
    baseUrl: string,
    command: string,
    publicKey: string,
  ): Promise<unknown> {
    const aesKey = randomBytes(32);
    const aesIv = randomBytes(16);
    const salt = randomBytes(2).toString('hex');
    const encryptedCmd = this.encryptMiniserverCommand(command, salt, aesKey, aesIv, publicKey);
    const raw = await this.fetchMiniserverText(baseUrl, encryptedCmd);

    // Some Miniserver builds can return LL-wrapped JSON even for encrypted HTTP commands.
    const directPayload = this.tryParseJson(raw);
    if (directPayload !== null) {
      this.ensureMiniserverSuccess(directPayload);
      const llValue = this.asObject(this.asObject(directPayload).LL).value;
      if (typeof llValue === 'string' && llValue.trim()) {
        const maybeDecrypted = this.tryDecryptMiniserverResponse(llValue, aesKey, aesIv);
        if (maybeDecrypted !== null) {
          this.ensureMiniserverSuccess(maybeDecrypted);
          return maybeDecrypted;
        }
      }
      return directPayload;
    }

    let decrypted: string;
    try {
      decrypted = this.decryptMiniserverResponse(raw, aesKey, aesIv);
    } catch {
      throw new MiniserverAuthError('miniserver-protocol', 'failed to decrypt miniserver response');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decrypted);
    } catch {
      throw new MiniserverAuthError('miniserver-protocol', 'invalid decrypted miniserver response');
    }
    this.ensureMiniserverSuccess(parsed);
    return parsed;
  }

  private encryptMiniserverCommand(
    command: string,
    salt: string,
    aesKey: Buffer,
    aesIv: Buffer,
    publicKey: string,
  ): string {
    const payload = `salt/${salt}/${command}`;
    const blockSize = 16;
    const payloadBuf = Buffer.from(payload, 'utf8');
    const remainder = payloadBuf.length % blockSize;
    const padded = remainder === 0 ? payloadBuf : Buffer.concat([payloadBuf, Buffer.alloc(blockSize - remainder)]);
    const cipher = createCipheriv('aes-256-cbc', aesKey, aesIv);
    cipher.setAutoPadding(false);
    const cipherText = Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
    const sessionPayload = `${aesKey.toString('hex')}:${aesIv.toString('hex')}`;
    let sk: string;
    try {
      sk = publicEncrypt(
        {
          key: publicKey,
          padding: cryptoConstants.RSA_PKCS1_PADDING,
        },
        Buffer.from(sessionPayload, 'utf8'),
      ).toString('base64');
    } catch {
      throw new MiniserverAuthError('miniserver-protocol', 'invalid miniserver public key');
    }
    return `jdev/sys/fenc/${encodeURIComponent(cipherText)}?sk=${encodeURIComponent(sk)}`;
  }

  private normalizeMiniserverPublicKey(rawValue: string): string {
    const addCandidate = (bucket: string[], value: string): void => {
      const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
      if (!normalized) return;
      if (!bucket.includes(normalized)) bucket.push(normalized);
    };

    const formatPem = (label: 'CERTIFICATE' | 'PUBLIC KEY', base64Body: string): string => {
      const chunks = base64Body.match(/.{1,64}/g) ?? [base64Body];
      return `-----BEGIN ${label}-----\n${chunks.join('\n')}\n-----END ${label}-----`;
    };

    const maybeCanonicalPem = (value: string): string | null => {
      const match = value.match(/^-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----$/);
      if (!match) return null;
      const label = (match[1] ?? '').trim();
      if (label !== 'CERTIFICATE' && label !== 'PUBLIC KEY') return null;
      const body = (match[2] ?? '').replace(/[^A-Za-z0-9+/=]/g, '');
      if (!body) return null;
      return formatPem(label as 'CERTIFICATE' | 'PUBLIC KEY', body);
    };

    const maybeBase64Body = (value: string): string | null => {
      const compact = value.replace(/\s+/g, '');
      if (compact.length < 64) return null;
      if (!/^[A-Za-z0-9+/=]+$/.test(compact)) return null;
      return compact;
    };

    const maybeBase64UrlBody = (value: string): string | null => {
      const compact = value.replace(/\s+/g, '');
      if (compact.length < 64) return null;
      if (!/^[A-Za-z0-9\-_]+={0,2}$/.test(compact)) return null;
      return compact.replace(/-/g, '+').replace(/_/g, '/');
    };

    const maybeHexBody = (value: string): string | null => {
      const compact = value.replace(/\s+/g, '');
      if (compact.length < 128 || compact.length % 2 !== 0) return null;
      if (!/^[0-9a-fA-F]+$/.test(compact)) return null;
      return compact;
    };

    const canEncryptWithKey = (key: string | Buffer): boolean => {
      try {
        publicEncrypt(
          {
            key,
            padding: cryptoConstants.RSA_PKCS1_PADDING,
          },
          Buffer.from('00:00', 'utf8'),
        );
        return true;
      } catch {
        return false;
      }
    };

    const extractPemPublicKeyFromCertificate = (value: string | Buffer): string | null => {
      try {
        const cert = new X509Certificate(value);
        const exported = cert.publicKey.export({ type: 'spki', format: 'pem' });
        return String(exported);
      } catch {
        return null;
      }
    };

    const extractPemPublicKeyFromSpkiDer = (der: Buffer): string | null => {
      try {
        const key = createPublicKey({ key: der, type: 'spki', format: 'der' });
        const exported = key.export({ type: 'spki', format: 'pem' });
        return String(exported);
      } catch {
        return null;
      }
    };

    const candidates: string[] = [];
    addCandidate(candidates, rawValue);
    try {
      addCandidate(candidates, decodeURIComponent(rawValue));
    } catch {
      // keep raw value if it is not URL-encoded
    }

    const expandedCandidates = [...candidates];
    for (const candidate of candidates) {
      addCandidate(expandedCandidates, candidate.replace(/\\n/g, '\n'));
      addCandidate(expandedCandidates, candidate.replace(/\s+/g, '+'));
      const canonicalPem = maybeCanonicalPem(candidate);
      if (canonicalPem) {
        addCandidate(expandedCandidates, canonicalPem);
      }
      const body = maybeBase64Body(candidate) ?? maybeBase64UrlBody(candidate);
      if (body !== null) {
        addCandidate(expandedCandidates, formatPem('CERTIFICATE', body));
        addCandidate(expandedCandidates, formatPem('PUBLIC KEY', body));
      }
    }

    for (const candidate of expandedCandidates) {
      if (canEncryptWithKey(candidate)) {
        return candidate;
      }

      const certPem = extractPemPublicKeyFromCertificate(candidate);
      if (certPem !== null && canEncryptWithKey(certPem)) {
        return certPem;
      }

      const base64Body = maybeBase64Body(candidate) ?? maybeBase64UrlBody(candidate);
      if (base64Body !== null) {
        const der = Buffer.from(base64Body, 'base64');
        const spkiPem = extractPemPublicKeyFromSpkiDer(der);
        if (spkiPem !== null && canEncryptWithKey(spkiPem)) {
          return spkiPem;
        }
        const certPemFromDer = extractPemPublicKeyFromCertificate(der);
        if (certPemFromDer !== null && canEncryptWithKey(certPemFromDer)) {
          return certPemFromDer;
        }
      }

      const hexBody = maybeHexBody(candidate);
      if (hexBody !== null) {
        const der = Buffer.from(hexBody, 'hex');
        const spkiPem = extractPemPublicKeyFromSpkiDer(der);
        if (spkiPem !== null && canEncryptWithKey(spkiPem)) {
          return spkiPem;
        }
        const certPemFromDer = extractPemPublicKeyFromCertificate(der);
        if (certPemFromDer !== null && canEncryptWithKey(certPemFromDer)) {
          return certPemFromDer;
        }
      }
    }

    throw new MiniserverAuthError('miniserver-protocol', 'unsupported miniserver public key format');
  }

  private decryptMiniserverResponse(raw: string, aesKey: Buffer, aesIv: Buffer): string {
    const sanitized = raw.trim().replace(/\s+/g, '');
    let cipherBuf = Buffer.from(sanitized, 'base64');
    const blockSize = 16;
    const remainder = cipherBuf.length % blockSize;
    if (remainder !== 0) {
      cipherBuf = Buffer.concat([cipherBuf, Buffer.alloc(blockSize - remainder)]);
    }
    const decipher = createDecipheriv('aes-256-cbc', aesKey, aesIv);
    decipher.setAutoPadding(false);
    const plain = Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
    return plain.toString('utf8').replace(/\u0000+$/g, '');
  }

  private async fetchMiniserverText(baseUrl: string, command: string): Promise<string> {
    const url = `${baseUrl.replace(/\/+$/, '')}/${command.replace(/^\/+/, '')}`;
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET' });
    } catch {
      throw new MiniserverAuthError('miniserver-unreachable', 'miniserver request failed');
    }
    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new MiniserverAuthError('invalid-credentials', 'invalid miniserver credentials');
    }
    if (!res.ok && !text) {
      throw new MiniserverAuthError('miniserver-unreachable', `miniserver http ${res.status}`);
    }
    return text;
  }

  private ensureMiniserverSuccess(payload: unknown): void {
    const ll = this.asObject(this.asObject(payload).LL);
    const code = this.readNumber(ll.Code) ?? this.readNumber(ll.code);
    if (code === null) {
      throw new MiniserverAuthError('miniserver-protocol', 'missing miniserver code');
    }
    if (code >= 200 && code < 400) return;
    if (code === 401 || code === 403) {
      throw new MiniserverAuthError('invalid-credentials', 'invalid miniserver credentials');
    }
    throw new MiniserverAuthError('miniserver-protocol', `miniserver rejected command (${code})`);
  }

  private extractMiniserverValue(payload: unknown): unknown {
    const value = this.asObject(this.asObject(payload).LL).value;
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed) return value;
    const parsed = this.tryParseJson(trimmed) ?? this.tryParseLooseJson(trimmed);
    return parsed ?? value;
  }

  private normalizeHashAlgorithm(value: string): HashAlgorithm {
    return value.toUpperCase() === 'SHA256' ? 'SHA256' : 'SHA1';
  }

  private tryDecryptMiniserverResponse(raw: string, aesKey: Buffer, aesIv: Buffer): unknown | null {
    try {
      const decrypted = this.decryptMiniserverResponse(raw, aesKey, aesIv);
      return this.tryParseJson(decrypted);
    } catch {
      return null;
    }
  }

  private tryParseJson(raw: string): unknown | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  private tryParseLooseJson(raw: string): unknown | null {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    try {
      return JSON.parse(trimmed.replace(/\'/g, '"'));
    } catch {
      // fall through to more selective normalization
    }
    const normalized = trimmed
      .replace(/([{,]\s*)'([^']+?)'\s*:/g, '$1"$2":')
      .replace(/:\s*'([^']*?)'(\s*[},\]])/g, ':"$1"$2');
    try {
      return JSON.parse(normalized);
    } catch {
      return null;
    }
  }

  private asObject(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    throw new MiniserverAuthError('miniserver-protocol', 'invalid miniserver object response');
  }

  private readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private readNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private detectContainerized(): boolean {
    const forced = (process.env.LOX_DEPLOYMENT ?? '').trim().toLowerCase();
    if (forced === 'docker' || forced === 'container') return true;
    if (forced === 'git' || forced === 'host' || forced === 'standalone') return false;

    if (existsSync('/.dockerenv')) return true;

    try {
      const cgroup = readFileSync('/proc/1/cgroup', 'utf8');
      return /(docker|containerd|kubepods|podman|lxc)/i.test(cgroup);
    } catch {
      return false;
    }
  }

  private readAddonPackageVersions(): Record<string, { installed: string | null; declared: string | null }> {
    const declared = this.readDeclaredAddonPackages();
    const result: Record<string, { installed: string | null; declared: string | null }> = {};
    for (const [name, declaredRange] of Object.entries(declared)) {
      result[name] = {
        declared: declaredRange ?? null,
        installed: this.readInstalledPackageVersion(name),
      };
    }
    return result;
  }

  private readDeclaredAddonPackages(): Record<string, string> {
    try {
      const json = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8');
      const parsed = JSON.parse(json) as { dependencies?: Record<string, string> };
      const deps = parsed.dependencies ?? {};
      const result: Record<string, string> = {};
      for (const [name, range] of Object.entries(deps)) {
        if (!name.startsWith(ADDON_PACKAGE_PREFIX)) continue;
        if (typeof range !== 'string') continue;
        result[name] = range;
      }
      return result;
    } catch {
      return {};
    }
  }

  private readInstalledPackageVersion(name: string): string | null {
    try {
      const parts = name.split('/').filter(Boolean);
      const pkgJsonPath = resolve(process.cwd(), 'node_modules', ...parts, 'package.json');
      const json = readFileSync(pkgJsonPath, 'utf8');
      const parsed = JSON.parse(json) as { version?: string };
      return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : null;
    } catch {
      return null;
    }
  }

  private async handleReinitialize(res: ServerResponse): Promise<void> {
    if (!this.onReinitialize) {
      this.sendJson(res, 501, { error: 'reinitialize-not-supported' });
      return;
    }

    try {
      const ok = await this.onReinitialize();
      if (!ok) {
        this.sendJson(res, 500, { error: 'reinitialize-failed' });
        return;
      }
      this.sendJson(res, 200, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error('reinitialize failed', { message });
      this.sendJson(res, 500, { error: 'reinitialize-error', message });
    }
  }

  private async handleAdminUiUpdate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.adminUiUpdateInFlight) {
      this.sendJson(res, 409, { error: 'adminui-update-in-progress' });
      return;
    }

    const body = (await this.readJsonBody(req, res)) as AdminUiUpdateRequest | null;
    if (res.writableEnded) {
      return;
    }
    const release = typeof body?.release === 'string' ? body.release.trim() : '';

    const task = this.performAdminUiUpdate(release || undefined);
    this.adminUiUpdateInFlight = task;
    try {
      const result = await task;
      if (!result.ok) {
        this.sendJson(res, 500, result);
        return;
      }
      this.sendJson(res, 200, result);
    } finally {
      if (this.adminUiUpdateInFlight === task) {
        this.adminUiUpdateInFlight = null;
      }
    }
  }

  private async handleComponentPackageUpdate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.componentPackageUpdateInFlight) {
      this.sendJson(res, 409, { error: 'component-update-in-progress' });
      return;
    }

    const body = (await this.readJsonBody(req, res)) as ComponentPackageUpdateRequest | null;
    if (res.writableEnded) {
      return;
    }

    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const requestedVersionRaw = typeof body?.version === 'string' ? body.version.trim() : '';
    if (!name) {
      this.sendJson(res, 400, { error: 'component-name-required' });
      return;
    }
    const declaredPackages = this.readDeclaredAddonPackages();
    if (!Object.prototype.hasOwnProperty.call(declaredPackages, name)) {
      this.sendJson(res, 400, { error: 'component-not-declared' });
      return;
    }
    if (!name.startsWith(ADDON_PACKAGE_PREFIX)) {
      this.sendJson(res, 400, { error: 'invalid-component-package' });
      return;
    }

    const requestedVersion = requestedVersionRaw || null;
    if (requestedVersion && !/^[0-9A-Za-z.+_-]+$/.test(requestedVersion)) {
      this.sendJson(res, 400, { error: 'invalid-component-version' });
      return;
    }

    const task = this.performComponentPackageUpdate(name, requestedVersion);
    this.componentPackageUpdateInFlight = task;
    try {
      const result = await task;
      if (!result.ok) {
        this.sendJson(res, 500, result);
        return;
      }
      this.sendJson(res, 200, result);
    } finally {
      if (this.componentPackageUpdateInFlight === task) {
        this.componentPackageUpdateInFlight = null;
      }
    }
  }

  private readPackageVersion(): string {
    try {
      const json = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8');
      const parsed = JSON.parse(json) as { version?: string };
      return parsed.version ?? 'dev';
    } catch {
      return 'dev';
    }
  }

  private readBuildVersion(pkgVersion: string): string {
    const tsRaw = process.env.BUILD_TIMESTAMP?.trim();
    if (!tsRaw) {
      return pkgVersion;
    }
    const normalizedTs = tsRaw.replace(/[^0-9A-Za-z._-]/g, '');
    if (!normalizedTs) {
      return pkgVersion;
    }
    return `${pkgVersion}+${normalizedTs}`;
  }

  private async performComponentPackageUpdate(
    name: string,
    requestedVersion: string | null,
  ): Promise<ComponentPackageUpdateResult> {
    const packageSpec = requestedVersion ? `${name}@${requestedVersion}` : `${name}@latest`;
    this.log.info('component update started', { packageSpec });

    try {
      const { code, stderr } = await this.spawnForCompletion('npm', ['install', packageSpec, '--no-audit', '--no-fund'], process.cwd());
      if (code !== 0) {
        const message = stderr.trim() || `npm exited with code ${code}`;
        this.log.warn('component update failed', { packageSpec, message });
        return {
          ok: false,
          name,
          requestedVersion,
          installed: this.readInstalledPackageVersion(name),
          declared: this.readDeclaredAddonPackages()[name] ?? null,
          error: message,
        };
      }

      const installed = this.readInstalledPackageVersion(name);
      const declared = this.readDeclaredAddonPackages()[name] ?? null;
      this.log.info('component update finished', { packageSpec, installed, declared });
      return {
        ok: true,
        name,
        requestedVersion,
        installed,
        declared,
        updatedAt: new Date().toISOString(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('component update failed', { packageSpec, message });
      return {
        ok: false,
        name,
        requestedVersion,
        installed: this.readInstalledPackageVersion(name),
        declared: this.readDeclaredAddonPackages()[name] ?? null,
        error: message,
      };
    }
  }

  private async performAdminUiUpdate(releaseOverride?: string): Promise<AdminUiUpdateResult> {
    const repo = 'lox-audioserver/adminui';
    const assetName = 'admin-dist.tgz';
    const release = releaseOverride || process.env.ADMINUI_RELEASE || 'latest';
    const distUrl =
      process.env.ADMINUI_DIST_URL ??
      (release === 'latest'
        ? `https://github.com/${repo}/releases/latest/download/${assetName}`
        : `https://github.com/${repo}/releases/download/${encodeURIComponent(release)}/${assetName}`);
    const targetDir = join(this.runtimeConfig.http.publicDir, 'admin');
    const stagingDir = join(this.runtimeConfig.http.publicDir, `admin-staging-${Date.now()}`);
    const backupDir = join(this.runtimeConfig.http.publicDir, `admin-backup-${Date.now()}`);
    const archivePath = join(os.tmpdir(), `admin-dist-${Date.now()}.tgz`);

    this.log.info('admin ui update started', { release, distUrl, targetDir });

    const baseResult = { release, distUrl, targetDir };
    let backupCreated = false;

    try {
      try {
        await fs.rm(archivePath, { force: true });
      } catch {
        // Best-effort cleanup.
      }
      await fs.rm(stagingDir, { recursive: true, force: true });
      await fs.mkdir(stagingDir, { recursive: true });

      await this.downloadAdminUi(distUrl, archivePath);
      await this.extractAdminUi(archivePath, stagingDir);
      try {
        await fs.rm(archivePath, { force: true });
      } catch {
        // Best-effort cleanup.
      }

      if (await this.pathExists(targetDir)) {
        await fs.rm(backupDir, { recursive: true, force: true });
        await fs.rename(targetDir, backupDir);
        backupCreated = true;
      }
      await fs.rename(stagingDir, targetDir);
      if (backupCreated) {
        try {
          await fs.rm(backupDir, { recursive: true, force: true });
        } catch (cleanupErr) {
          const cleanupMessage =
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
          this.log.warn('admin ui cleanup failed', { cleanupMessage });
        }
      }

      this.log.info('admin ui update finished', { release, distUrl });
      return { ok: true, updatedAt: new Date().toISOString(), ...baseResult };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('admin ui update failed', { release, distUrl, message });

      try {
        if (await this.pathExists(stagingDir)) {
          await fs.rm(stagingDir, { recursive: true, force: true });
        }
      } catch {
        // Best-effort cleanup.
      }

      try {
        await fs.rm(archivePath, { force: true });
      } catch {
        // Best-effort cleanup.
      }

      if (backupCreated) {
        try {
          await fs.rm(targetDir, { recursive: true, force: true });
          await fs.rename(backupDir, targetDir);
        } catch (rollbackErr) {
          const rollbackMessage =
            rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
          this.log.warn('admin ui rollback failed', { rollbackMessage });
        }
      }

      return { ok: false, error: message, ...baseResult };
    }
  }

  private async downloadAdminUi(url: string, dest: string, redirects = 0): Promise<void> {
    if (redirects > 5) {
      throw new Error(`Too many redirects while downloading ${url}`);
    }

    await new Promise<void>((resolve, reject) => {
      const request = https.get(
        url,
        { headers: { 'User-Agent': 'lox-audioserver-admin-fetch' } },
        (response) => {
          const status = response.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
            response.resume();
            resolve(this.downloadAdminUi(response.headers.location, dest, redirects + 1));
            return;
          }

          if (status !== 200) {
            response.resume();
            reject(new Error(`Failed to download admin dist (${status}) from ${url}`));
            return;
          }

          pipeline(response, createWriteStream(dest)).then(resolve).catch(reject);
        },
      );

      request.on('error', reject);
    });
  }

  private async extractAdminUi(archive: string, dest: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('tar', ['-xzf', archive, '-C', dest], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      let stderr = '';
      if (proc.stderr) {
        proc.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });
      }

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          const suffix = stderr.trim() ? `: ${stderr.trim()}` : '';
          reject(new Error(`tar exited with code ${code}${suffix}`));
        }
      });
      proc.on('error', reject);
    });
  }

  private async spawnForCompletion(
    command: string,
    args: string[],
    cwd: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      if (proc.stdout) {
        proc.stdout.on('data', (chunk) => {
          stdout += chunk.toString();
        });
      }
      if (proc.stderr) {
        proc.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });
      }

      proc.on('close', (code) => {
        resolve({ code: code ?? 1, stdout, stderr });
      });
      proc.on('error', reject);
    });
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private readonly hiddenTransportIds = new Set(['spotify', 'sendspin-cast', 'dlna']);

  private handleTransportDefinitions(res: ServerResponse): void {
    const payload = OUTPUT_DEFINITIONS.filter(
      (definition) => !this.hiddenTransportIds.has(definition.id),
    ).map((definition) => ({
      id: definition.id,
      label: definition.label,
      description: definition.description ?? '',
      fields: definition.fields.map((field) => ({
        id: field.id,
        label: field.label,
        type: field.type,
        placeholder: field.placeholder ?? '',
        description: field.description ?? '',
        required: field.required ?? false,
      })),
    }));
    this.sendJson(res, 200, { transports: payload, stateControllers: STATE_CONTROLLER_DEFINITIONS });
  }

  private handleZoneStateControllerDefinitions(res: ServerResponse): void {
    this.sendJson(res, 200, { stateControllers: STATE_CONTROLLER_DEFINITIONS });
  }

  private async handleZoneStates(res: ServerResponse): Promise<void> {
    try {
      const cfg = this.configPort.getConfig();
      const clockOffsetMs = await this.getClockOffsetMs();
      const zones = (cfg.zones ?? []).map((zone) => {
        const state = this.zoneManager.getState(zone.id);
        const session = this.audioManager.getSession(zone.id);
        const playbackSource = session?.playbackSource;
        const effectiveOutput = this.audioManager.getEffectiveOutputSettings(zone.id);
        const techSnapshot = this.zoneManager.getTechnicalSnapshot(zone.id);
        const primaryOutput = this.getZoneOutputConfig(zone);
        const sendspinOutput =
          primaryOutput?.id === 'sendspin'
            ? (primaryOutput as { id: string; clientId?: string } & Record<string, unknown>)
            : undefined;
        const sendspinClientId =
          typeof sendspinOutput?.clientId === 'string' ? sendspinOutput.clientId : null;
        const backpressure =
          sendspinClientId != null ? sendspinCore.getBackpressureStats(sendspinClientId) : null;
        const sendspinFormat =
          sendspinClientId != null
            ? sendspinCore.getStreamFormat(sendspinClientId)
            : null;
        const sendspinBufferCap =
          sendspinClientId != null ? sendspinCore.getPlayerBufferCapacity(sendspinClientId) : null;
        const sendspinLead =
          sendspinClientId != null ? sendspinCore.getLeadStats(sendspinClientId) : null;
        const groupProtocol =
          techSnapshot?.transports && techSnapshot.transports.some((t) => t === 'sendspin') ? 'sendspin' : null;
        const streams = session
          ? {
              mp3: session.stream?.url ?? null,
              pcm: session.pcmStream?.url ?? null,
            }
          : undefined;
        const streamStats = this.audioManager.getStreamStats(zone.id);
        const tech =
          session || playbackSource
            ? {
                input: playbackSource
                  ? {
                      kind: playbackSource.kind,
                      format:
                        playbackSource.kind === 'pipe'
                          ? playbackSource.format ?? 'pcm'
                          : playbackSource.kind,
                      sampleRate: playbackSource.kind === 'pipe' ? playbackSource.sampleRate ?? null : null,
                      channels: playbackSource.kind === 'pipe' ? playbackSource.channels ?? null : null,
                    }
                  : null,
                output: {
                  profiles: session?.profiles ?? [],
                  sampleRate: effectiveOutput.sampleRate,
                  channels: effectiveOutput.channels,
                  bitrate: effectiveOutput.mp3Bitrate,
                  pcmBitDepth: effectiveOutput.pcmBitDepth,
                  resampler: audioResampler.name,
                  resamplePrecision: audioResampler.precision,
                  resampleCutoff: audioResampler.cutoff,
                  httpProfile: effectiveOutput.httpProfile,
                  httpIcyEnabled: effectiveOutput.httpIcyEnabled,
                  httpIcyInterval: effectiveOutput.httpIcyInterval,
                  httpIcyName: effectiveOutput.httpIcyName,
                  prebufferBytes: effectiveOutput.prebufferBytes,
                  httpFallbackSeconds: effectiveOutput.httpFallbackSeconds,
                },
                inputProvider: techSnapshot?.inputMode ?? techSnapshot?.activeInput ?? null,
                outputTarget: techSnapshot?.activeOutput ?? null,
                outputs: techSnapshot?.outputs ?? [],
                transports: techSnapshot?.transports ?? [],
                session: session
                  ? {
                      state: session.state,
                      elapsed: session.elapsed,
                      duration: session.duration,
                      startedAt: session.startedAt,
                      updatedAt: session.updatedAt,
                    }
                  : undefined,
                streams,
                streamStats,
                backpressure,
                sendspin: sendspinFormat
                  ? {
                      codec: sendspinFormat.codec,
                      sampleRate: sendspinFormat.sampleRate,
                      channels: sendspinFormat.channels,
                      bitDepth: sendspinFormat.bitDepth,
                      bufferCapacity: sendspinBufferCap,
                      leadUs: sendspinLead?.leadUs ?? null,
                      targetLeadUs: sendspinLead?.targetLeadUs ?? null,
                      bufferedBytes: sendspinLead?.bufferedBytes ?? null,
                      leadUpdatedAt: sendspinLead?.updatedAt ?? null,
                      protocol: groupProtocol,
                    }
                  : undefined,
              }
            : undefined;
        return {
          id: zone.id,
          name: zone.name,
          title: state?.title ?? '',
          artist: state?.artist ?? '',
          album: state?.album ?? '',
          sourceName: state?.sourceName ?? '',
          station: state?.station ?? '',
          state: state?.mode ?? '',
          powerState: state?.powerState ?? 'off',
          coverurl: state?.coverurl ?? '',
          coverUrl: state?.coverurl ?? '',
          tech,
          updatedAt: Date.now(),
        };
      });
      const system = {
        now: Date.now(),
        loadavg: os.loadavg().slice(0, 3),
        uptimeSec: Math.round(process.uptime()),
        clockOffsetMs,
        cores: os.cpus()?.length ?? 1,
      };
      this.sendJson(res, 200, { zones, system });
    } catch (err) {
      this.log.warn('zone state fetch failed', { err });
      this.sendJson(res, 500, { error: 'zone-states-failed' });
    }
  }

  private async handleAirplayDiscovery(res: ServerResponse): Promise<void> {
    try {
      const devices = await discoverAirplayDevices();
      this.sendJson(res, 200, { devices });
    } catch (err) {
      this.log.warn('airplay discovery failed', { err });
      this.sendJson(res, 500, { error: 'airplay-discovery-failed' });
    }
  }

  private async handleGoogleCastDiscovery(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      const hosts = url.searchParams
        .getAll('host')
        .flatMap((value) => value.split(','))
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      const devices = await discoverGoogleCastDevices(8000, hosts);
      this.sendJson(res, 200, { devices });
    } catch (err) {
      this.log.warn('google cast discovery failed', { err });
      this.sendJson(res, 500, { error: 'googlecast-discovery-failed' });
    }
  }

  private async handleDlnaDiscovery(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      const host = url.searchParams.get('host')?.trim() || undefined;
      const devices = await discoverDlnaDevices({ host });
      this.sendJson(res, 200, { devices });
    } catch (err) {
      this.log.warn('dlna discovery failed', { err });
      this.sendJson(res, 500, { error: 'dlna-discovery-failed' });
    }
  }

  private async handleSonosDiscovery(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      const preferredName = url.searchParams.get('name')?.trim() || undefined;
      const householdId = url.searchParams.get('householdId')?.trim() || undefined;
      const activeHost = url.searchParams.get('host')?.trim() || undefined;
      const networkScan = url.searchParams.get('networkScan')?.trim();
      const allowNetworkScan =
        typeof networkScan === 'string' &&
        ['true', '1', 'yes', 'on'].includes(networkScan.toLowerCase());
      const devices = await discoverSonosDevices({
        preferredName,
        householdId,
        allowNetworkScan,
      });
      const payload = devices.map((device) => ({
        id: device.udn || device.host,
        host: device.host,
        name: device.name ?? device.roomName,
        roomName: device.roomName,
        householdId: device.householdId,
        active: activeHost ? device.host === activeHost : undefined,
      }));
      this.sendJson(res, 200, { devices: payload });
    } catch (err) {
      this.log.warn('sonos discovery failed', { err });
      this.sendJson(res, 500, { error: 'sonos-discovery-failed' });
    }
  }

  private async handleMusicAssistantPlayerDiscovery(res: ServerResponse): Promise<void> {
    try {
      const raw = await this.musicAssistantStreamService.listPlayers();
      const devices = raw
        .map((player) => {
          const id = (player.player_id || player.id || '').trim();
          const name = (player.name || id || '').trim();
          if (!id) return null;
          return { id, deviceId: id, name: name || id };
        })
        .filter(Boolean);
      this.sendJson(res, 200, { devices });
    } catch (err) {
      this.log.warn('music assistant player discovery failed', { err });
      this.sendJson(res, 500, { error: 'musicassistant-discovery-failed' });
    }
  }

  private async handleMusicAssistantStatus(res: ServerResponse): Promise<void> {
    try {
      const status = await this.musicAssistantStreamService.testConnection();
      this.sendJson(res, 200, status);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('music assistant status failed', { message });
      this.sendJson(res, 500, { ok: false, error: 'musicassistant-status-failed', message });
    }
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

  private async handleTransportPing(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = (await this.readJsonBody(req, res)) as { host?: string; port?: number } | null;
    if (res.writableEnded) {
      return;
    }
    const host = body?.host?.trim();
    const rawPort = body?.port;
    const port =
      typeof rawPort === 'number' && Number.isFinite(rawPort) && rawPort > 0 && rawPort <= 65535
        ? rawPort
        : 80;
    if (!host) {
      this.sendJson(res, 400, { error: 'invalid-host' });
      return;
    }

    try {
      const reachable = await new Promise<boolean>((resolve) => {
        const socket = createConnection({ host, port, timeout: 1500 }, () => {
          socket.destroy();
          resolve(true);
        });
        socket.on('error', () => {
          socket.destroy();
          resolve(false);
        });
        socket.on('timeout', () => {
          socket.destroy();
          resolve(false);
        });
      });
      this.sendJson(res, 200, { reachable });
    } catch (err) {
      this.log.warn('transport ping failed', { err, host, port });
      this.sendJson(res, 500, { error: 'transport-ping-failed' });
    }
  }

  private async handleSendspinDiscovery(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      const roles = url.searchParams
        .getAll('role')
        .flatMap((value) => value.split(','))
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      const connected = sendspinCore
        .listClients()
        .filter((client) => (roles.length ? roles.some((role) => client.roles.includes(role)) : true))
        .filter((client) => typeof client.clientId === 'string' && client.clientId.trim().length > 0)
        .map((client) => {
          const clientId = client.clientId;
          const controls = clientId
            ? sendspinCore.getSessionByClientId(clientId)?.getSourceSupport()?.controls ?? null
            : null;
          return {
            id: client.clientId,
            clientId: client.clientId,
            name: client.name || client.clientId,
            // Legacy fields (kept for backwards compatibility).
            remote: client.remote,
            roles: client.roles,
            playbackState: client.playbackState,
            // UI-friendly fields.
            address: client.remote ?? undefined,
            sourceState: client.sourceState,
            sourceSignal: client.sourceSignal,
            controls,
          };
        });

      // When filtering by role, keep the original behavior (connected sessions only).
      if (roles.length > 0) {
        this.sendJson(res, 200, { clients: connected });
        return;
      }

      // Also include mDNS-discovered clients so UI can pick a target that isn't connected yet.
      const mdnsTimeoutMsRaw = url.searchParams.get('mdnsTimeoutMs');
      const mdnsTimeoutMsParsed = mdnsTimeoutMsRaw ? Number(mdnsTimeoutMsRaw) : null;
      const mdnsTimeoutMs =
        typeof mdnsTimeoutMsParsed === 'number' && Number.isFinite(mdnsTimeoutMsParsed) && mdnsTimeoutMsParsed > 0
          ? Math.min(15_000, Math.max(250, Math.round(mdnsTimeoutMsParsed)))
          : 1_500;

      const discovered = await this.discoverMdnsServices({ type: 'sendspin', protocol: 'tcp' }, mdnsTimeoutMs);
      const mdnsClients = discovered
        .map((service) => this.mapSendspinMdnsService(service))
        .filter((entry) => entry !== null)
        .map((entry) => ({
          id: entry.id,
          clientId: entry.name ?? entry.addresses[0] ?? entry.host ?? entry.id,
          name: entry.name ?? entry.addresses[0] ?? entry.host ?? entry.id,
          host: entry.host ?? undefined,
          address: entry.addresses[0] ?? entry.host ?? undefined,
          port: entry.port,
          path: entry.path,
          controls: null,
          sourceState: null,
          sourceSignal: null,
        }));

      const byClientId = new Set<string>();
      connected.forEach((c) => {
        if (typeof c.clientId === 'string') byClientId.add(c.clientId);
      });
      const merged = [...connected];
      for (const client of mdnsClients) {
        if (!byClientId.has(client.clientId)) {
          merged.push(client as any);
        }
      }

      this.sendJson(res, 200, { clients: merged });
    } catch (err) {
      this.log.warn('sendspin discovery failed', { err });
      this.sendJson(res, 500, { error: 'sendspin-discovery-failed' });
    }
  }

  private async handleSendspinMdnsDiscovery(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      const timeoutMsRaw = url.searchParams.get('timeoutMs');
      const timeoutMsParsed = timeoutMsRaw ? Number(timeoutMsRaw) : null;
      const timeoutMs =
        typeof timeoutMsParsed === 'number' && Number.isFinite(timeoutMsParsed) && timeoutMsParsed > 0
          ? Math.min(15_000, Math.max(250, Math.round(timeoutMsParsed)))
          : 3_000;

      const discovered = await this.discoverMdnsServices({ type: 'sendspin', protocol: 'tcp' }, timeoutMs);
      const clients = discovered
        .map((service) => this.mapSendspinMdnsService(service))
        .filter((entry) => entry !== null);

      this.sendJson(res, 200, { clients, timeoutMs });
    } catch (err) {
      this.log.warn('sendspin mdns discovery failed', { err });
      this.sendJson(res, 500, { error: 'sendspin-mdns-discovery-failed' });
    }
  }

  private discoverMdnsServices(
    options: { type: string; protocol?: 'tcp' | 'udp' },
    timeoutMs: number,
  ): Promise<MdnsServiceRecord[]> {
    return new Promise((resolve) => {
      const byKey = new Map<string, MdnsServiceRecord>();
      const browser = this.mdns.browse({ type: options.type, protocol: options.protocol ?? 'tcp' }, (service) => {
        const key = `${service.name || service.host || (service.addresses?.[0] ?? 'unknown')}:${service.port}`;
        byKey.set(key, service);
      });
      setTimeout(() => {
        browser.stop();
        resolve([...byKey.values()]);
      }, timeoutMs);
    });
  }

  private mapSendspinMdnsService(
    service: MdnsServiceRecord,
  ): {
    id: string;
    name: string | null;
    host: string | null;
    addresses: string[];
    port: number;
    path: string;
    url: string;
    txt: Record<string, unknown> | null;
  } | null {
    if (!service.port) {
      return null;
    }

    const addresses = (service.addresses || []).filter(Boolean) as string[];
    const pickAddress = (): string | null => {
      const ipv4 = addresses.find((addr) => addr.includes('.'));
      if (ipv4) return ipv4;
      if (addresses.length) return addresses[0];
      if (typeof service.host === 'string' && service.host.trim()) return service.host.trim();
      return null;
    };

    const address = pickAddress();
    if (!address) {
      return null;
    }

    const txt = service.txt && typeof service.txt === 'object' ? (service.txt as Record<string, unknown>) : null;
    const rawPath = typeof txt?.path === 'string' ? txt.path : '/sendspin';
    const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    const hostFmt = address.includes(':') ? `[${address}]` : address;
    const url = `ws://${hostFmt}:${service.port}${path || '/sendspin'}`;
    const name = typeof service.name === 'string' && service.name.trim() ? service.name.trim() : null;

    return {
      id: `${name ?? address}:${service.port}`,
      name,
      host: typeof service.host === 'string' && service.host.trim() ? service.host.trim() : null,
      addresses,
      port: service.port,
      path: path || '/sendspin',
      url,
      txt,
    };
  }

  private async handleSendspinSourceDiscovery(res: ServerResponse): Promise<void> {
    try {
      const clients = sendspinCore
        .listClients()
        .filter((client) => client.roles.includes('source@v1'))
        .map((client) => {
          const clientId = client.clientId;
          const controls = clientId
            ? sendspinCore.getSessionByClientId(clientId)?.getSourceSupport()?.controls ?? null
            : null;
          return {
            id: client.clientId,
            clientId: client.clientId,
            name: client.name,
            remote: client.remote,
            roles: client.roles,
            playbackState: client.playbackState,
            sourceState: client.sourceState,
            sourceSignal: client.sourceSignal,
            controls,
          };
        });
      this.sendJson(res, 200, { clients });
    } catch (err) {
      this.log.warn('sendspin source discovery failed', { err });
      this.sendJson(res, 500, { error: 'sendspin-source-discovery-failed' });
    }
  }

  private handleSnapcastDiscovery(res: ServerResponse): void {
    try {
      const clients = this.snapcastCore.listClients().map((client) => ({
        id: client.clientId || client.streamId,
        clientId: client.clientId,
        streamId: client.streamId,
        connected: client.connected,
        connectedAt: client.connectedAt,
        latency: client.latency,
      }));
      this.sendJson(res, 200, { clients });
    } catch (err) {
      this.log.warn('snapcast discovery failed', { err });
      this.sendJson(res, 500, { error: 'snapcast-discovery-failed' });
    }
  }

  private handleSqueezeliteDiscovery(res: ServerResponse): void {
    try {
      const cfg = this.configPort.getConfig();
      const configuredByPlayerId = new Map<
        string,
        { zoneId: number; zoneName: string; latencyMs: number | null }
      >();
      (cfg.zones ?? []).forEach((zone) => {
        const output = zone.output;
        if (!output || typeof output !== 'object') return;
        if (output.id !== 'squeezelite') return;
        const rawPlayerId = typeof (output as any).playerId === 'string' ? (output as any).playerId : '';
        const normalized = this.normalizeSqueezelitePlayerId(rawPlayerId);
        if (!normalized) return;
        const rawLatency = (output as any).latencyMs;
        const parsedLatency =
          typeof rawLatency === 'number'
            ? rawLatency
            : typeof rawLatency === 'string'
              ? Number(rawLatency)
              : null;
        const latencyMs = typeof parsedLatency === 'number' && Number.isFinite(parsedLatency)
          ? Math.round(parsedLatency)
          : null;
        configuredByPlayerId.set(normalized, { zoneId: zone.id, zoneName: zone.name, latencyMs });
      });

      const clients = this.squeezeliteCore.players.map((player) => ({
        id: player.playerId,
        playerId: player.playerId,
        name: player.name,
        address: player.deviceAddress ?? null,
        port: player.devicePort ?? null,
        state: player.state,
        connected: player.connected,
        zoneId: configuredByPlayerId.get(this.normalizeSqueezelitePlayerId(player.playerId))?.zoneId ?? null,
        zoneName: configuredByPlayerId.get(this.normalizeSqueezelitePlayerId(player.playerId))?.zoneName ?? null,
        latency: configuredByPlayerId.get(this.normalizeSqueezelitePlayerId(player.playerId))?.latencyMs ?? null,
        latencyMs: configuredByPlayerId.get(this.normalizeSqueezelitePlayerId(player.playerId))?.latencyMs ?? null,
      }));
      this.sendJson(res, 200, { clients });
    } catch (err) {
      this.log.warn('squeezelite discovery failed', { err });
      this.sendJson(res, 500, { error: 'squeezelite-discovery-failed' });
    }
  }

  private async handleSpotifyDeviceDiscovery(res: ServerResponse): Promise<void> {
    try {
      const devices = await discoverSpotifyConnectDevices(this.spotifyManagerProvider);
      this.sendJson(res, 200, { devices });
    } catch (err) {
      this.log.warn('spotify device discovery failed', { err });
      this.sendJson(res, 500, { error: 'spotify-discovery-failed' });
    }
  }

  private handleLogsSnapshot(res: ServerResponse): void {
    try {
      const snapshot = logBuffer.snapshot();
      const cfg = this.configPort.getConfig();
      const consoleLevel = cfg.system?.logging?.consoleLevel ?? 'none';
      this.sendJson(res, 200, {
        ...snapshot,
        consoleLevel,
      });
    } catch (err) {
      this.log.warn('logs snapshot failed', { err });
      this.sendJson(res, 500, { error: 'logs-fetch-failed' });
    }
  }

  private handleGroups(res: ServerResponse): void {
    try {
      const cfg = this.configPort.getConfig();
      const zoneNameMap = new Map<number, string>();
      (cfg.zones ?? []).forEach((zone) => {
        zoneNameMap.set(zone.id, zone.name);
      });
      const groups = this.groupManager.getAllGroups().map((group) => ({
        leader: group.leader,
        leaderName: zoneNameMap.get(group.leader) ?? `Zone ${group.leader}`,
        members: group.members,
        memberNames: group.members.map((id) => zoneNameMap.get(id) ?? `Zone ${id}`),
        backend: group.backend,
        externalId: group.externalId ?? null,
        source: group.source,
        updatedAt: group.updatedAt,
      }));
      this.sendJson(res, 200, { groups });
    } catch (err) {
      this.log.warn('group fetch failed', { err });
      this.sendJson(res, 500, { error: 'groups-fetch-failed' });
    }
  }

  private handleLogsStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();
    res.write('\n');

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': keep-alive\n\n');
      }
    }, 25000);

    const unsubscribe = logBuffer.subscribe((entry) => {
      if (res.writableEnded) {
        return;
      }
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    });

    const cleanup = () => {
      unsubscribe();
      clearInterval(heartbeat);
      if (!res.writableEnded) {
        res.end();
      }
    };

    req.on('close', cleanup);
    req.on('error', cleanup);
  }

  private async handleLogLevelUpdate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readJsonBody(req, res)) as { level?: string } | null;
    if (res.writableEnded) {
      return;
    }
    const level = this.parseLogLevel(body?.level);
    if (!level) {
      this.sendJson(res, 400, { error: 'invalid-log-level' });
      return;
    }
    try {
      await this.configPort.updateConfig((cfg) => {
        if (!cfg.system) {
          cfg.system = this.defaultConfig().system;
        }
        if (!cfg.system.logging) {
          cfg.system.logging = { consoleLevel: level, fileLevel: 'none' };
        } else {
          cfg.system.logging.consoleLevel = level;
        }
      });
      logManager.configure({ level });
      this.sendJson(res, 204, {});
    } catch (err) {
      this.log.warn('log level update failed', { err });
      this.sendJson(res, 500, { error: 'log-level-update-failed' });
    }
  }

  private parseLogLevel(value: unknown): LogLevel | null {
    const normalized = typeof value === 'string' ? value.toLowerCase() : '';
    switch (normalized) {
      case 'spam':
      case 'debug':
      case 'info':
      case 'warn':
      case 'error':
      case 'none':
        return normalized as LogLevel;
      default:
        return null;
    }
  }

  private handleLibraryStatus(res: ServerResponse): void {
    try {
      const status = this.contentManager.getScanStatus();
      const stats = this.contentManager.getLibraryStats();
      this.sendJson(res, 200, {
        status,
        trackCount: stats?.tracks ?? null,
        albumCount: stats?.albums ?? null,
        artistCount: stats?.artists ?? null,
      });
    } catch (err) {
      this.log.warn('library status fetch failed', { err });
      this.sendJson(res, 500, { error: 'library-status-failed' });
    }
  }

  private handleLibraryStorageStatus(storageId: string, res: ServerResponse): void {
    if (!storageId) {
      this.sendJson(res, 400, { error: 'missing-storage-id' });
      return;
    }
    try {
      const stats = this.contentManager.getLibraryStorageStats(storageId);
      this.sendJson(res, 200, {
        trackCount: stats?.tracks ?? null,
        albumCount: stats?.albums ?? null,
        artistCount: stats?.artists ?? null,
      });
    } catch (err) {
      this.log.warn('library storage status fetch failed', { err, storageId });
      this.sendJson(res, 500, { error: 'library-storage-status-failed' });
    }
  }

  private async handleLibraryCovers(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      const rawLimit = Number(url.searchParams.get('limit'));
      const limit =
        Number.isFinite(rawLimit) && rawLimit >= 0
          ? Math.round(rawLimit)
          : 8;
      const covers = this.contentManager.getLibraryCoverSamples(limit);
      this.sendJson(res, 200, { covers });
    } catch (err) {
      this.log.warn('library covers fetch failed', { err });
      this.sendJson(res, 500, { error: 'library-covers-failed' });
    }
  }

  private async handleLibraryStorageCovers(
    storageId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!storageId) {
      this.sendJson(res, 400, { error: 'missing-storage-id' });
      return;
    }
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      const rawLimit = Number(url.searchParams.get('limit'));
      const limit =
        Number.isFinite(rawLimit) && rawLimit >= 0
          ? Math.round(rawLimit)
          : 8;
      const covers = this.contentManager.getLibraryStorageCoverSamples(storageId, limit);
      this.sendJson(res, 200, { covers });
    } catch (err) {
      this.log.warn('library storage covers fetch failed', { err, storageId });
      this.sendJson(res, 500, { error: 'library-storage-covers-failed' });
    }
  }

  private async handleLibraryUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readJsonBody(req, res, MAX_LIBRARY_UPLOAD_JSON_BODY_BYTES)) as
      | { filename?: string; relativePath?: string; data?: string }
      | null;
    if (res.writableEnded) {
      return;
    }
    const filename = typeof body?.filename === 'string' ? body.filename.trim() : '';
    const relativePath = typeof body?.relativePath === 'string' ? body.relativePath.trim() : '';
    const data = typeof body?.data === 'string' ? body.data : '';
    if ((!filename && !relativePath) || !data) {
      this.sendJson(res, 400, { error: 'invalid-library-upload' });
      return;
    }
    try {
      const upload = await this.contentManager.uploadLibraryAudio(relativePath || filename, data);
      // Best-effort rescan; failure should not block the upload response.
      void bestEffort(() => this.contentManager.rescanLibrary(), {
        fallback: undefined,
        onError: 'debug',
        log: this.log,
        label: 'library rescan failed after upload',
      });
      this.sendJson(res, 201, { upload });
    } catch (err) {
      const code = err instanceof Error ? err.message : 'library-upload-failed';
      if (['invalid-filename', 'invalid-audio-data', 'invalid-audio-extension'].includes(code)) {
        this.sendJson(res, 400, { error: code });
        return;
      }
      this.log.warn('library upload failed', { err });
      this.sendJson(res, 500, { error: 'library-upload-failed' });
    }
  }

  private async handleEventSoundUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readJsonBody(req, res, MAX_EVENT_SOUND_UPLOAD_JSON_BODY_BYTES)) as
      | { filename?: string; data?: string }
      | null;
    if (res.writableEnded) {
      return;
    }
    const inputFilename = typeof body?.filename === 'string' ? body.filename.trim() : '';
    const data = typeof body?.data === 'string' ? body.data.trim() : '';
    const filename = sanitizeEventSoundFilename(inputFilename);
    if (!filename || !data) {
      this.sendJson(res, 400, { error: 'invalid-event-sound-upload' });
      return;
    }
    const extension = extname(filename).toLowerCase();
    if (!ALLOWED_EVENT_SOUND_EXTENSIONS.has(extension)) {
      this.sendJson(res, 400, { error: 'invalid-audio-extension' });
      return;
    }

    let payload: Buffer;
    try {
      payload = Buffer.from(data, 'base64');
    } catch {
      this.sendJson(res, 400, { error: 'invalid-audio-data' });
      return;
    }
    if (!payload.length) {
      this.sendJson(res, 400, { error: 'invalid-audio-data' });
      return;
    }

    try {
      await ensureDir(EVENT_SOUNDS_DIR);
      await fs.writeFile(join(EVENT_SOUNDS_DIR, filename), payload);
      this.sendJson(res, 201, {
        upload: {
          filename,
          relativePath: `Event_Sounds/${filename}`,
          bytes: payload.length,
        },
      });
    } catch (err) {
      this.log.warn('event sound upload failed', { err, filename });
      this.sendJson(res, 500, { error: 'event-sound-upload-failed' });
    }
  }

  private async handleLibraryTrackDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readJsonBody(req, res)) as { audiopath?: string } | null;
    if (res.writableEnded) {
      return;
    }
    const audiopath = typeof body?.audiopath === 'string' ? body.audiopath.trim() : '';
    if (!audiopath) {
      this.sendJson(res, 400, { error: 'invalid-library-track-delete' });
      return;
    }
    try {
      const result = await this.contentManager.deleteLibraryTrackByAudiopath(audiopath);
      this.sendJson(res, 200, { result });
    } catch (err) {
      const code = err instanceof Error ? err.message : 'library-track-delete-failed';
      if (code === 'invalid-audiopath') {
        this.sendJson(res, 400, { error: code });
        return;
      }
      if (code === 'track-not-found') {
        this.sendJson(res, 404, { error: code });
        return;
      }
      this.log.warn('library track delete failed', { err, audiopath });
      this.sendJson(res, 500, { error: 'library-track-delete-failed' });
    }
  }

  private async handleLibraryAlbumDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readJsonBody(req, res)) as { id?: string } | null;
    if (res.writableEnded) {
      return;
    }
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    if (!id) {
      this.sendJson(res, 400, { error: 'invalid-library-album-delete' });
      return;
    }
    try {
      const result = await this.contentManager.deleteLibraryAlbumByFolderId(id);
      this.sendJson(res, 200, { result });
    } catch (err) {
      const code = err instanceof Error ? err.message : 'library-album-delete-failed';
      if (code === 'invalid-album-id') {
        this.sendJson(res, 400, { error: code });
        return;
      }
      if (code === 'album-not-found') {
        this.sendJson(res, 404, { error: code });
        return;
      }
      this.log.warn('library album delete failed', { err, id });
      this.sendJson(res, 500, { error: 'library-album-delete-failed' });
    }
  }

  private async handleLibraryArtistDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readJsonBody(req, res)) as { id?: string } | null;
    if (res.writableEnded) {
      return;
    }
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    if (!id) {
      this.sendJson(res, 400, { error: 'invalid-library-artist-delete' });
      return;
    }
    try {
      const result = await this.contentManager.deleteLibraryArtistByFolderId(id);
      this.sendJson(res, 200, { result });
    } catch (err) {
      const code = err instanceof Error ? err.message : 'library-artist-delete-failed';
      if (code === 'invalid-artist-id') {
        this.sendJson(res, 400, { error: code });
        return;
      }
      if (code === 'artist-not-found') {
        this.sendJson(res, 404, { error: code });
        return;
      }
      this.log.warn('library artist delete failed', { err, id });
      this.sendJson(res, 500, { error: 'library-artist-delete-failed' });
    }
  }

  private async handleLibraryStorageList(res: ServerResponse): Promise<void> {
    try {
      const storages = await this.contentManager.listStorages();
      this.loxoneNotifier.notifyStorageListUpdated(storages);
      this.sendJson(res, 200, { storages });
    } catch (err) {
      this.log.warn('library storage list failed', { err });
      this.sendJson(res, 500, { error: 'library-storage-list-failed' });
    }
  }

  private async handleLibraryStorageAdd(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = (await this.readJsonBody(req, res)) as Partial<StorageConfig> | null;
    if (res.writableEnded) {
      return;
    }
    if (!body || typeof body !== 'object') {
      this.sendJson(res, 400, { error: 'invalid-storage-payload' });
      return;
    }

    const { name, server, folder, type } = body;
    if (!name || !server || !folder || !type) {
      this.sendJson(res, 400, { error: 'missing-storage-fields' });
      return;
    }

    try {
      const storage = await this.contentManager.addStorage({
        id: body.id,
        name,
        server,
        folder,
        type,
        username: body.username,
        password: body.password,
        guest: body.guest,
        options: body.options,
      });
      this.loxoneNotifier.notifyStorageAdded(storage);
      this.loxoneNotifier.notifyStorageListUpdated(await this.contentManager.listStorages());
      // Best-effort rescan; failure should not block the add response.
      void bestEffort(() => this.contentManager.rescanLibrary(), {
        fallback: undefined,
        onError: 'debug',
        log: this.log,
        label: 'library rescan failed after storage add',
      });
      this.sendJson(res, 201, { storage });
    } catch (err) {
      this.log.warn('library storage add failed', { err });
      this.sendJson(res, 500, { error: 'library-storage-add-failed' });
    }
  }

  private async handleLibraryStorageDelete(id: string, res: ServerResponse): Promise<void> {
    if (!id) {
      this.sendJson(res, 400, { error: 'missing-storage-id' });
      return;
    }

    try {
      await this.contentManager.deleteStorage(id);
      this.loxoneNotifier.notifyStorageRemoved(id);
      this.loxoneNotifier.notifyStorageListUpdated(await this.contentManager.listStorages());
      // Best-effort rescan; failure should not block the delete response.
      void bestEffort(() => this.contentManager.rescanLibrary(), {
        fallback: undefined,
        onError: 'debug',
        log: this.log,
        label: 'library rescan failed after storage delete',
      });
      this.sendJson(res, 202, { status: 'storage-deleted', id });
    } catch (err) {
      this.log.warn('library storage delete failed', { err, id });
      this.sendJson(res, 500, { error: 'library-storage-delete-failed' });
    }
  }

  private async handleLibraryRescan(res: ServerResponse): Promise<void> {
    try {
      await this.contentManager.rescanLibrary();
      this.sendJson(res, 202, { status: 'rescan-started' });
    } catch (err) {
      this.log.warn('library rescan failed', { err });
      this.sendJson(res, 500, { error: 'library-rescan-failed' });
    }
  }

  private async handleCustomRadioList(res: ServerResponse): Promise<void> {
    try {
      const stations = await this.customRadioStore.list();
      this.sendJson(res, 200, { stations });
    } catch (err) {
      this.log.warn('custom radio list failed', { err });
      this.sendJson(res, 500, { error: 'custom-radio-list-failed' });
    }
  }

  private async handleCustomRadioAdd(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = (await this.readJsonBody(req, res)) as { name?: string; stream?: string; coverurl?: string } | null;
    if (res.writableEnded) {
      return;
    }
    if (!body || typeof body !== 'object' || !body.name || !body.stream) {
      this.sendJson(res, 400, { error: 'invalid-radio-payload' });
      return;
    }
    try {
      const station = await this.customRadioStore.add({
        name: body.name.trim(),
        stream: body.stream.trim(),
        coverurl: body.coverurl?.trim() || undefined,
      });
      this.sendJson(res, 201, { station });
    } catch (err) {
      this.log.warn('custom radio add failed', { err });
      this.sendJson(res, 500, { error: 'custom-radio-add-failed' });
    }
  }

  private async handleCustomRadioDelete(stationId: string, res: ServerResponse): Promise<void> {
    try {
      const removed = await this.customRadioStore.remove(stationId);
      if (!removed) {
        this.sendJson(res, 404, { error: 'station-not-found' });
        return;
      }
      this.sendJson(res, 204, {});
    } catch (err) {
      this.log.warn('custom radio delete failed', { err, stationId });
      this.sendJson(res, 500, { error: 'custom-radio-delete-failed' });
    }
  }

  private async handleTuneInValidate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readJsonBody(req, res)) as { username?: string } | null;
    if (res.writableEnded) {
      return;
    }
    const username = typeof body?.username === 'string' ? body.username.trim() : '';
    if (!username) {
      this.sendJson(res, 400, { error: 'invalid-tunein-username' });
      return;
    }
    try {
      const api = new TuneInClient();
      const outlines = await api.browsePresets(username);
      const presetCount = Array.isArray(outlines)
        ? outlines.filter((entry: any) => entry && entry.type === 'audio').length
        : 0;
      this.sendJson(res, 200, { valid: true, presetCount });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isInvalid = /(TuneIn error|HTTP 4\d\d)/i.test(message);
      this.log.warn('tunein validation failed', { message, username });
      this.sendJson(res, 200, {
        valid: false,
        error: isInvalid ? 'tunein-username-invalid' : 'tunein-validate-failed',
        message: isInvalid
          ? 'TuneIn username not found.'
          : 'Unable to verify the TuneIn username right now.',
      });
    }
  }

  private async handleFavoritesPurge(res: ServerResponse): Promise<void> {
    try {
      await this.favoritesManager.clearAll();
      this.sendJson(res, 202, { status: 'favorites-purged' });
    } catch (err) {
      this.log.warn('favorites purge failed', { err });
      this.sendJson(res, 500, { error: 'favorites-purge-failed' });
    }
  }

  private async handleRecentsPurge(res: ServerResponse): Promise<void> {
    try {
      await this.recentsManager.clearAll();
      this.sendJson(res, 202, { status: 'recents-purged' });
    } catch (err) {
      this.log.warn('recents purge failed', { err });
      this.sendJson(res, 500, { error: 'recents-purge-failed' });
    }
  }

  private async handleZoneFavoritesPurge(zoneId: number, res: ServerResponse): Promise<void> {
    try {
      await this.favoritesManager.clear(zoneId);
      this.sendJson(res, 202, { status: 'favorites-purged', zoneId });
    } catch (err) {
      this.log.warn('zone favorites purge failed', { err, zoneId });
      this.sendJson(res, 500, { error: 'favorites-purge-failed' });
    }
  }

  private async handleZoneFavoritesCopy(
    zoneId: number,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = (await this.readJsonBody(req, res)) as { destinations?: unknown } | null;
    if (res.writableEnded) {
      return;
    }
    const rawList = Array.isArray(body?.destinations) ? body!.destinations : [];
    const destinations = Array.from(
      new Set(
        rawList
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0 && value !== zoneId),
      ),
    );
    if (destinations.length === 0) {
      this.sendJson(res, 400, { error: 'invalid-destinations' });
      return;
    }
    try {
      await this.favoritesManager.copy(zoneId, destinations);
      this.sendJson(res, 202, { status: 'favorites-copied', zoneId, destinations });
    } catch (err) {
      this.log.warn('favorites copy failed', { err, zoneId, destinations });
      this.sendJson(res, 500, { error: 'favorites-copy-failed' });
    }
  }

  private async handleZoneRecentsPurge(zoneId: number, res: ServerResponse): Promise<void> {
    try {
      await this.recentsManager.clear(zoneId);
      this.sendJson(res, 202, { status: 'recents-purged', zoneId });
    } catch (err) {
      this.log.warn('zone recents purge failed', { err, zoneId });
      this.sendJson(res, 500, { error: 'recents-purge-failed' });
    }
  }

  private async handleAlertFilesList(res: ServerResponse): Promise<void> {
    try {
      const alerts = await listAlertFiles();
      this.sendJson(res, 200, { alerts });
    } catch (err) {
      this.log.warn('alerts list failed', { err });
      this.sendJson(res, 500, { error: 'alerts-list-failed' });
    }
  }

  private async handleAlertFileUpdate(
    req: IncomingMessage,
    res: ServerResponse,
    alertId: string,
  ): Promise<void> {
    const body = (await this.readJsonBody(req, res)) as { data?: string } | null;
    if (res.writableEnded) {
      return;
    }
    const data = typeof body?.data === 'string' ? body.data : null;
    if (!data) {
      this.sendJson(res, 400, { error: 'invalid-alert-payload' });
      return;
    }
    try {
      await updateAlertFile(alertId, data);
      this.sendJson(res, 200, { success: true });
    } catch (err) {
      const code = err instanceof Error ? err.message : 'alerts-update-failed';
      this.log.warn('alert update failed', { err, alertId });
      this.sendJson(res, 500, { error: code });
    }
  }

  private async handleAlertFileRevert(alertId: string, res: ServerResponse): Promise<void> {
    try {
      await revertAlertFile(alertId);
      this.sendJson(res, 200, { success: true });
    } catch (err) {
      const code = err instanceof Error ? err.message : 'alerts-revert-failed';
      this.log.warn('alert revert failed', { err, alertId });
      if (code === 'no-alert-backup') {
        this.sendJson(res, 400, { error: 'no-alert-backup' });
        return;
      }
      this.sendJson(res, 500, { error: code });
    }
  }

  private async handleSpotifyAccountDelete(accountId: string, res: ServerResponse): Promise<void> {
    if (!accountId) {
      this.sendJson(res, 400, { error: 'invalid-account-id' });
      return;
    }
    try {
      await deleteSpotifyAccount(
        this.configPort,
        accountId,
        this.notifier,
        this.contentManager,
        this.spotifyInputService,
      );
      this.sendJson(res, 204, {});
    } catch (err) {
      this.log.warn('spotify account delete failed', { err, accountId });
      this.sendJson(res, 500, { error: 'spotify-account-delete-failed' });
    }
  }

  private async handleSpotifyAccountLink(res: ServerResponse): Promise<void> {
    try {
      const cfg = this.configPort.getConfig();
      const host = cfg.system?.audioserver?.ip?.trim() || '127.0.0.1';
      const link = buildSpotifyAuthLink({ audioServerHost: host }, this.configPort);
      this.sendJson(res, 200, { link });
    } catch (err) {
      this.log.warn('spotify account link build failed', { err });
      this.sendJson(res, 500, { error: 'spotify-account-link-failed' });
    }
  }

  private async handleSpotifyLibrespotStatus(res: ServerResponse): Promise<void> {
    try {
      const zones = this.spotifyInputService.listCredentialStates();
      this.sendJson(res, 200, { zones });
    } catch (err) {
      this.log.warn('spotify librespot status failed', { err });
      this.sendJson(res, 500, { error: 'spotify-librespot-status-failed' });
    }
  }

  private async handleSpotifyBridgeCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readJsonBody(req, res)) as Partial<SpotifyBridgeConfig> | null;
    if (res.writableEnded) {
      return;
    }
    const provider = typeof body?.provider === 'string' ? body.provider.trim().toLowerCase() : '';
    if (!provider) {
      this.sendJson(res, 400, { error: 'invalid-bridge-payload' });
      return;
    }
    const isMusicAssistant = provider === 'musicassistant';
    if (provider === 'musicassistant') {
      const apiKeyValid = typeof body?.apiKey === 'string' && body.apiKey.trim().length > 0;
      if (!apiKeyValid) {
        this.sendJson(res, 400, { error: 'api-key-required' });
        return;
      }
    }

    let musicAssistantHost: string | undefined;
    let musicAssistantPort: number | undefined;
    let musicAssistantApiKey: string | undefined;
    let musicAssistantConnection:
      | { ok: boolean; checkedAt: number; message?: string; host: string; port: number }
      | null = null;

    if (isMusicAssistant) {
      const hostRaw = typeof body?.host === 'string' ? body.host.trim() : '';
      const portRaw = body?.port;
      musicAssistantHost = hostRaw || '127.0.0.1';
      musicAssistantPort =
        typeof portRaw === 'number' && Number.isFinite(portRaw) && portRaw > 0
          ? Math.round(portRaw)
          : 8095;
      musicAssistantApiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';

      if (!this.isValidMusicAssistantHost(musicAssistantHost)) {
        this.sendJson(res, 400, { error: 'invalid-musicassistant-host', message: 'Invalid Music Assistant host.' });
        return;
      }
      if (!musicAssistantPort || musicAssistantPort < 1 || musicAssistantPort > 65535) {
        this.sendJson(res, 400, { error: 'invalid-musicassistant-port', message: 'Invalid Music Assistant port.' });
        return;
      }
      if (!musicAssistantApiKey) {
        this.sendJson(res, 400, { error: 'api-key-required' });
        return;
      }

      const testResult = await this.testMusicAssistantBridge(musicAssistantHost, musicAssistantPort, musicAssistantApiKey);
      if (!testResult.ok) {
        this.sendJson(res, 400, {
          error: 'musicassistant-connection-failed',
          message: testResult.message || 'Unable to connect to Music Assistant.',
          host: testResult.host,
          port: testResult.port,
        });
        return;
      }
      musicAssistantConnection = testResult;
    }

    const generatedId = `bridge-${provider}-${Math.random().toString(36).slice(2, 8)}`;
    const id = typeof body?.id === 'string' && body.id.trim() ? body.id.trim() : generatedId;
    const defaultLabel =
      provider === 'applemusic'
        ? 'Apple Music'
        : provider === 'musicassistant'
          ? 'Music Assistant'
          : provider === 'deezer'
            ? 'Deezer'
            : provider === 'tidal'
              ? 'Tidal'
              : provider === 'ytmusic'
                ? 'YouTube Music'
              : id;

    const bridge: SpotifyBridgeConfig = {
      id,
      label: typeof body?.label === 'string' && body.label.trim() ? body.label.trim() : defaultLabel,
      provider,
      enabled: body?.enabled !== false,
      registerAll: body?.registerAll !== false,
      accountId: undefined,
      host: isMusicAssistant
        ? musicAssistantHost
        : typeof body?.host === 'string' && body.host.trim()
          ? body.host.trim()
          : undefined,
      port: isMusicAssistant
        ? musicAssistantPort
        : typeof body?.port === 'number' && Number.isFinite(body.port) && body.port > 0
          ? Math.round(body.port)
          : undefined,
      apiKey: isMusicAssistant
        ? musicAssistantApiKey
        : typeof body?.apiKey === 'string' && body.apiKey.trim()
          ? body.apiKey.trim()
          : undefined,
      developerToken:
        typeof body?.developerToken === 'string' && body.developerToken.trim() ? body.developerToken.trim() : undefined,
      userToken: typeof body?.userToken === 'string' && body.userToken.trim() ? body.userToken.trim() : undefined,
      deezerArl: typeof body?.deezerArl === 'string' && body.deezerArl.trim() ? body.deezerArl.trim() : undefined,
      tidalAccessToken:
        typeof body?.tidalAccessToken === 'string' && body.tidalAccessToken.trim()
          ? body.tidalAccessToken.trim()
          : undefined,
      tidalCountryCode:
        typeof body?.tidalCountryCode === 'string' && body.tidalCountryCode.trim()
          ? body.tidalCountryCode.trim().toUpperCase()
          : undefined,
      ytmusicCookie:
        typeof body?.ytmusicCookie === 'string' && body.ytmusicCookie.trim()
          ? body.ytmusicCookie.trim()
          : undefined,
    };

    try {
      await this.configPort.updateConfig((cfg) => {
        if (!cfg.content) cfg.content = this.defaultConfig().content;
        if (!cfg.content.spotify) cfg.content.spotify = this.defaultConfig().content.spotify;
        if (!Array.isArray(cfg.content.spotify.bridges)) cfg.content.spotify.bridges = [];
        const bridges = cfg.content.spotify.bridges;
        const idx = bridges.findIndex(
          (b) => typeof b?.id === 'string' && b.id.trim().toLowerCase() === bridge.id.toLowerCase(),
        );
        if (idx >= 0) {
          const cleaned = { ...bridges[idx], ...bridge } as SpotifyBridgeConfig & { storefront?: string };
          delete cleaned.storefront;
          bridges[idx] = cleaned;
        } else {
          const cleaned = bridge as SpotifyBridgeConfig & { storefront?: string };
          delete cleaned.storefront;
          bridges.push(cleaned);
        }
      });
      this.contentManager.refreshFromConfig();
      if (provider === 'applemusic' || provider === 'deezer' || provider === 'tidal' || provider === 'ytmusic') {
        this.zoneManager.refreshContentProviders();
      }
      this.musicAssistantStreamService.configureFromConfig();
      const cfg = this.configPort.getConfig();
      await this.musicAssistantStreamService.registerZones(cfg.zones ?? []);
      const connection = isMusicAssistant ? musicAssistantConnection ?? undefined : undefined;
      if (connection?.ok) {
        this.log.info('music assistant connection ok', { host: connection.host, port: connection.port });
      }
      this.notifier.notifyReloadMusicApp('useradd', bridge.provider || 'spotify', bridge.id);
      this.sendJson(res, 200, { bridge, connection });
    } catch (err) {
      this.log.warn('spotify bridge create failed', { err });
      this.sendJson(res, 500, { error: 'spotify-bridge-create-failed' });
    }
  }

  private async handleSpotifyBridgeDelete(bridgeId: string, res: ServerResponse): Promise<void> {
    if (!bridgeId) {
      this.sendJson(res, 400, { error: 'invalid-bridge-id' });
      return;
    }
    try {
      const cfgBefore = this.configPort.getConfig();
      const existing = (cfgBefore.content?.spotify?.bridges ?? []).find(
        (b) => typeof b?.id === 'string' && b.id.trim().toLowerCase() === bridgeId.trim().toLowerCase(),
      );
      await this.configPort.updateConfig((cfg) => {
        if (!cfg.content?.spotify?.bridges) return;
        const current = cfg.content.spotify.bridges ?? [];
        cfg.content.spotify.bridges = current.filter(
          (b) => typeof b?.id !== 'string' || b.id.trim().toLowerCase() !== bridgeId.trim().toLowerCase(),
        );
      });
      this.contentManager.refreshFromConfig();
      const provider = typeof existing?.provider === 'string' ? existing.provider.trim().toLowerCase() : '';
      if (provider === 'applemusic' || provider === 'deezer' || provider === 'tidal' || provider === 'ytmusic') {
        this.zoneManager.refreshContentProviders();
      }
      this.musicAssistantStreamService.configureFromConfig();
      const cfg = this.configPort.getConfig();
      await this.musicAssistantStreamService.registerZones(cfg.zones ?? []);
      if (existing) {
        this.notifier.notifyReloadMusicApp('userdel', existing.provider || 'spotify', existing.id);
      }
      this.sendJson(res, 204, {});
    } catch (err) {
      this.log.warn('spotify bridge delete failed', { err, bridgeId });
      this.sendJson(res, 500, { error: 'spotify-bridge-delete-failed' });
    }
  }

  private async handleAppleMusicAuth(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const developerToken = await this.fetchAppleMusicDeveloperToken();
      if (!developerToken) {
        this.sendHtml(res, 500, this.renderAppleMusicAuthError('Apple Music token unavailable. Try again.'));
        return;
      }
      const html = this.renderAppleMusicAuthPage({
        developerToken,
        appName: 'Loxone Audio Server',
      });
      this.sendHtml(res, 200, html);
    } catch (err) {
      this.log.warn('apple music auth page failed', { err });
      this.sendHtml(res, 500, this.renderAppleMusicAuthError('Apple Music token fetch failed.'));
    }
  }

  private async handleAppleMusicWidevineStatus(res: ServerResponse): Promise<void> {
    const files = await this.readWidevineFileStatus();
    try {
      invalidateWidevineArtifactsCache();
      await loadWidevineArtifacts();
      this.sendJson(res, 200, { ok: true, status: 'valid', files });
    } catch (err) {
      if (err instanceof WidevineArtifactsError) {
        this.sendJson(res, 200, { ok: false, status: err.code, details: err.details, files });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.sendJson(res, 200, { ok: false, status: 'error', details: [message], files });
    }
  }

  private async handleAppleMusicWidevineUpload(
    req: IncomingMessage,
    res: ServerResponse,
    kind: 'privateKey' | 'clientId',
  ): Promise<void> {
    const maxBytes = kind === 'privateKey' ? MAX_WIDEVINE_PRIVATE_KEY_BYTES : MAX_WIDEVINE_CLIENT_ID_BYTES;
    const body = await this.readBinaryBody(req, res, maxBytes);
    if (res.writableEnded) return;
    if (!body || body.length === 0) {
      this.sendJson(res, 400, { error: 'empty-body' });
      return;
    }

    const cdmDir = resolveDataDir('widevine_cdm');
    const targetPath =
      kind === 'privateKey'
        ? join(cdmDir, 'private_key.pem')
        : join(cdmDir, 'client_id.bin');

    try {
      await ensureDir(cdmDir);
      await fs.writeFile(targetPath, body, { mode: 0o600 });
      invalidateWidevineArtifactsCache();
      try {
        await loadWidevineArtifacts();
      } catch (err) {
        if (err instanceof WidevineArtifactsError) {
          const files = await this.readWidevineFileStatus();
          this.sendJson(res, 200, { ok: false, status: err.code, details: err.details, files });
          return;
        }
        throw err;
      }
      const files = await this.readWidevineFileStatus();
      this.sendJson(res, 200, { ok: true, status: 'valid', files });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('widevine upload failed', { kind, message });
      this.sendJson(res, 500, { error: 'widevine-upload-failed', message });
    }
  }

  private async readWidevineFileStatus(): Promise<{
    privateKey: { present: boolean; bytes: number };
    clientId: { present: boolean; bytes: number };
  }> {
    const cdmDir = resolveDataDir('widevine_cdm');
    const privatePath = join(cdmDir, 'private_key.pem');
    const clientPath = join(cdmDir, 'client_id.bin');
    const readOne = async (filePath: string): Promise<{ present: boolean; bytes: number }> => {
      try {
        const stat = await fs.stat(filePath);
        return { present: stat.isFile(), bytes: stat.isFile() ? stat.size : 0 };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return { present: false, bytes: 0 };
        }
        return { present: false, bytes: 0 };
      }
    };
    const [privateKey, clientId] = await Promise.all([readOne(privatePath), readOne(clientPath)]);
    return { privateKey, clientId };
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

  private async fetchAppleMusicDeveloperToken(): Promise<string | null> {
    const headers = {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US',
      'Accept-Encoding': 'utf-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:95.0) Gecko/20100101 Firefox/95.0',
    };
    try {
      const homeRes = await fetch('https://music.apple.com', { headers });
      const homeText = await homeRes.text();
      const match = homeText.match(/\/(assets\/index-legacy[~-][^/\"]+\.js)/i);
      if (!match) {
        this.log.warn('apple music auth: index js not found');
        return null;
      }
      const jsRes = await fetch(`https://music.apple.com/${match[1]}`, { headers });
      const jsText = await jsRes.text();
      const tokenMatch = jsText.match(/eyJh[^"]+/);
      if (!tokenMatch) {
        this.log.warn('apple music auth: bearer token not found');
        return null;
      }
      return tokenMatch[0];
    } catch (err) {
      this.log.warn('apple music auth: token fetch failed', {
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private renderAppleMusicAuthError(message: string): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Apple Music Sign-in</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: #0f0f10; color: #f2f2f2; margin: 0; padding: 24px; }
      .card { max-width: 420px; margin: 8vh auto 0; padding: 24px; background: #1c1c1f; border-radius: 12px; box-shadow: 0 20px 50px rgba(0,0,0,.45); }
      h1 { font-size: 20px; margin: 0 0 12px; }
      p { margin: 0 0 16px; color: #bdbdbd; }
      button { appearance: none; border: 0; background: #d92b2b; color: #fff; padding: 10px 16px; border-radius: 8px; cursor: pointer; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Apple Music Sign-in</h1>
      <p>${message}</p>
      <button onclick="window.close()">Close</button>
    </div>
  </body>
</html>`;
  }

  private renderAppleMusicAuthPage(payload: { developerToken: string; appName: string }): string {
    const developerToken = JSON.stringify(payload.developerToken);
    const appName = JSON.stringify(payload.appName);
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="strict-origin-when-cross-origin" />
    <title>Apple Music Sign-in</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: radial-gradient(1200px 700px at 10% 10%, #2a2a2f 0%, #0f0f10 65%); color: #f2f2f2; margin: 0; padding: 24px; }
      .card { max-width: 440px; margin: 6vh auto 0; padding: 28px; background: #1c1c1f; border-radius: 16px; box-shadow: 0 24px 60px rgba(0,0,0,.5); }
      h1 { font-size: 22px; margin: 0 0 8px; }
      p { margin: 0 0 16px; color: #c9c9c9; line-height: 1.4; }
      .actions { display: flex; gap: 12px; flex-wrap: wrap; }
      button { appearance: none; border: 0; background: #f23d4f; color: #fff; padding: 10px 16px; border-radius: 10px; cursor: pointer; font-weight: 600; }
      button.secondary { background: #2a2a2f; color: #f2f2f2; }
      button[disabled] { opacity: .6; cursor: default; }
      .status { margin-top: 16px; font-size: 13px; color: #9f9fa4; }
    </style>
    <script src="https://js-cdn.music.apple.com/musickit/v3/musickit.js" data-web-components async></script>
  </head>
  <body>
    <div class="card">
      <h1>Apple Music Sign-in</h1>
      <p>Sign in with Apple to fetch your Media User Token for the Apple Music bridge.</p>
      <div class="actions">
        <button id="signin" disabled>Sign in</button>
        <button id="close" class="secondary">Close</button>
      </div>
      <div id="status" class="status">Loading MusicKit…</div>
    </div>
    <script>
      const developerToken = ${developerToken};
      const appName = ${appName};
      const statusEl = document.getElementById('status');
      const signInBtn = document.getElementById('signin');
      const closeBtn = document.getElementById('close');
      let musicInstance = null;

      function setStatus(text) {
        statusEl.textContent = text;
      }

      function sendToken(token) {
        if (!window.opener || !token) return;
        window.opener.postMessage({ type: 'applemusic-token', token }, window.location.origin);
      }

      closeBtn.addEventListener('click', () => window.close());
      signInBtn.addEventListener('click', async () => {
        if (!musicInstance) return;
        signInBtn.disabled = true;
        setStatus('Opening Apple Music sign-in…');
        try {
          const token = await musicInstance.authorize();
          setStatus('Token received. You can close this window.');
          sendToken(token);
          setTimeout(() => window.close(), 500);
        } catch (err) {
          console.error('Apple Music sign-in failed', err);
          setStatus('Sign-in failed. Please try again.');
          signInBtn.disabled = false;
        }
      });

      document.addEventListener('musickitloaded', async () => {
        try {
          await MusicKit.configure({
            developerToken,
            app: { name: appName, build: '0.0.0' },
          });
          musicInstance = MusicKit.getInstance();
          signInBtn.disabled = false;
          setStatus(musicInstance.isAuthorized ? 'Already signed in. Click sign in to refresh.' : 'Ready to sign in.');
        } catch (err) {
          console.error('MusicKit init failed', err);
          setStatus('Unable to initialize MusicKit.');
        }
      });
    </script>
  </body>
</html>`;
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
            audioserver?: { macId?: string; ip?: string };
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
      const rawMiniserverIp = hasMiniserver ? body.miniserver!.ip : undefined;
      const rawMiniserverPort = hasMiniserver ? body.miniserver!.port : undefined;
      const rawMiniserverProtocol = hasMiniserver ? body.miniserver!.protocol : undefined;
      if (
        typeof rawMac !== 'string' &&
        typeof rawIp !== 'string' &&
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

  private normalizeSqueezelitePlayerId(value: string): string {
    if (!value) return '';
    return value.replace(/[^a-f0-9]/gi, '').toLowerCase();
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

function sanitizeEventSoundFilename(input: string): string | null {
  if (!input) {
    return null;
  }
  const leaf = basename(input.replace(/\\/g, '/')).trim();
  if (!leaf || leaf === '.' || leaf === '..') {
    return null;
  }
  if (/[<>:"|?*\x00-\x1f]/.test(leaf)) {
    return null;
  }
  return leaf;
}
