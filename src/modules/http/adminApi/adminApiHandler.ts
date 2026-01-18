import type { IncomingMessage, ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { resolve } from 'node:path';
import { createLogger, logManager, type LogLevel } from '@/core/logging/logger';
import { logBuffer } from '@/core/logging/logBuffer';
import { defaultMacId, normalizeMacId } from '@/core/utils/mac';
import { defaultLocalIp } from '@/core/utils/net';
import { getConfig, updateConfig } from '@/domain/config/configStore';
import {
  handleSpotifyOAuthCallback,
  handleSpotifyLibrespotOAuth,
  handleSpotifyLibrespotExport,
  deleteSpotifyAccount,
  buildSpotifyAuthLink,
} from '@/modules/content/providers/spotify/serviceAuth';
import { spotifyInputService } from '@/modules/audio/inputs/spotify/spotifyInputService';
import type { AudioServerConfig, SpotifyBridgeConfig } from '@/domain/config/types';
import { TRANSPORT_DEFINITIONS } from '@/modules/audio/outputs';
import { discoverAirplayDevices } from '@/modules/audio/outputs/airplay/airplayDiscovery';
import { discoverGoogleCastDevices } from '@/modules/audio/outputs/googleCast/googleCastDiscovery';
import { discoverDlnaDevices } from '@/modules/audio/outputs/dlna/dlnaDiscovery';
import { discoverSonosDevices } from '@/modules/audio/outputs/sonos/sonosDiscovery';
import { sendspinCore } from '@/modules/http/sendspin/sendspinCore';
import { discoverSpotifyConnectDevices } from '@/modules/audio/outputs/spotify/spotifyConnectDiscovery';
import { zoneManager } from '@/modules/zones/zoneManager';
import {
  notifyLineInChanged,
  notifyStorageAdded,
  notifyStorageListUpdated,
  notifyStorageRemoved,
} from '@/modules/loxone/ws/notifier';
import { contentManager } from '@/modules/content/contentManager';
import { musicAssistantStreamService } from '@/modules/content/providers/musicassistant/musicAssistantStreamService';
import type { StorageConfig } from '@/modules/content/storage/storageManager';
import { listAlertFiles, revertAlertFile, updateAlertFile } from '@/modules/alerts/alertFileManager';
import { favoritesManager } from '@/modules/zones/favorites/favoritesManager';
import { recentsManager } from '@/modules/zones/recents/recentsManager';
import { customRadioStore } from '@/modules/content/providers/customRadioStore';
import { TuneInClient } from '@/modules/content/providers/tunein/tuneinClient';
import { notifyReloadMusicApp } from '@/modules/loxone/ws/notifier';
import { groupManager } from '@/modules/groups/groupManager';
import { audioManager } from '@/modules/audio';
import { audioResampler } from '@/modules/audio/utils/audioFormat';
import https from 'node:https';
import { loadConfig as loadRuntimeConfig } from '@/config';
import { snapcastCore } from '@/modules/http/snapcast/snapcastCore';

type AdminApiOptions = {
  onReinitialize?: () => Promise<boolean>;
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

/**
 * Temporary admin API stub that returns 501 for every endpoint.
 */
export class AdminApiHandler {
  private readonly log = createLogger('Http', 'AdminApi');
  private readonly runtimeConfig = loadRuntimeConfig();
  private readonly onReinitialize?: () => Promise<boolean>;
  private clockOffsetCache: { offsetMs: number | null; sampledAt: number } = { offsetMs: null, sampledAt: 0 };
  private readonly routes: Route[];

  constructor(options: AdminApiOptions = {}) {
    this.onReinitialize = options.onReinitialize;
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
        pattern: /^\/spotify\/auth\/callback/,
        handler: async (req, res) => handleSpotifyOAuthCallback(req, res),
      },
      {
        method: 'POST',
        pattern: /^\/spotify\/librespot\/oauth$/,
        handler: async (req, res) => handleSpotifyLibrespotOAuth(req, res),
      },
      {
        pattern: /^\/spotify\/librespot\/credentials/,
        handler: async (req, res) => handleSpotifyLibrespotExport(req, res),
      },
      {
        method: 'GET',
        pattern: /^\/spotify\/librespot\/status$/,
        handler: async (_req, res) => this.handleSpotifyLibrespotStatus(res),
      },
      {
        method: 'POST',
        pattern: /^\/snapcast\/clients\/([^/]+)\/stream$/,
        handler: async (req, res, match) => {
          const clientId = decodeURIComponent(match[1] ?? '').trim();
          const body = (await this.readJsonBody(req)) as { streamId?: string } | null;
          const streamId = body?.streamId?.trim();
          if (!clientId || !streamId) {
            this.sendJson(res, 400, { error: 'invalid-snapcast-mapping' });
            return;
          }
          const result = snapcastCore.setClientStream(clientId, streamId);
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
      { method: 'GET', pattern: /^\/info$/, handler: (_req, res) => this.handleInfo(res) },
      { method: 'GET', pattern: /^\/zones\/states$/, handler: async (_req, res) => this.handleZoneStates(res) },
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
        handler: async (_req, res) => this.handleSendspinDiscovery(res),
      },
      {
        method: 'GET',
        pattern: /^\/transports\/snapcast\/clients$/,
        handler: async (_req, res) => this.handleSnapcastDiscovery(res),
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
      return offset;
    } catch (err) {
      this.log.debug('clock offset fetch failed', { message: err instanceof Error ? err.message : String(err) });
      return this.clockOffsetCache.offsetMs;
    }
  }

  private fetchClockOffset(): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const req = https.get(
        'https://worldtimeapi.org/api/timezone/Etc/UTC',
        {
          timeout: 1500,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body) as { unixtime?: number };
              const remoteMs = typeof parsed.unixtime === 'number' ? parsed.unixtime * 1000 : null;
              if (!remoteMs) return resolve(null);
              const offset = Date.now() - remoteMs;
              resolve(offset);
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error('timeout'));
      });
    });
  }

  private handleInfo(res: ServerResponse): void {
    try {
      const cfg = getConfig();
      const pkgVersion = this.readPackageVersion();
      const buildVersion = this.readBuildVersion(pkgVersion);

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
      };

      this.sendJson(res, 200, payload);
    } catch (err) {
      this.log.error('failed to produce admin info', { err });
      this.sendJson(res, 500, { error: 'info-unavailable' });
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
    const envVersion = process.env.APP_VERSION || process.env.BUILD_VERSION;
    const envTimestamp = process.env.BUILD_TIMESTAMP || process.env.BUILD_DATE;
    const baseVersion = envVersion || pkgVersion;
    if (envTimestamp) return `${baseVersion}-${envTimestamp}`;
    return baseVersion;
  }

  private readonly hiddenTransportIds = new Set(['spotify', 'sendspin-cast', 'dlna']);

  private handleTransportDefinitions(res: ServerResponse): void {
    const payload = TRANSPORT_DEFINITIONS.filter(
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
    this.sendJson(res, 200, { transports: payload });
  }

  private async handleZoneStates(res: ServerResponse): Promise<void> {
    try {
      const cfg = getConfig();
      const clockOffsetMs = await this.getClockOffsetMs();
      const zones = (cfg.zones ?? []).map((zone) => {
        const state = zoneManager.getState(zone.id);
        const session = audioManager.getSession(zone.id);
        const playbackSource = session?.playbackSource;
        const effectiveOutput = audioManager.getEffectiveOutputSettings(zone.id);
        const techSnapshot = zoneManager.getTechnicalSnapshot(zone.id);
        const sendspinTransport = (zone.transports ?? []).find((t) => t.id === 'sendspin') as
          | ({ id: string; clientId?: string } & Record<string, unknown>)
          | undefined;
        const sendspinClientId =
          typeof sendspinTransport?.clientId === 'string' ? sendspinTransport.clientId : null;
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
        const streamStats = audioManager.getStreamStats(zone.id);
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
      const raw = await musicAssistantStreamService.listPlayers();
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

  private async handleTransportPing(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = (await this.readJsonBody(req)) as { host?: string; port?: number } | null;
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

  private async handleSendspinDiscovery(res: ServerResponse): Promise<void> {
    try {
      const clients = sendspinCore.listClients().map((client) => ({
        id: client.clientId,
        clientId: client.clientId,
        remote: client.remote,
        roles: client.roles,
        playbackState: client.playbackState,
      }));
      this.sendJson(res, 200, { clients });
    } catch (err) {
      this.log.warn('sendspin discovery failed', { err });
      this.sendJson(res, 500, { error: 'sendspin-discovery-failed' });
    }
  }

  private handleSnapcastDiscovery(res: ServerResponse): void {
    try {
      const clients = snapcastCore.listClients().map((client) => ({
        id: client.clientId || client.streamId,
        clientId: client.clientId,
        streamId: client.streamId,
        connected: client.connected,
        connectedAt: client.connectedAt,
      }));
      this.sendJson(res, 200, { clients });
    } catch (err) {
      this.log.warn('snapcast discovery failed', { err });
      this.sendJson(res, 500, { error: 'snapcast-discovery-failed' });
    }
  }

  private async handleSpotifyDeviceDiscovery(res: ServerResponse): Promise<void> {
    try {
      const devices = await discoverSpotifyConnectDevices();
      this.sendJson(res, 200, { devices });
    } catch (err) {
      this.log.warn('spotify device discovery failed', { err });
      this.sendJson(res, 500, { error: 'spotify-discovery-failed' });
    }
  }

  private handleLogsSnapshot(res: ServerResponse): void {
    try {
      const snapshot = logBuffer.snapshot();
      const cfg = getConfig();
      const consoleLevel = cfg.system?.logging?.consoleLevel ?? 'info';
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
      const cfg = getConfig();
      const zoneNameMap = new Map<number, string>();
      (cfg.zones ?? []).forEach((zone) => {
        zoneNameMap.set(zone.id, zone.name);
      });
      const groups = groupManager.getAllGroups().map((group) => ({
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
    const body = (await this.readJsonBody(req)) as { level?: string } | null;
    const level = this.parseLogLevel(body?.level);
    if (!level) {
      this.sendJson(res, 400, { error: 'invalid-log-level' });
      return;
    }
    try {
      await updateConfig((cfg) => {
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
      const status = contentManager.getScanStatus();
      const stats = contentManager.getLibraryStats();
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
      const stats = contentManager.getLibraryStorageStats(storageId);
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
        Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(Math.round(rawLimit), 24)
          : 8;
      const covers = contentManager.getLibraryCoverSamples(limit);
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
        Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(Math.round(rawLimit), 24)
          : 8;
      const covers = contentManager.getLibraryStorageCoverSamples(storageId, limit);
      this.sendJson(res, 200, { covers });
    } catch (err) {
      this.log.warn('library storage covers fetch failed', { err, storageId });
      this.sendJson(res, 500, { error: 'library-storage-covers-failed' });
    }
  }

  private async handleLibraryUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readJsonBody(req)) as { filename?: string; relativePath?: string; data?: string } | null;
    const filename = typeof body?.filename === 'string' ? body.filename.trim() : '';
    const relativePath = typeof body?.relativePath === 'string' ? body.relativePath.trim() : '';
    const data = typeof body?.data === 'string' ? body.data : '';
    if ((!filename && !relativePath) || !data) {
      this.sendJson(res, 400, { error: 'invalid-library-upload' });
      return;
    }
    try {
      const upload = await contentManager.uploadLibraryAudio(relativePath || filename, data);
      void contentManager.rescanLibrary().catch(() => undefined);
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

  private async handleLibraryStorageList(res: ServerResponse): Promise<void> {
    try {
      const storages = await contentManager.listStorages();
      notifyStorageListUpdated(storages);
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
    const body = (await this.readJsonBody(req)) as Partial<StorageConfig> | null;
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
      const storage = await contentManager.addStorage({
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
      notifyStorageAdded(storage);
      notifyStorageListUpdated(await contentManager.listStorages());
      void contentManager.rescanLibrary().catch(() => undefined);
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
      await contentManager.deleteStorage(id);
      notifyStorageRemoved(id);
      notifyStorageListUpdated(await contentManager.listStorages());
      void contentManager.rescanLibrary().catch(() => undefined);
      this.sendJson(res, 202, { status: 'storage-deleted', id });
    } catch (err) {
      this.log.warn('library storage delete failed', { err, id });
      this.sendJson(res, 500, { error: 'library-storage-delete-failed' });
    }
  }

  private async handleLibraryRescan(res: ServerResponse): Promise<void> {
    try {
      await contentManager.rescanLibrary();
      this.sendJson(res, 202, { status: 'rescan-started' });
    } catch (err) {
      this.log.warn('library rescan failed', { err });
      this.sendJson(res, 500, { error: 'library-rescan-failed' });
    }
  }

  private async handleCustomRadioList(res: ServerResponse): Promise<void> {
    try {
      const stations = await customRadioStore.list();
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
    const body = (await this.readJsonBody(req)) as { name?: string; stream?: string; coverurl?: string } | null;
    if (!body || typeof body !== 'object' || !body.name || !body.stream) {
      this.sendJson(res, 400, { error: 'invalid-radio-payload' });
      return;
    }
    try {
      const station = await customRadioStore.add({
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
      const removed = await customRadioStore.remove(stationId);
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
    const body = (await this.readJsonBody(req)) as { username?: string } | null;
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
      await favoritesManager.clearAll();
      this.sendJson(res, 202, { status: 'favorites-purged' });
    } catch (err) {
      this.log.warn('favorites purge failed', { err });
      this.sendJson(res, 500, { error: 'favorites-purge-failed' });
    }
  }

  private async handleRecentsPurge(res: ServerResponse): Promise<void> {
    try {
      await recentsManager.clearAll();
      this.sendJson(res, 202, { status: 'recents-purged' });
    } catch (err) {
      this.log.warn('recents purge failed', { err });
      this.sendJson(res, 500, { error: 'recents-purge-failed' });
    }
  }

  private async handleZoneFavoritesPurge(zoneId: number, res: ServerResponse): Promise<void> {
    try {
      await favoritesManager.clear(zoneId);
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
    const body = (await this.readJsonBody(req)) as { destinations?: unknown } | null;
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
      await favoritesManager.copy(zoneId, destinations);
      this.sendJson(res, 202, { status: 'favorites-copied', zoneId, destinations });
    } catch (err) {
      this.log.warn('favorites copy failed', { err, zoneId, destinations });
      this.sendJson(res, 500, { error: 'favorites-copy-failed' });
    }
  }

  private async handleZoneRecentsPurge(zoneId: number, res: ServerResponse): Promise<void> {
    try {
      await recentsManager.clear(zoneId);
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
    const body = (await this.readJsonBody(req)) as { data?: string } | null;
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
      await deleteSpotifyAccount(accountId);
      this.sendJson(res, 204, {});
    } catch (err) {
      this.log.warn('spotify account delete failed', { err, accountId });
      this.sendJson(res, 500, { error: 'spotify-account-delete-failed' });
    }
  }

  private async handleSpotifyAccountLink(res: ServerResponse): Promise<void> {
    try {
      const cfg = getConfig();
      const host = cfg.system?.audioserver?.ip?.trim() || '127.0.0.1';
      const link = buildSpotifyAuthLink({ audioServerHost: host });
      this.sendJson(res, 200, { link });
    } catch (err) {
      this.log.warn('spotify account link build failed', { err });
      this.sendJson(res, 500, { error: 'spotify-account-link-failed' });
    }
  }

  private async handleSpotifyLibrespotStatus(res: ServerResponse): Promise<void> {
    try {
      const zones = spotifyInputService.listCredentialStates();
      this.sendJson(res, 200, { zones });
    } catch (err) {
      this.log.warn('spotify librespot status failed', { err });
      this.sendJson(res, 500, { error: 'spotify-librespot-status-failed' });
    }
  }

  private async handleSpotifyBridgeCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readJsonBody(req)) as Partial<SpotifyBridgeConfig> | null;
    const provider = typeof body?.provider === 'string' ? body.provider.trim().toLowerCase() : '';
    if (!provider) {
      this.sendJson(res, 400, { error: 'invalid-bridge-payload' });
      return;
    }
    if (provider === 'musicassistant') {
      const apiKeyValid = typeof body?.apiKey === 'string' && body.apiKey.trim().length > 0;
      if (!apiKeyValid) {
        this.sendJson(res, 400, { error: 'api-key-required' });
        return;
      }
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
              : id;

    const bridge: SpotifyBridgeConfig = {
      id,
      label: typeof body?.label === 'string' && body.label.trim() ? body.label.trim() : defaultLabel,
      provider,
      enabled: body?.enabled !== false,
      registerAll: body?.registerAll !== false,
      accountId: undefined,
      host: typeof body?.host === 'string' && body.host.trim() ? body.host.trim() : undefined,
      port:
        typeof body?.port === 'number' && Number.isFinite(body.port) && body.port > 0
          ? Math.round(body.port)
          : provider === 'musicassistant'
            ? 8095
            : undefined,
      apiKey: typeof body?.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : undefined,
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
    };

    try {
      await updateConfig((cfg) => {
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
      contentManager.refreshFromConfig();
      musicAssistantStreamService.configureFromConfig();
      const cfg = getConfig();
      await musicAssistantStreamService.registerZones(cfg.zones ?? []);
      notifyReloadMusicApp('useradd', bridge.provider || 'spotify', bridge.id);
      this.sendJson(res, 200, { bridge });
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
      const cfgBefore = getConfig();
      const existing = (cfgBefore.content?.spotify?.bridges ?? []).find(
        (b) => typeof b?.id === 'string' && b.id.trim().toLowerCase() === bridgeId.trim().toLowerCase(),
      );
      await updateConfig((cfg) => {
        if (!cfg.content?.spotify?.bridges) return;
        const current = cfg.content.spotify.bridges ?? [];
        cfg.content.spotify.bridges = current.filter(
          (b) => typeof b?.id !== 'string' || b.id.trim().toLowerCase() !== bridgeId.trim().toLowerCase(),
        );
      });
      contentManager.refreshFromConfig();
      musicAssistantStreamService.configureFromConfig();
      const cfg = getConfig();
      await musicAssistantStreamService.registerZones(cfg.zones ?? []);
      if (existing) {
        notifyReloadMusicApp('userdel', existing.provider || 'spotify', existing.id);
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

  private async reloadZones(zoneIds?: number[]): Promise<void> {
    const cfg = getConfig();
    if (!zoneIds || zoneIds.length === 0) {
      await zoneManager.replaceAll(cfg.zones ?? [], cfg.inputs ?? null);
      return;
    }
    const set = new Set(zoneIds);
    const targets = (cfg.zones ?? []).filter((z) => set.has(z.id));
    if (targets.length === 0) {
      await zoneManager.replaceAll(cfg.zones ?? [], cfg.inputs ?? null);
      return;
    }
    await zoneManager.replaceZones(targets, cfg.inputs ?? null);
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

    if (req.method === 'GET' && (pathname.endsWith('/config') || pathname.endsWith('/config/'))) {
      const cfg = getConfig();
      // Match legacy admin payload shape
      this.sendJson(res, 200, { config: cfg });
      return;
    }

    if (req.method === 'POST' && isClear) {
      const currentMacId = getConfig()?.system?.audioserver?.macId;
      await updateConfig((cfg) => {
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
      const body = (await this.readJsonBody(req)) as { zones?: Partial<AudioServerConfig['zones']> } | null;
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

      await updateConfig((cfg) => {
        if (!cfg.zones) cfg.zones = [];
        body.zones!.forEach((incoming: any) => {
          const target = cfg.zones!.find((z) => z.id === incoming.id);
          if (target) {
            if (incoming.inputs !== undefined) {
              target.inputs = incoming.inputs as any;
            }
            if (incoming.name !== undefined) target.name = incoming.name;
            if (incoming.source !== undefined) target.source = incoming.source;
            if (incoming.sourceSerial !== undefined) target.sourceSerial = incoming.sourceSerial;
            if (incoming.transport !== undefined || incoming.transports !== undefined) {
              const normalized = this.normalizeTransportPayload(incoming);
              target.transports = normalized;
            }
          } else {
            cfg.zones!.push(incoming as any);
          }
        });
      });
      await this.reloadZones(updatedIds);
      this.sendJson(res, 204, {});
      return;
    }

    if (req.method === 'POST' && isInputsUpdate) {
      const body = (await this.readJsonBody(req)) as
        | {
            airplay?: { enabled?: boolean };
            spotify?: { enabled?: boolean };
            bluetooth?: { enabled?: boolean };
            lineIn?: { inputs?: Array<Record<string, unknown>> | null };
          }
        | null;
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

      await updateConfig((cfg) => {
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
        notifyLineInChanged();
      }
      await this.reloadZones();
      this.sendJson(res, 204, {});
      return;
    }

    if (req.method === 'POST' && isSystemUpdate) {
      const body = (await this.readJsonBody(req)) as
        | {
            audioserver?: { macId?: string; ip?: string };
          }
        | null;
      if (!body || typeof body !== 'object') {
        this.sendJson(res, 400, { error: 'invalid-system-payload' });
        return;
      }
      if (!body.audioserver || typeof body.audioserver !== 'object') {
        this.sendJson(res, 400, { error: 'invalid-audioserver-payload' });
        return;
      }
      const rawMac = body.audioserver.macId;
      const rawIp = body.audioserver.ip;
      if (typeof rawMac !== 'string' && typeof rawIp !== 'string') {
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

      await updateConfig((cfg) => {
        if (!cfg.system) cfg.system = this.defaultConfig().system;
        if (!cfg.system.audioserver) {
          cfg.system.audioserver = this.defaultConfig().system.audioserver;
        }
        if (normalizedMac) {
          cfg.system.audioserver.macId = normalizedMac;
        }
        if (normalizedIp) {
          cfg.system.audioserver.ip = normalizedIp;
        }
      });
      this.sendJson(res, 204, {});
      return;
    }

    if (req.method === 'POST' && isContentUpdate) {
      const body = (await this.readJsonBody(req)) as
        | {
            radio?: { tuneInUsername?: string | null };
            spotify?: { clientId?: string | null };
            library?: { enabled?: boolean; autoScan?: boolean };
          }
        | null;
      if (!body || typeof body !== 'object') {
        this.sendJson(res, 400, { error: 'invalid-content-payload' });
        return;
      }

      await updateConfig((cfg) => {
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
      contentManager.refreshFromConfig();
      this.sendJson(res, 204, {});
      return;
    }

    if (req.method === 'POST' && isImport) {
      const body = await this.readJsonBody(req);
      if (!body || typeof body !== 'object') {
        this.sendJson(res, 400, { error: 'invalid-config' });
        return;
      }

      await updateConfig((cfg) => {
        // Replace top-level config keys with imported payload
        Object.assign(cfg, body as Partial<AudioServerConfig>);
      });
      await this.reloadZones();
      this.sendJson(res, 204, {});
      return;
    }

    this.handleNotImplemented(res, req.method ?? 'GET', pathname);
  }

  private normalizeTransportPayload(payload: any): any[] {
    if (payload?.transport === null) {
      return [];
    }
    if (payload?.transport) {
      return [payload.transport];
    }
    if (Array.isArray(payload?.transports)) {
      return payload.transports;
    }
    return [];
  }

  private async readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private defaultConfig(): AudioServerConfig {
    return {
      system: {
        miniserver: { ip: '', serial: '' },
        audioserver: {
          ip: defaultLocalIp(),
          name: 'Unconfigured',
          uuid: '',
          macId: defaultMacId(),
          paired: false,
          extensions: [],
        },
        logging: {
          consoleLevel: 'info',
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
      zones: [],
      rawAudioConfig: {
        raw: null,
        rawString: null,
        crc32: null,
      },
    };
  }
}
