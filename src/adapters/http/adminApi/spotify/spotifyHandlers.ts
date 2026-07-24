import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ComponentLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { NotifierPort } from '@/ports/NotifierPort';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { SpotifyInputService } from '@/adapters/inputs/spotify/spotifyInputService';
import type { SpotifyServiceManagerProvider } from '@/adapters/content/providers/spotifyServiceManager';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { MusicAssistantStreamService } from '@/adapters/inputs/musicassistant/musicAssistantStreamService';
import type { SpotifyBridgeConfig } from '@/domain/config/types';
import {
  buildSpotifyAuthLink,
  deleteSpotifyAccount,
  handleSpotifyLibrespotExport,
  handleSpotifyLibrespotOAuth,
  handleSpotifyOAuthCallback,
} from '@/adapters/content/providers/spotify/serviceAuth';
import type { Route } from '@/adapters/http/adminApi/routeTypes';
import { defaultConfig } from '@/adapters/http/adminApi/config/configHandlers';
import type { MusicAssistantConnectionResult } from '@/adapters/http/adminApi/musicassistant/musicAssistantHelpers';
import {
  isValidMusicAssistantHost,
  testMusicAssistantBridge,
} from '@/adapters/http/adminApi/musicassistant/musicAssistantHelpers';

export type { MusicAssistantConnectionResult };

export type SpotifyHandlerDeps = {
  log: ComponentLogger;
  configPort: ConfigPort;
  notifier: NotifierPort;
  contentManager: ContentManager;
  spotifyInputService: SpotifyInputService;
  spotifyManagerProvider: SpotifyServiceManagerProvider;
  zoneManager: ZoneManagerFacade;
  musicAssistantStreamService: MusicAssistantStreamService;
  readJsonBody: (req: IncomingMessage, res: ServerResponse, maxBytes?: number) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
};

