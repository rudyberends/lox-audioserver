import logger from '../../../utils/troxorlogger';
import {
  registerZoneContentAdapter,
  ZoneContentPlaybackAdapter,
  ZoneContentCommand,
  ZoneContentFactoryOptions,
} from '../../zone/capabilities';
import MusicAssistantClient from '../../zone/MusicAssistant/client';
import { denormalizeMediaUri, denormalizePlaylistUri, normalizeMediaUri, toPlaylistCommandUri } from './utils';

const SUPPORTED_COMMANDS: ZoneContentCommand[] = ['serviceplay', 'playlistplay', 'announce'];

class MusicAssistantContentAdapter implements ZoneContentPlaybackAdapter {
  private client?: MusicAssistantClient;
  private connectPromise?: Promise<void>;
  private ownsClient = false;

  constructor(private readonly options: ZoneContentFactoryOptions, private readonly maPlayerId: string, private readonly host: string, private readonly port: number) {}

  handles(command: string): boolean {
    return SUPPORTED_COMMANDS.includes(command as ZoneContentCommand);
  }

  async execute(command: ZoneContentCommand, payload: unknown): Promise<boolean> {
    const client = await this.ensureClient();
    if (!client) {
      logger.warn(`[MusicAssistant][ContentAdapter][Zone ${this.options.zoneId}] Unable to execute ${command}: client unavailable`);
      return false;
    }

    switch (command) {
      case 'serviceplay':
        return this.handleServicePlay(client, payload);
      case 'playlistplay':
        return this.handlePlaylistPlay(client, payload);
      case 'announce':
        return this.handleAnnounce(client, payload);
      default:
        return false;
    }
  }

  async cleanup(): Promise<void> {
    try {
      if (this.ownsClient) {
        this.client?.cleanup();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.debug(`[MusicAssistant][ContentAdapter][Zone ${this.options.zoneId}] Cleanup error: ${message}`);
    } finally {
      this.client = undefined;
      this.connectPromise = undefined;
      this.ownsClient = false;
    }
  }

  private async ensureClient(): Promise<MusicAssistantClient | undefined> {
    if (!this.client && this.options.acquireClient) {
      const acquired = await this.options.acquireClient(this.options.zoneId);
      if (acquired?.client) {
        this.client = acquired.client as MusicAssistantClient;
        this.ownsClient = false;
        return this.client;
      }
    }

    if (!this.client) {
      this.client = new MusicAssistantClient(this.host, this.port);
      this.ownsClient = true;
    }

    if (!this.connectPromise) {
      this.connectPromise = this.client
        .connect()
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(`[MusicAssistant][ContentAdapter][Zone ${this.options.zoneId}] Connection failed: ${message}`);
          this.client?.cleanup();
          this.client = undefined;
          throw error;
        })
        .finally(() => {
          this.connectPromise = undefined;
        });
    }