export function buildSpotifyRoutes(deps: SpotifyHandlerDeps): Route[] {
  return [
    {
      pattern: /^\/spotify\/auth\/callback/,
      handler: async (req, res) =>
        handleSpotifyOAuthCallback(
          req,
          res,
          deps.notifier,
          deps.configPort,
          deps.contentManager,
          deps.spotifyInputService,
        ),
    },
    {
      method: 'POST',
      pattern: /^\/spotify\/librespot\/oauth$/,
      handler: async (req, res) =>
        handleSpotifyLibrespotOAuth(
          req,
          res,
          deps.configPort,
          deps.spotifyInputService,
          deps.spotifyManagerProvider,
        ),
    },
    {
      pattern: /^\/spotify\/librespot\/credentials/,
      handler: async (req, res) => handleSpotifyLibrespotExport(req, res, deps.configPort),
    },
    {
      method: 'GET',
      pattern: /^\/spotify\/librespot\/status$/,
      handler: async (_req, res) => handleSpotifyLibrespotStatus(res, deps),
    },
    {
      method: 'DELETE',
      pattern: /^\/spotify\/accounts\/([^/]+)$/,
      handler: async (_req, res, match) => {
        const accountId = decodeURIComponent(match[1] ?? '');
        await handleSpotifyAccountDelete(accountId, res, deps);
      },
    },
    {
      method: 'GET',
      pattern: /^\/spotify\/accounts\/link$/,
      handler: async (_req, res) => {
        await handleSpotifyAccountLink(res, deps);
      },
    },
    {
      method: 'POST',
      pattern: /^\/spotify\/bridges$/,
      handler: async (req, res) => {
        await handleSpotifyBridgeCreate(req, res, deps);
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/spotify\/bridges\/([^/]+)$/,
      handler: async (_req, res, match) => {
        const bridgeId = decodeURIComponent(match[1] ?? '');
        await handleSpotifyBridgeDelete(bridgeId, res, deps);
      },
    },
  ];
}

async function handleSpotifyAccountDelete(
  accountId: string,
  res: ServerResponse,
  deps: SpotifyHandlerDeps,
): Promise<void> {
  if (!accountId) {
    deps.sendJson(res, 400, { error: 'invalid-account-id' });
    return;
  }
  try {
    await deleteSpotifyAccount(
      deps.configPort,
      accountId,
      deps.notifier,
      deps.contentManager,
      deps.spotifyInputService,
    );
    deps.sendJson(res, 204, {});
  } catch (err) {
    deps.log.warn('spotify account delete failed', { err, accountId });
    deps.sendJson(res, 500, { error: 'spotify-account-delete-failed' });
  }
}

async function handleSpotifyAccountLink(
  res: ServerResponse,
  deps: SpotifyHandlerDeps,
): Promise<void> {
  try {
    const cfg = deps.configPort.getConfig();
    const host = cfg.system?.audioserver?.ip?.trim() || '127.0.0.1';
    const link = buildSpotifyAuthLink({ audioServerHost: host }, deps.configPort);
    deps.sendJson(res, 200, { link });
  } catch (err) {
    deps.log.warn('spotify account link build failed', { err });
    deps.sendJson(res, 500, { error: 'spotify-account-link-failed' });
  }
}

async function handleSpotifyLibrespotStatus(
  res: ServerResponse,
  deps: SpotifyHandlerDeps,
): Promise<void> {
  try {
    const zones = deps.spotifyInputService.listCredentialStates();
    deps.sendJson(res, 200, { zones });
  } catch (err) {
    deps.log.warn('spotify librespot status failed', { err });
    deps.sendJson(res, 500, { error: 'spotify-librespot-status-failed' });
  }
}

async function handleSpotifyBridgeCreate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SpotifyHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res)) as Partial<SpotifyBridgeConfig> | null;
  if (res.writableEnded) {
    return;
  }
  const provider = typeof body?.provider === 'string' ? body.provider.trim().toLowerCase() : '';
  if (!provider) {
    deps.sendJson(res, 400, { error: 'invalid-bridge-payload' });
    return;
  }
  const isMusicAssistant = provider === 'musicassistant';
  if (provider === 'musicassistant') {
    const apiKeyValid = typeof body?.apiKey === 'string' && body.apiKey.trim().length > 0;
    if (!apiKeyValid) {
      deps.sendJson(res, 400, { error: 'api-key-required' });
      return;
    }
  }

  let musicAssistantHost: string | undefined;
  let musicAssistantPort: number | undefined;
  let musicAssistantApiKey: string | undefined;
  let musicAssistantConnection: MusicAssistantConnectionResult | null = null;

  if (isMusicAssistant) {
    const hostRaw = typeof body?.host === 'string' ? body.host.trim() : '';
    const portRaw = body?.port;
    musicAssistantHost = hostRaw || '127.0.0.1';
    musicAssistantPort =
      typeof portRaw === 'number' && Number.isFinite(portRaw) && portRaw > 0
        ? Math.round(portRaw)
        : 8095;
    musicAssistantApiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';

    if (!isValidMusicAssistantHost(musicAssistantHost)) {
      deps.sendJson(res, 400, { error: 'invalid-musicassistant-host', message: 'Invalid Music Assistant host.' });
      return;
    }
    if (!musicAssistantPort || musicAssistantPort < 1 || musicAssistantPort > 65535) {
      deps.sendJson(res, 400, { error: 'invalid-musicassistant-port', message: 'Invalid Music Assistant port.' });
      return;
    }
    if (!musicAssistantApiKey) {
      deps.sendJson(res, 400, { error: 'api-key-required' });
      return;
    }

    const testResult = await testMusicAssistantBridge(
      musicAssistantHost,
      musicAssistantPort,
      musicAssistantApiKey,
    );
    if (!testResult.ok) {
      deps.sendJson(res, 400, {
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
    mode: isMusicAssistant && body?.mode === 'sink' ? 'sink' : isMusicAssistant ? 'source' : undefined,
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
    youtubeApiKey:
      typeof body?.youtubeApiKey === 'string' && body.youtubeApiKey.trim()
        ? body.youtubeApiKey.trim()
        : undefined,
    soundcloudOauthToken:
      typeof body?.soundcloudOauthToken === 'string' && body.soundcloudOauthToken.trim()
        ? body.soundcloudOauthToken.trim()
        : undefined,
    soundcloudClientId:
      typeof body?.soundcloudClientId === 'string' && body.soundcloudClientId.trim()
        ? body.soundcloudClientId.trim()
        : undefined,
  };

  try {
    await deps.configPort.updateConfig((cfg) => {
      if (!cfg.content) cfg.content = defaultConfig().content;
      if (!cfg.content.spotify) cfg.content.spotify = defaultConfig().content.spotify;
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
    deps.contentManager.refreshFromConfig();
    if (
      provider === 'applemusic' ||
      provider === 'deezer' ||
      provider === 'tidal' ||
      provider === 'ytmusic' ||
      provider === 'soundcloud'
    ) {
      deps.zoneManager.refreshContentProviders();
    }
    deps.musicAssistantStreamService.configureFromConfig();
    const cfg = deps.configPort.getConfig();
    await deps.musicAssistantStreamService.registerZones(cfg.zones ?? []);
    const connection = isMusicAssistant ? musicAssistantConnection ?? undefined : undefined;
    if (connection?.ok) {
      deps.log.info('music assistant connection ok', { host: connection.host, port: connection.port });
    }
    deps.notifier.notifyReloadMusicApp('useradd', bridge.provider || 'spotify', bridge.id);
    deps.sendJson(res, 200, { bridge, connection });
  } catch (err) {
    deps.log.warn('spotify bridge create failed', { err });
    deps.sendJson(res, 500, { error: 'spotify-bridge-create-failed' });
  }
}

async function handleSpotifyBridgeDelete(
  bridgeId: string,
  res: ServerResponse,
  deps: SpotifyHandlerDeps,
): Promise<void> {
  if (!bridgeId) {
    deps.sendJson(res, 400, { error: 'invalid-bridge-id' });
    return;
  }
  try {
    const cfgBefore = deps.configPort.getConfig();
    const existing = (cfgBefore.content?.spotify?.bridges ?? []).find(
      (b) => typeof b?.id === 'string' && b.id.trim().toLowerCase() === bridgeId.trim().toLowerCase(),
    );
    await deps.configPort.updateConfig((cfg) => {
      if (!cfg.content?.spotify?.bridges) return;
      const current = cfg.content.spotify.bridges ?? [];
      cfg.content.spotify.bridges = current.filter(
        (b) => typeof b?.id !== 'string' || b.id.trim().toLowerCase() !== bridgeId.trim().toLowerCase(),
      );
    });
    deps.contentManager.refreshFromConfig();
    const provider = typeof existing?.provider === 'string' ? existing.provider.trim().toLowerCase() : '';
    if (provider === 'applemusic' || provider === 'deezer' || provider === 'tidal' || provider === 'ytmusic') {
      deps.zoneManager.refreshContentProviders();
    }
    deps.musicAssistantStreamService.configureFromConfig();
    const cfg = deps.configPort.getConfig();
    await deps.musicAssistantStreamService.registerZones(cfg.zones ?? []);
    if (existing) {
      deps.notifier.notifyReloadMusicApp('userdel', existing.provider || 'spotify', existing.id);
    }
    deps.sendJson(res, 204, {});
  } catch (err) {
    deps.log.warn('spotify bridge delete failed', { err, bridgeId });
    deps.sendJson(res, 500, { error: 'spotify-bridge-delete-failed' });
  }
}