    try {
      await this.connectPromise;
      return this.client;
    } catch {
      return undefined;
    }
  }

  private async handleServicePlay(client: MusicAssistantClient, payload: unknown): Promise<boolean> {
    const info = parseCommandPayload(payload);

    if (!info || !info.audiopath) {
      logger.warn(`[MusicAssistant][ContentAdapter][Zone ${this.options.zoneId}] serviceplay payload missing audiopath`);
      return true;
    }

    const stream = String(info.audiopath ?? info.id ?? '');
    if (!stream) {
      logger.warn(`[MusicAssistant][ContentAdapter][Zone ${this.options.zoneId}] serviceplay payload missing stream`);
      return true;
    }
    const targetStream = denormalizeMediaUri(stream);
    logger.info(`[MusicAssistant][ContentAdapter][Zone ${this.options.zoneId}] serviceplay: ${stream}`);

    try {
      await client.rpc('player_queues/play_media', {
        queue_id: this.maPlayerId,
        media: [targetStream],
        option: 'replace',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[MusicAssistant][ContentAdapter][Zone ${this.options.zoneId}] Failed to play radio stream ${stream}: ${message}`);
    }

    return true;
  }

  private async handlePlaylistPlay(client: MusicAssistantClient, payload: unknown): Promise<boolean> {
    const info = parseCommandPayload(payload);

    if (!info) {
      logger.warn(`[MusicAssistant][ContentAdapter][Zone ${this.options.zoneId}] playlistplay payload missing`);
      return true;
    }

    const playlistUri =
      coerceToOptionalString(info.playlistCommandUri) ??
      coerceToOptionalString(info.audiopath) ??
      coerceToOptionalString(info.playlistId) ??
      coerceToOptionalString(info.id);
    const playlistFallback =
      coerceToOptionalString(info.rawId) ??
      coerceToOptionalString(info.playlistId) ??
      coerceToOptionalString(info.id) ??
      coerceToOptionalString(info.audiopath);
    if (!playlistUri) {
      logger.warn(`[MusicAssistant][ContentAdapter][Zone ${this.options.zoneId}] playlistplay payload missing playlist URI`);
      return true;
    }

    const option = typeof info.option === 'string' && info.option ? info.option : 'replace';
    const startItem =
      coerceToOptionalString(info.start_item) ??
      coerceToOptionalString(info.startItem) ??
      coerceToOptionalString(info.track);
    const normalizedPlaylistUri = normalizePlaylistCommandUri(playlistUri, playlistFallback);
    const targetUri = normalizedPlaylistUri || playlistUri || playlistFallback;
    const maUri = denormalizePlaylistUri(targetUri ?? playlistUri ?? '') || denormalizeMediaUri(targetUri ?? playlistUri ?? '');

    logger.info(`[MusicAssistant][ContentAdapter][Zone ${this.options.zoneId}] playlistplay: ${targetUri}`);

    try {
      const rpcPayload: Record<string, any> = {
        queue_id: this.maPlayerId,
        media: [maUri],
        option,
      };
      if (startItem) rpcPayload.start_item = denormalizeMediaUri(startItem);
      await client.rpc('player_queues/play_media', rpcPayload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[MusicAssistant][ContentAdapter][Zone ${this.options.zoneId}] Failed to play playlist ${playlistUri}: ${message}`);
    }

    return true;
  }

  private async handleAnnounce(client: MusicAssistantClient, payload: unknown): Promise<boolean> {
    const info = parseCommandPayload(payload);
    if (!info) {
      logger.warn(`[MusicAssistant][ContentAdapter][Zone ${this.options.zoneId}] announce payload missing`);
      return true;
    }

    const announcementUrl =
      coerceToOptionalString(info.url) ??
      coerceToOptionalString(info.audiopath) ??
      coerceToOptionalString(info.announcement_url);
    if (!announcementUrl) {
      logger.warn(`[MusicAssistant][ContentAdapter][Zone ${this.options.zoneId}] announce payload missing url`);
      return true;
    }

    const rpcPayload: Record<string, unknown> = {
      player_id: this.maPlayerId,
      url: announcementUrl,
    };

    const preAnnounce =
      coerceToOptionalBoolean(info.pre_announce ?? info.preAnnounce ?? info.preannounce);
    if (preAnnounce !== undefined) {
      rpcPayload.pre_announce = preAnnounce;
    }

    const preAnnounceUrl = coerceToOptionalString(
      info.pre_announce_url ?? info.preAnnounceUrl ?? info.preannounce_url,
    );
    if (preAnnounceUrl) {
      rpcPayload.pre_announce_url = preAnnounceUrl;
    }

    const volumeLevel = coerceToOptionalNumber(
      info.volume_level ?? info.volumeLevel ?? info.announcement_volume,
    );
    if (volumeLevel !== undefined) {
      rpcPayload.volume_level = volumeLevel;
    }

    const playerGroup = coerceToOptionalBoolean(info.player_group ?? info.playerGroup);
    if (playerGroup !== undefined) {
      rpcPayload.player_group = playerGroup;
    }

    const expirationSecs = coerceToOptionalNumber(
      info.expiration_secs ?? info.expirationSecs ?? info.ttl,
    );
    if (expirationSecs !== undefined) {
      rpcPayload.expiration_secs = expirationSecs;
    }

    try {
      await client.rpc('players/cmd/play_announcement', rpcPayload);
      logger.info(`[MusicAssistant][ContentAdapter][Zone ${this.options.zoneId}] Announcement playing via ${announcementUrl}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[MusicAssistant][ContentAdapter][Zone ${this.options.zoneId}] Failed to send announcement command: ${message}`);
    }

    return true;
  }
}

type CommandPayload = Record<string, any>;

function parseCommandPayload(param: unknown): CommandPayload | undefined {
  if (param === undefined || param === null) return undefined;

  if (typeof param === 'string') {
    try {
      return JSON.parse(param);
    } catch {
      return { audiopath: param };
    }
  }

  if (Array.isArray(param) && param.length > 0) {
    const first = param[0];
    if (typeof first === 'object' && first !== null) {
      return first as CommandPayload;
    }
    try {
      return JSON.parse(String(first));
    } catch {
      return { audiopath: String(first) };
    }
  }

  if (typeof param === 'object') {
    return param as CommandPayload;
  }

  return undefined;
}

function coerceToOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return undefined;
}

function coerceToOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return undefined;
    return trimmed === 'true' || trimmed === '1' || trimmed === 'yes' || trimmed === 'enable';
  }
  if (typeof value === 'number') return value !== 0;
  return undefined;
}

function coerceToOptionalNumber(value: unknown): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function normalizePlaylistCommandUri(uri: string, fallback?: string | undefined): string | undefined {
  const trimmed = (uri || '').trim();
  if (!trimmed) return fallback;

  if (trimmed.startsWith('library:')) {
    return trimmed;
  }

  const normalizedMedia = normalizeMediaUri(trimmed);
  if (normalizedMedia) return normalizedMedia;

  const normalizedPlaylist = toPlaylistCommandUri(trimmed);
  if (normalizedPlaylist) return normalizedPlaylist;

  if (fallback) {
    const normalizedFallback = normalizeMediaUri(fallback);
    if (normalizedFallback) return normalizedFallback;
  }

  return trimmed;
}

registerZoneContentAdapter({
  key: 'musicassistant',
  label: 'Music Assistant',
  defaultBackends: ['BackendMusicAssistant'],
  requires: { maPlayerId: true },
  providers: ['MusicAssistantProvider'],
  factory: (options) => {
    const { zoneConfig, zoneId } = options;
    const maPlayerId = zoneConfig.maPlayerId;
    const host = (process.env.MEDIA_PROVIDER_IP ?? '').trim();
    const rawPort = (process.env.MEDIA_PROVIDER_PORT ?? '').trim();
    const port = Number.isFinite(Number(rawPort)) && Number(rawPort) > 0 ? Number(rawPort) : 8095;

    if (!maPlayerId || !host) {
      logger.warn(
        `[MusicAssistant][ContentAdapter][Zone ${zoneId}] Missing configuration. maPlayerId=${maPlayerId ?? 'n/a'}, host=${host || 'n/a'}`,
      );
      return undefined;
    }

    return new MusicAssistantContentAdapter(options, maPlayerId, host, port);
  },
});
