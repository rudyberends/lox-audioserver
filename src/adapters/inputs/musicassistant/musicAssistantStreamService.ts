import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { ZoneConfig } from '@/domain/config/types';
import type { PlaybackSource, PlaybackMetadata } from '@/application/playback/audioManager';
import type { QueueItem } from '@/ports/types/queueTypes';
import { MusicAssistantApi } from '@/shared/musicassistant/musicAssistantApi';
import { decodeAudiopath } from '@/domain/zones/audiopath';
import { PassThrough } from 'node:stream';
import { generateQueueId } from '@/shared/utils/queueId';
import { SendspinClient, type StreamFormat } from './sendspinClient';
import {
  extractCover as extractCoverHelper,
  parseMaMediaRef,
  toLoxoneAudiopath as toLoxoneAudiopathHelper,
} from './maStreamMediaHelpers';
import { resolveActiveMaPlayerId } from '@/shared/musicassistant/maPlayerResolver';

type StreamEntry = {
  // The sendspin client_id we register the WebSocket player under (e.g. `lox-audio-player-2`).
  playerId: string;
  // The player_id Music Assistant actually exposes for this player via its API. MA's
  // universal_player provider can re-id our sendspin player (e.g. `uploxaudioplayer2`,
  // keeping `lox-audio-player-2` only as the display name), so every player_queues/* and
  // players/cmd/* RPC must target this id, not `playerId`. Resolved lazily from players/all.
  maPlayerId?: string;
};

type MusicAssistantPlaybackResult = {
  playbackSource: PlaybackSource | null;
  outputOnly?: boolean;
};

export type MusicAssistantPlayer = {
  player_id?: string;
  id?: string;
  name?: string;
};

type OutputHandlers = {
  onQueueUpdate: (zoneId: number, items: QueueItem[], currentIndex: number) => void;
  onOutputError: (zoneId: number, reason?: string) => void;
};

function toPlayerId(zoneName: string, fallbackId: number): string {
  const normalized = zoneName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `lox-${normalized || fallbackId}`;
}

// MA ends the stream both to pause/stop and on a track change. On a track change a
// new stream/start follows almost immediately, so wait this long before treating a
// stream end as a real stop. Long enough to bridge a gapless transition, short enough
// that a pause feels immediate.
const MA_STREAM_STOP_DEBOUNCE_MS = 1000;

// Collapse a player id to its alphanumeric slug for matching across MA's id transforms.
// `lox-audio-player-2` -> `loxaudioplayer2`; MA's universal_player wraps it as
// `up` + slug -> `uploxaudioplayer2`.
function playerIdSlug(value: string): string {
  return (value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Find the real MA player_id for our sendspin client among the players reported by
// players/all. Matches on the alphanumeric slug (identical, or `up`-prefixed by the
// universal_player provider, or a suffix), then falls back to the display name.
function matchMaPlayerId(players: MusicAssistantPlayer[], sendspinClientId: string): string | null {
  const want = playerIdSlug(sendspinClientId);
  if (!want) {
    return null;
  }
  for (const p of players ?? []) {
    const id = String(p?.player_id ?? p?.id ?? '');
    if (!id) {
      continue;
    }
    const slug = playerIdSlug(id);
    if (slug === want || slug === `up${want}` || slug.endsWith(want)) {
      return id;
    }
  }
  const byName = (players ?? []).find((p) => (p?.name ?? '').trim() === sendspinClientId);
  return byName ? String(byName.player_id ?? byName.id ?? '') || null : null;
}

export class MusicAssistantStreamService {
  private readonly log = createLogger('Input', 'MAplayer');
  private host: string | null = null;
  private port = 8095;
  private apiKey?: string;
  private registerAll = true;
  private mode: 'source' | 'sink' = 'source';
  private api: MusicAssistantApi | null = null;
  private lastConnectionStatus:
    | { ok: boolean; checkedAt: number; message?: string; host?: string; port?: number }
    | null = null;
  private streams = new Map<number, StreamEntry>();
  private playerToZone = new Map<string, number>();
  private zonePlayers = new Map<number, string>();
  private subs = new Map<number, () => void>();
  private queueFetches = new Map<number, number>();
  private keepAliveTimers = new Map<number, NodeJS.Timeout>();
  private playingState = new Map<number, boolean>();
  private sendspinClients = new Map<number, SendspinClient>();
  private lastMetadata = new Map<number, PlaybackMetadata>();
  private lastMetadataKeys = new Map<number, string[]>();
  private lastStreamStartAt = new Map<number, number>();
  private lastVolume = new Map<number, number>();
  private lastPauseAt = new Map<number, number>();
  private switchAwayHandlers: {
    onSwitchAway?: (zoneId: number) => void;
  } = {};
  private lastPlayIntentAt = new Map<number, number>();
  /** Debounced stop-on-stream-end timers, cancelled when a new stream/start arrives. */
  private pendingStreamStopTimers = new Map<number, NodeJS.Timeout>();
  // Tracks in-flight serviceplay requests so sendspin doesn't double-start playback.
  private pendingStreamRequests = new Map<number, number>();
  private streamRequestSeq = 0;
  private providerId = 'spotify@musicassistant';
  private inputHandlers: {
    startPlayback?: (zoneId: number, label: string, source: PlaybackSource, metadata?: PlaybackMetadata) => void;
    stopPlayback?: (zoneId: number) => void;
    updateVolume?: (zoneId: number, volume: number) => void;
    updateMetadata?: (zoneId: number, metadata: Partial<PlaybackMetadata>) => void;
    updateTiming?: (zoneId: number, elapsed: number, duration: number) => void;
  } | null = null;
  private readonly configPort: ConfigPort;

  constructor(private readonly outputHandlers: OutputHandlers, configPort: ConfigPort) {
    this.configPort = configPort;
  }

  private get config(): ConfigPort {
    return this.configPort;
  }

  public setInputHandlers(handlers: typeof this.inputHandlers): void {
    this.inputHandlers = handlers;
  }

  public setSwitchAwayHandlers(handlers: typeof this.switchAwayHandlers): void {
    this.switchAwayHandlers = handlers;
  }

  public async switchAway(zoneId: number): Promise<void> {
    const api = this.getApi();
    if (!api) {
      return;
    }
    const localPlayerId =
      this.zonePlayers.get(zoneId) ??
      this.streams.get(zoneId)?.playerId ??
      Array.from(this.playerToZone.entries()).find(([, zid]) => zid === zoneId)?.[0] ??
      '';
    if (!localPlayerId) {
      return;
    }
    // Use MA's real player id for queue/command RPCs (see resolveMaPlayerId).
    const playerId = (await this.resolveMaPlayerId(zoneId)) || localPlayerId;
    try {
      this.log.info('music assistant switch away: stopping and clearing queue', { zoneId, playerId });
      await api.playerCommand(playerId, 'stop');
      try {
        await api.clearQueue(playerId);
      } catch (err) {
        this.log.debug('music assistant clear queue failed (ignored)', {
          zoneId,
          playerId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('music assistant switch away failed', { zoneId, playerId, message });
    }
  }

  public getProviderId(): string {
    return this.providerId;
  }

  public getLastConnectionStatus():
    | { ok: boolean; checkedAt: number; message?: string; host?: string; port?: number }
    | null {
    return this.lastConnectionStatus;
  }

  public async testConnection(): Promise<{
    ok: boolean;
    checkedAt: number;
    message?: string;
    host?: string;
    port?: number;
  }> {
    const checkedAt = Date.now();
    if (!this.host) {
      const status = {
        ok: false,
        checkedAt,
        message: 'music assistant bridge not configured',
      };
      this.lastConnectionStatus = status;
      return status;
    }
    const api = this.getApi();
    if (!api) {
      const status = {
        ok: false,
        checkedAt,
        message: 'music assistant bridge not configured',
        host: this.host ?? undefined,
        port: this.port,
      };
      this.lastConnectionStatus = status;
      return status;
    }
    try {
      await api.connect();
      const status = { ok: true, checkedAt, host: this.host ?? undefined, port: this.port };
      this.lastConnectionStatus = status;
      return status;
    } catch (err) {
      const status = {
        ok: false,
        checkedAt,
        message: err instanceof Error ? err.message : String(err),
        host: this.host ?? undefined,
        port: this.port,
      };
      this.lastConnectionStatus = status;
      return status;
    }
  }

  public configureFromConfig(): void {
    // Clean up previous config if host changes.
    if (this.api) {
      this.api.release();
      this.api = null;
    }
    // Close sendspin clients when host changes/disabled.
    for (const client of this.sendspinClients.values()) {
      client.close();
    }
    this.sendspinClients.clear();
    this.playerToZone.clear();
    this.lastStreamStartAt.clear();
    this.pendingStreamRequests.clear();
    try {
      const cfg = this.config.getConfig();
      const bridge = (cfg.content?.streamingServices ?? []).find(
        (b) => b?.provider?.toLowerCase() === 'musicassistant' || b?.id?.toLowerCase() === 'musicassistant',
      );
      if (!bridge || bridge.enabled === false) {
        this.host = null;
        this.streams.clear();
        return;
      }
      this.providerId = bridge.id && bridge.id.trim() ? `spotify@${bridge.id.trim()}` : 'spotify@musicassistant';
      this.host = (bridge.host || '').trim() || '127.0.0.1';
      this.port = typeof bridge.port === 'number' && bridge.port > 0 ? bridge.port : 8095;
      this.apiKey = typeof bridge.apiKey === 'string' && bridge.apiKey.trim() ? bridge.apiKey.trim() : undefined;
      this.registerAll = bridge.registerAll !== false;
      this.mode = bridge.mode === 'sink' ? 'sink' : 'source';
      this.api = MusicAssistantApi.acquire(this.host, this.port, this.apiKey);
    } catch {
      this.host = null;
    }
  }

  public async registerZones(zones: ZoneConfig[]): Promise<void> {
    if (this.mode === 'sink') {
      return;
    }
    if (!this.registerAll) {
      return;
    }
    if (!this.host) {
      return;
    }
    await Promise.all(
      zones
        .filter(
          (zone) =>
            zone.inputs?.musicassistant?.enabled !== false &&
            zone.inputs?.musicassistant?.offload !== true,
        )
        .map(async (zone) => {
          try {
            await this.registerZone(zone.id, zone.name, zone);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.log.warn('failed to register MA builtin player for zone', { zoneId: zone.id, message });
          }
        }),
    );
  }

  private resolveZoneConfig(zoneId: number): ZoneConfig | undefined {
    try {
      const cfg = this.config.getConfig();
      return (cfg.zones ?? []).find((zone) => zone.id === zoneId) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private resolveZoneName(zoneId: number): string {
    return this.resolveZoneConfig(zoneId)?.name || `zone-${zoneId}`;
  }

  public async listPlayers(): Promise<MusicAssistantPlayer[]> {
    const api = this.getApi();
    if (!api || !this.host) {
      return [];
    }
    try {
      const players = await api.getAllPlayers();
      return Array.isArray(players) ? players : [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('music assistant list players failed', { message });
      return [];
    }
  }

  public async registerZone(zoneId: number, zoneName: string, zoneConfig?: ZoneConfig): Promise<StreamEntry | null> {
    if (!this.host) {
      return null;
    }
    if (this.mode === 'sink') {
      // In sink mode the bridge is not a per-zone source: MA players are external sinks
      // referenced by zone outputs, so we do not register a sendspin player or stream entry here.
      return null;
    }
    const effectiveConfig = zoneConfig ?? this.resolveZoneConfig(zoneId);
    if (effectiveConfig?.inputs?.musicassistant?.enabled === false) {
      return null;
    }
    if (effectiveConfig?.inputs?.musicassistant?.offload) {
      return null;
    }
    const playerId = this.streams.get(zoneId)?.playerId ?? toPlayerId(zoneName, zoneId);
    const existingEntry = this.streams.get(zoneId);

    // Try sendspin registration (mirrors MA web player). We might need to recreate the client after a config reload
    // even if a stream entry already exists.
    if (this.apiKey && !this.sendspinClients.has(zoneId)) {
      const sendspinClient = new SendspinClient(
        this.host,
        this.port,
        this.apiKey,
        playerId,
        zoneId,
        this.providerId,
        this.log,
        {
          start: (zId, pId, stream, fmt) => this.handleInputStreamStart(zId, pId, stream, fmt),
          stop: (zId, pId) => this.handleInputStreamStop(zId, pId),
          metadata: (zId, pId, meta) => this.handleInputMetadata(zId, pId, meta),
          command: (zId, pId, payload) => this.handleInputCommand(zId, pId, payload),
        },
      );
      this.sendspinClients.set(zoneId, sendspinClient);
      this.playerToZone.set(playerId, zoneId);
      try {
        const ok = await sendspinClient.connect();
        if (ok) {
          this.log.info('sendspin player registered', { zoneId, playerId });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn('sendspin registration failed', { zoneId, message });
      }
    }

    // Ensure the stream entry exists before resolving so the resolved MA id can be cached on it.
    const entry: StreamEntry = existingEntry ?? { playerId };
    this.streams.set(zoneId, entry);

    const api = this.getApi();
    // We no longer rely on builtin_player/register; still set up subscription to catch PLAY_MEDIA events.
    try {
      await api?.connect();
      if (api) {
        // Re-resolve on every (re)registration: the universal_player wrapping may have changed.
        entry.maPlayerId = undefined;
        const maPlayerId = await this.resolveMaPlayerId(zoneId);
        // Subscribe under MA's real player id so we receive events for this player.
        this.ensureSubscription(zoneId, maPlayerId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('music assistant subscription setup failed', { zoneId, message });
    }

    this.startKeepAlive(zoneId, playerId);
    return entry;
  }

  /**
   * Resolve the player_id Music Assistant actually exposes for our sendspin client and
   * cache it on the zone's StreamEntry. MA's universal_player provider can re-id the player
   * (e.g. `lox-audio-player-2` -> `uploxaudioplayer2`), so all player_queues/* and players/cmd/*
   * RPCs must use this id. Falls back to the sendspin client_id when nothing matches.
   */
  private async resolveMaPlayerId(zoneId: number): Promise<string> {
    const entry = this.streams.get(zoneId);
    const fallback = entry?.playerId ?? this.zonePlayers.get(zoneId) ?? '';
    if (entry?.maPlayerId) {
      return entry.maPlayerId;
    }
    const api = this.getApi();
    if (!api || !fallback) {
      return fallback;
    }
    try {
      const players = (await api.getAllPlayers()) ?? [];
      const matched = matchMaPlayerId(players, fallback);
      if (matched) {
        if (entry) {
          entry.maPlayerId = matched;
        }
        if (matched !== fallback) {
          this.log.info('music assistant player id resolved', {
            zoneId,
            sendspinClientId: fallback,
            maPlayerId: matched,
          });
        }
        return matched;
      }
      this.log.debug('music assistant player id not found in players/all', { zoneId, sendspinClientId: fallback });
    } catch (err) {
      this.log.debug('music assistant player id resolve failed', {
        zoneId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return fallback;
  }

  public getPlaybackSource(zoneId: number): PlaybackSource | null {
    if (!this.host) {
      return null;
    }
    if (this.mode === 'sink') {
      return null;
    }
    const zoneConfig = this.resolveZoneConfig(zoneId);
    if (zoneConfig?.inputs?.musicassistant?.enabled === false) {
      return null;
    }
    if (zoneConfig?.inputs?.musicassistant?.offload) {
      return null;
    }
    const entry = this.streams.get(zoneId);
    const sendspin = this.sendspinClients.get(zoneId);
    const active = sendspin?.getActiveStream() ?? null;
    if (!active) {
      return null;
    }
    const fmt = active.format;
    return {
      kind: 'pipe',
      path: `sendspin:${entry?.playerId ?? 'ma'}`,
      format: fmt.bitDepth && fmt.bitDepth > 16 ? 's32le' : 's16le',
      sampleRate: fmt.sampleRate || 48000,
      channels: fmt.channels || 2,
      stream: active.stream,
    };
  }

  /**
   * Request playback for a Music Assistant audiopath.
   * This registers the built-in player if needed, asks MA to play the media
   * on that player, waits for the PLAY_MEDIA event to provide the real stream
   * URL and returns it as a PlaybackSource.
   */
  public async startStreamForAudiopath(
    zoneId: number,
    zoneName: string,
    audiopath: string,
    options?: {
      flow?: boolean;
      parentAudiopath?: string;
      startItem?: string;
      startIndex?: number;
      metadata?: PlaybackMetadata;
      zoneConfig?: ZoneConfig;
    },
  ): Promise<MusicAssistantPlaybackResult> {
    const zoneConfig = options?.zoneConfig ?? this.resolveZoneConfig(zoneId);
    if (zoneConfig?.inputs?.musicassistant?.enabled === false) {
      return { playbackSource: null };
    }
    const maConfig = zoneConfig?.inputs?.musicassistant;
    const api = this.getApi();
    if (!api) {
      this.reportPlaybackError(zoneId, 'music assistant unavailable');
      return { playbackSource: null };
    }

    // Sink mode: the zone's audio is owned by an external MA player. Translate
    // any MA-bridge content selection into an RPC and return outputOnly:true
    // so the local audio engine doesn't try to stream.
    if (this.mode === 'sink') {
      return this.handleSinkPlay(api, zoneId, zoneConfig, audiopath, options);
    }

    // Offload: play directly on a user-selected MA player/device without streaming.
    if (maConfig?.offload) {
      const targetId = (maConfig.deviceId ?? '').trim();
      if (!targetId) {
        this.log.warn('music assistant offload enabled but deviceId missing', { zoneId });
        this.reportPlaybackError(zoneId, 'music assistant device id missing');
        return { playbackSource: null };
      }

      const mediaId = this.decodeMediaId(audiopath);
      if (!mediaId) {
        this.log.warn('music assistant media id not resolved for offload', { zoneId, audiopath });
        this.reportPlaybackError(zoneId, 'music assistant media id unresolved');
        return { playbackSource: null };
      }
      const parentMediaId = options?.parentAudiopath ? this.decodeMediaId(options.parentAudiopath) : null;
      const playTarget = parentMediaId || mediaId;
      const playOpts: Record<string, unknown> = { option: 'replace', radio_mode: false };
      if (parentMediaId && mediaId) {
        playOpts.start_item = options?.startItem ? this.decodeMediaId(options.startItem) ?? mediaId : mediaId;
      }
      if (typeof options?.startIndex === 'number' && options.startIndex >= 0) {
        playOpts.start_index = options.startIndex;
      }

      try {
        this.log.info('music assistant offload play', { zoneId, playerId: targetId, media: playTarget });
        await api.connect();
        const ok = await api.playMedia(targetId, playTarget, playOpts);
        if (!ok) {
          this.log.warn('music assistant play_media failed', { zoneId, playerId: targetId });
          this.reportPlaybackError(zoneId, 'music assistant play failed');
          return { playbackSource: null };
        }
        this.zonePlayers.set(zoneId, targetId);
        this.playerToZone.set(targetId, zoneId);
        this.ensureSubscription(zoneId, targetId);
        if (options?.metadata) {
          this.lastMetadata.set(zoneId, options.metadata);
          this.lastMetadataKeys.set(zoneId, Object.keys(options.metadata));
        }
        void this.enrichMetadataFromApi(zoneId, mediaId);
        this.playingState.set(zoneId, true);
        return { playbackSource: null, outputOnly: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn('music assistant offload play failed', { zoneId, message });
        this.reportPlaybackError(zoneId, 'music assistant unavailable');
        return { playbackSource: null };
      }
    }

    const entry =
      (this.streams.get(zoneId) as StreamEntry | undefined) ??
      (await this.registerZone(zoneId, zoneName, zoneConfig));
    if (!entry) {
      this.reportPlaybackError(zoneId, 'music assistant unavailable');
      return { playbackSource: null };
    }
    this.zonePlayers.set(zoneId, entry.playerId);

    if (options?.metadata) {
      this.lastMetadata.set(zoneId, options.metadata);
      this.lastMetadataKeys.set(zoneId, Object.keys(options.metadata));
    }

    // Mark intent to play so we don't treat early stream/end from previous track as a real stop
    this.playingState.set(zoneId, true);
    this.lastPlayIntentAt.set(zoneId, Date.now());

    const mediaId = this.decodeMediaId(audiopath);
    if (!mediaId) {
      this.log.warn('music assistant media id not resolved', { zoneId, audiopath });
      this.reportPlaybackError(zoneId, 'music assistant media id unresolved');
      return { playbackSource: null };
    }
    const parentMediaId = options?.parentAudiopath ? this.decodeMediaId(options.parentAudiopath) : null;
    const playTarget = parentMediaId || mediaId;
    const playOpts: Record<string, unknown> = { option: 'replace', radio_mode: false };
    if (parentMediaId && mediaId) {
      playOpts.start_item = options?.startItem ? this.decodeMediaId(options.startItem) ?? mediaId : mediaId;
    }
    if (typeof options?.startIndex === 'number' && options.startIndex >= 0) {
      playOpts.start_index = options.startIndex;
    }
    // Kick off metadata enrichment immediately using the decoded media id.
    void this.enrichMetadataFromApi(zoneId, mediaId);

    const sendspin = this.sendspinClients.get(zoneId);
    const activeSendspin = sendspin?.getActiveStream() ?? null;
    const requestToken = this.markPendingStreamRequest(zoneId);
    const playMedia = async () => {
      try {
        await api.connect();
        const queueId = await this.resolveMaPlayerId(zoneId);
        this.log.info('music assistant play_media', {
          zoneId,
          playerId: entry.playerId,
          queueId,
          audiopath: mediaId,
          parent: parentMediaId || null,
          startIndex: options?.startIndex ?? null,
        });
        await api.playMedia(queueId, playTarget, playOpts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn('music assistant play_media failed', { zoneId, message });
        this.reportPlaybackError(zoneId, 'music assistant unavailable');
      }
    };

    if (activeSendspin) {
      void playMedia().finally(() => this.clearPendingStreamRequest(zoneId, requestToken));
      const fmt = activeSendspin.format;
      this.playingState.set(zoneId, true);
      this.startKeepAlive(zoneId, entry.playerId);
      return {
        playbackSource: {
          kind: 'pipe',
          path: `sendspin:${entry.playerId}`,
          format: fmt.bitDepth && fmt.bitDepth > 16 ? 's32le' : 's16le',
          sampleRate: fmt.sampleRate || 48000,
          channels: fmt.channels || 2,
          stream: activeSendspin.stream,
        },
      };
    }

    try {
      if (sendspin && !sendspin.isReady()) {
        try {
          await sendspin.connect();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log.warn('sendspin reconnect before play_media failed', { zoneId, message });
        }
      }
      await playMedia();
      const sendspinStream = sendspin ? await this.waitForSendspinStream(zoneId, sendspin) : null;
      if (sendspinStream) {
        const fmt = sendspinStream.format;
        this.playingState.set(zoneId, true);
        this.log.info('sendspin stream attached', {
          zoneId,
          playerId: entry.playerId,
          codec: fmt.codec,
          sampleRate: fmt.sampleRate,
          channels: fmt.channels,
          bitDepth: fmt.bitDepth,
        });
        return {
          playbackSource: {
            kind: 'pipe',
            path: `sendspin:${entry.playerId}`,
            format: fmt.bitDepth && fmt.bitDepth > 16 ? 's32le' : 's16le',
            sampleRate: fmt.sampleRate || 48000,
            channels: fmt.channels || 2,
            stream: sendspinStream.stream,
          },
        };
      }

      this.log.warn('music assistant sendspin stream not resolved', {
        zoneId,
        playerId: entry.playerId,
        audiopath: mediaId,
        parent: parentMediaId || null,
        startIndex: options?.startIndex ?? null,
      });
      this.reportPlaybackError(zoneId, 'music assistant stream unavailable');
      return { playbackSource: null };
    } finally {
      this.clearPendingStreamRequest(zoneId, requestToken);
    }
  }

  /**
   * Sink-mode play handler: translate the requested audiopath into either a
   * `play_index` (when the track is already in the MA player's queue) or a
   * `play_media` RPC, and return outputOnly so the local audio engine won't
   * try to stream.
   */
  private async handleSinkPlay(
    api: MusicAssistantApi,
    zoneId: number,
    zoneConfig: ZoneConfig | undefined,
    audiopath: string,
    options?: {
      parentAudiopath?: string;
      startItem?: string;
      startIndex?: number;
    },
  ): Promise<MusicAssistantPlaybackResult> {
    const savedPlayerId = this.resolveSinkPlayerId(zoneConfig);
    if (!savedPlayerId) {
      this.log.warn('MA sink play skipped; zone has no MA-player output', { zoneId });
      this.reportPlaybackError(zoneId, 'music assistant player not configured');
      return { playbackSource: null };
    }
    // MA registers queues against the player that owns playback (typically the
    // universal-wrapper `up…` id). Map our saved id to the active one.
    const sinkPlayerId = await resolveActiveMaPlayerId(api, savedPlayerId);
    if (!sinkPlayerId) {
      this.log.warn('MA sink play: cannot resolve active MA player', { zoneId, savedPlayerId });
      this.reportPlaybackError(zoneId, 'music assistant player unavailable');
      return { playbackSource: null };
    }
    const mediaId = this.decodeMediaId(audiopath);
    if (!mediaId) {
      this.log.warn('MA sink play: media id not resolved', { zoneId, audiopath });
      this.reportPlaybackError(zoneId, 'music assistant media id unresolved');
      return { playbackSource: null };
    }
    const parentMediaId = options?.parentAudiopath ? this.decodeMediaId(options.parentAudiopath) : null;
    try {
      await api.connect();
      // Track-select from a mirrored queue: prefer play_index so we don't
      // replace the queue with a single item.
      if (!parentMediaId) {
        const queueItemId = await this.findQueueItemId(api, sinkPlayerId, mediaId);
        if (queueItemId) {
          this.log.info('MA sink play_index', { zoneId, playerId: sinkPlayerId, queueItemId });
          const ok = await api.playQueueIndex(sinkPlayerId, queueItemId);
          if (ok) return { playbackSource: null, outputOnly: true };
          this.log.warn('MA sink play_index failed; falling back to play_media', { zoneId });
        }
      }
      const playTarget = parentMediaId || mediaId;
      const playOpts: Record<string, unknown> = { option: 'replace', radio_mode: false };
      if (parentMediaId && mediaId) {
        playOpts.start_item = options?.startItem
          ? this.decodeMediaId(options.startItem) ?? mediaId
          : mediaId;
      }
      if (typeof options?.startIndex === 'number' && options.startIndex >= 0) {
        playOpts.start_index = options.startIndex;
      }
      this.log.info('MA sink play_media', {
        zoneId,
        playerId: sinkPlayerId,
        media: playTarget,
        parent: parentMediaId || null,
        startIndex: options?.startIndex ?? null,
      });
      const ok = await api.playMedia(sinkPlayerId, playTarget, playOpts);
      if (!ok) {
        this.reportPlaybackError(zoneId, 'music assistant play failed');
        return { playbackSource: null };
      }
      return { playbackSource: null, outputOnly: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('MA sink play failed', { zoneId, message });
      this.reportPlaybackError(zoneId, 'music assistant unavailable');
      return { playbackSource: null };
    }
  }

  /** Look up an existing queue_item_id matching `mediaId` in the MA player's queue. */
  private async findQueueItemId(
    api: MusicAssistantApi,
    playerId: string,
    mediaId: string,
  ): Promise<string | null> {
    try {
      const items = await api.getQueueItems(playerId, 0, 500);
      if (!Array.isArray(items)) return null;
      const match = items.find((it: any) => {
        const uri = typeof it?.uri === 'string' ? it.uri : '';
        const mediaUri = typeof it?.media_item?.uri === 'string' ? it.media_item.uri : '';
        return uri === mediaId || mediaUri === mediaId;
      });
      const qid = match && typeof (match as any).queue_item_id === 'string'
        ? ((match as any).queue_item_id as string)
        : null;
      if (!qid) {
        this.log.debug('MA sink play_index: no queue match for mediaId', {
          playerId,
          mediaId,
          queueSize: items.length,
        });
      }
      return qid;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.debug('MA sink play_index lookup failed', { playerId, message });
      return null;
    }
  }

  private getApi(): MusicAssistantApi | null {
    if (!this.host) {
      return null;
    }
    if (!this.api) {
      this.api = MusicAssistantApi.acquire(this.host, this.port, this.apiKey);
    }
    return this.api;
  }

  private reportPlaybackError(zoneId: number, reason: string): void {
    const trimmed = reason.trim();
    if (!trimmed) {
      return;
    }
    this.outputHandlers.onOutputError(zoneId, trimmed);
  }

  private removeSubscription(zoneId: number): void {
    const unsub = this.subs.get(zoneId);
    if (unsub) {
      unsub();
      this.subs.delete(zoneId);
    }
    this.zonePlayers.delete(zoneId);
  }

  private ensureSubscription(zoneId: number, playerId: string): void {
    if (!this.api || this.subs.has(zoneId)) {
      return;
    }
    const unsubBuiltin = this.api.subscribe(
      'BUILTIN_PLAYER',
      (evt) => this.handleBuiltinEvent(zoneId, playerId, evt),
      playerId,
    );
    const unsubPlayer = this.api.subscribe(
      'PLAYER_UPDATED',
      (evt) => this.handlePlayerEvent(zoneId, playerId, evt),
      playerId,
    );
    const unsubQueue = this.api.subscribe(
      'QUEUE_UPDATED',
      (evt) => {
        void this.handleQueueEvent(zoneId, playerId, evt);
      },
      '*',
    );
    const unsubQueueAdded = this.api.subscribe(
      'QUEUE_ADDED',
      (evt) => {
        void this.handleQueueEvent(zoneId, playerId, evt);
      },
      '*',
    );
    const unsub = () => {
      unsubBuiltin();
      unsubPlayer();
      unsubQueue();
      unsubQueueAdded();
    };
    this.subs.set(zoneId, unsub);
  }

  private handleBuiltinEvent(zoneId: number, playerId: string, evt: Record<string, any>): void {
    const type = String(evt?.data?.type ?? '').toUpperCase();
    if (type === 'PLAY_MEDIA' || type === 'PLAY') {
      this.zonePlayers.set(zoneId, playerId);
      const metadata = this.extractMetadata(evt?.data);
      if (metadata) {
        this.lastMetadata.set(zoneId, metadata);
        this.lastMetadataKeys.set(zoneId, Object.keys(evt?.data || {}));
        this.log.info('music assistant metadata received', {
          zoneId,
          playerId,
          title: metadata.title || null,
          artist: metadata.artist || null,
          album: metadata.album || null,
          cover: metadata.coverurl || null,
          audiopath: metadata.audiopath || null,
          keys: Object.keys(evt?.data || {}),
        });
      } else {
        this.lastMetadataKeys.set(zoneId, Object.keys(evt?.data || {}));
        this.log.debug('music assistant metadata missing/empty', {
          zoneId,
          playerId,
          keys: Object.keys(evt?.data || {}),
        });
      }
      if (metadata && this.inputHandlers?.updateMetadata) {
        this.inputHandlers.updateMetadata(zoneId, metadata);
      }
      const evtData = evt?.data as { media_id?: string; uri?: string; url?: string } | undefined;
      const mediaId = evtData?.media_id || evtData?.uri || evtData?.url;
      if (mediaId) {
        void this.enrichMetadataFromApi(zoneId, mediaId);
      }
      this.playingState.set(zoneId, true);
      this.streams.set(zoneId, { playerId });
      this.startKeepAlive(zoneId, playerId);
      this.log.info('music assistant stream updated', { zoneId, playerId });
      return;
    }
    if (type === 'PAUSE') {
      this.playingState.set(zoneId, false);
      return;
    }
    if (type === 'STOP') {
      if (this.recentPlayIntent(zoneId, 5000)) {
        this.log.debug('music assistant STOP ignored; recent play intent', { zoneId, playerId });
        return;
      }
      this.playingState.set(zoneId, false);
      this.stopKeepAlive(zoneId);
      this.removeSubscription(zoneId);
      return;
    }
  }

  public async playerCommand(
    zoneId: number,
    command: string,
    args?: Record<string, unknown>,
  ): Promise<boolean> {
    const api = this.getApi();
    if (!api) {
      return false;
    }
    const localPlayerId =
      this.zonePlayers.get(zoneId) ??
      this.streams.get(zoneId)?.playerId ??
      Array.from(this.playerToZone.entries()).find(([, zid]) => zid === zoneId)?.[0] ??
      '';
    if (!localPlayerId) {
      return false;
    }
    if (command.toLowerCase() === 'pause') {
      this.markPaused(zoneId);
    }
    // Use MA's real player id for command RPCs (see resolveMaPlayerId).
    const playerId = (await this.resolveMaPlayerId(zoneId)) || localPlayerId;
    return api.playerCommand(playerId, command, args);
  }

  private handlePlayerEvent(zoneId: number, playerId: string, evt: Record<string, any>): void {
    const data = evt?.data ?? {};
    const current = data.current_media ?? data.media ?? data.item ?? null;
    const available = typeof data.available === 'boolean' ? data.available : undefined;
    if (available === false) {
      this.log.info('music assistant player unavailable; attempting re-register', { zoneId, playerId });
      void this.registerZone(zoneId, this.resolveZoneName(zoneId), this.resolveZoneConfig(zoneId));
    }
    if (typeof data.state === 'string') {
      const normalized = data.state.toLowerCase();
      if (normalized === 'playing') {
        this.playingState.set(zoneId, true);
      } else if (normalized === 'paused' || normalized === 'idle' || normalized === 'off') {
        this.playingState.set(zoneId, false);
      }
    }
    if (!current) {
      return;
    }
    const payload = {
      media: current,
      duration: current.duration ?? data.duration,
      type: current.media_type ?? data.media_type,
    };
    const metadata = this.extractMetadata(payload);
    if (!metadata) {
      return;
    }
    this.lastMetadata.set(zoneId, metadata);
    this.lastMetadataKeys.set(zoneId, Object.keys(data || {}));
    this.log.debug('music assistant player metadata received', {
      zoneId,
      playerId,
      title: metadata.title || null,
      artist: metadata.artist || null,
      album: metadata.album || null,
      cover: metadata.coverurl || null,
      audiopath: metadata.audiopath || null,
      keys: Object.keys(data || {}),
    });
    if (this.inputHandlers?.updateMetadata) {
      this.inputHandlers.updateMetadata(zoneId, metadata);
    }
    if (this.inputHandlers?.updateTiming) {
      const elapsedRaw = current.elapsed_time ?? data.elapsed_time ?? data.seconds_played;
      const durationRaw = current.duration ?? data.duration;
      const elapsed = typeof elapsedRaw === 'number' && elapsedRaw >= 0 ? elapsedRaw : 0;
      const duration = typeof durationRaw === 'number' && durationRaw > 0 ? durationRaw : 0;
      if (elapsed > 0 || duration > 0) {
        this.inputHandlers.updateTiming(zoneId, elapsed, duration);
      }
    }
  }

  private async handleQueueEvent(zoneId: number, playerId: string, evt: Record<string, any>): Promise<void> {
    if (!this.playingState.get(zoneId)) {
      return;
    }
    const data = evt?.data ?? {};
    const playerLower = String(playerId ?? '').toLowerCase();
    const queueIdRaw = String(evt?.object_id ?? data.queue_id ?? data.queue ?? '').trim();
    const queueLower = queueIdRaw.toLowerCase();
    const playerMatch = String(data.player_id ?? '').toLowerCase() === playerLower;
    if (queueLower && queueLower !== playerLower && !playerMatch) {
      return;
    }
    const queueId = queueIdRaw || playerId;
    if (!queueId) {
      return;
    }
    const lastFetchAt = this.queueFetches.get(zoneId) ?? 0;
    const now = Date.now();
    if (now - lastFetchAt < 1000) {
      return;
    }
    this.queueFetches.set(zoneId, now);
    const api = this.getApi();
    if (!api) {
      return;
    }

    const pageSize = 200;
    const totalHint = typeof data.items === 'number' ? data.items : Number.POSITIVE_INFINITY;
    const items: any[] = [];
    let offset = 0;
    while (offset < totalHint && items.length < 1000) {
      const page = await api.getQueueItems(queueId, offset, pageSize);
      if (!page.length) {
        break;
      }
      items.push(...page);
      offset += page.length;
      if (page.length < pageSize) {
        break;
      }
    }
    if (!items.length) {
      return;
    }

    const mapped = items
      .map((item, idx) => this.mapQueueItem(item, idx))
      .filter(Boolean) as QueueItem[];
    if (!mapped.length) {
      return;
    }

    const currentIndex = typeof data.current_index === 'number' ? data.current_index : 0;
    this.outputHandlers.onQueueUpdate(zoneId, mapped, currentIndex);
  }

  private mapQueueItem(item: any, idx: number): QueueItem | null {
    if (!item) {
      return null;
    }
    const media = item.media_item ?? item.media ?? item.item ?? null;
    const title = media?.name || item.name || '';
    const artist =
      media?.artist ||
      (Array.isArray(media?.artists) ? media.artists.map((a: { name?: string } | null) => a?.name || '').filter(Boolean).join(', ') : '') ||
      '';
    const album = media?.album?.name || media?.album || '';
    const cover = extractCoverHelper(media ?? item);
    const duration =
      typeof item.duration === 'number' && item.duration > 0
        ? Math.round(item.duration)
        : typeof media?.duration === 'number' && media.duration > 0
          ? Math.round(media.duration)
          : undefined;
    const rawUri =
      media?.uri ||
      media?.url ||
      item?.uri ||
      item?.streamdetails?.stream_metadata?.uri ||
      undefined;
    const typeHint =
      media?.media_type ||
      item?.media_type ||
      item?.streamdetails?.media_type ||
      'track';
    const audiopath = toLoxoneAudiopathHelper(rawUri, this.providerId, typeHint) || '';
    if (!title && !audiopath) {
      return null;
    }
    return {
      album: album || '',
      artist: artist || '',
      audiopath,
      audiotype: 5,
      coverurl: cover || '',
      duration: typeof duration === 'number' ? duration : 0,
      qindex: idx,
      station: '',
      title: title || '',
      unique_id: item.queue_item_id || item.item_id || generateQueueId(),
      user: this.providerId || 'musicassistant',
    };
  }

  private extractMetadata(data: any): PlaybackMetadata | null {
    if (!data) {
      return null;
    }
    const meta: PlaybackMetadata = {
      title: '',
      artist: '',
      album: '',
    };
    const src = data.metadata || data.media || data.item || data;
    meta.title =
      src?.title ||
      src?.name ||
      src?.media_title ||
      src?.track_name ||
      '';
    meta.artist =
      src?.artist ||
      src?.artists?.[0]?.name ||
      src?.album_artist ||
      '';
    meta.album = src?.album?.name || src?.album || '';
    const cover = extractCoverHelper(src);
    const duration =
      typeof src?.duration === 'number' && src.duration > 0
        ? Math.round(src.duration)
        : typeof data?.duration === 'number' && data.duration > 0
          ? Math.round(data.duration)
          : undefined;
    if (cover) {
      meta.coverurl = cover;
    }
    const rawAudiopath =
      typeof src?.media_id === 'string'
        ? src.media_id
        : typeof src?.uri === 'string'
          ? src.uri
          : undefined;
    const audiopath = toLoxoneAudiopathHelper(
      rawAudiopath, this.providerId, src?.type || data?.type || data?.media_type || 'track',
    );
    if (audiopath) {
      meta.audiopath = audiopath;
    }
    if (duration) {
      meta.duration = duration;
    }
    if (!meta.title && !meta.artist && !meta.album && !meta.coverurl && !meta.audiopath && !meta.duration) {
      return null;
    }
    return meta;
  }

  private decodeBase64Deep(value: string): string {
    let current = value;
    for (let i = 0; i < 4; i += 1) {
      const idx = current.indexOf('b64_');
      if (idx < 0) {
        break;
      }
      const encoded = current.slice(idx + 4);
      try {
        const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
        current = current.slice(0, idx) + decoded;
      } catch {
        break;
      }
    }
    return current;
  }


  /** Resolve the MA player_id from the zone's `musicassistant` output (sink mode). */
  private resolveSinkPlayerId(zoneConfig: ZoneConfig | undefined): string | null {
    if (!zoneConfig) return null;
    const candidates: Array<Record<string, unknown> | undefined> = [];
    if (zoneConfig.output && typeof zoneConfig.output === 'object') {
      candidates.push(zoneConfig.output as Record<string, unknown>);
    }
    if (Array.isArray(zoneConfig.transports)) {
      for (const t of zoneConfig.transports) {
        if (t && typeof t === 'object') candidates.push(t as Record<string, unknown>);
      }
    }
    for (const c of candidates) {
      if (!c) continue;
      const id = typeof c.id === 'string' ? c.id.toLowerCase() : '';
      if (id !== 'musicassistant') continue;
      const playerId = typeof c.playerId === 'string' ? c.playerId.trim() : '';
      if (playerId) return playerId;
    }
    return null;
  }

  private decodeMediaId(audiopath: string): string {
    const cleaned = decodeAudiopath(audiopath);
    const deepDecoded = this.decodeBase64Deep(cleaned);
    if (deepDecoded !== cleaned) {
      return deepDecoded;
    }
    const parts = cleaned.split(':');
    const last = parts[parts.length - 1] || '';
    if (last.startsWith('b64_')) {
      try {
        return Buffer.from(last.slice(4), 'base64').toString('utf-8');
      } catch {
        return cleaned;
      }
    }
    return cleaned;
  }

  private startKeepAlive(zoneId: number, playerId: string): void {
    const existing = this.keepAliveTimers.get(zoneId);
    if (existing) {
      clearInterval(existing);
    }
    // Sendspin: keep the WebSocket alive by reconnecting when needed.
    if (this.apiKey) {
      const client = this.sendspinClients.get(zoneId);
      if (!client) {
        return;
      }
      const tick = async () => {
        try {
          await client.connect();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log.debug('sendspin keepalive failed', { zoneId, message });
        }
      };
      const timer = setInterval(tick, 10000);
      this.keepAliveTimers.set(zoneId, timer);
      void tick();
      return;
    }
    if (!this.api) {
      return;
    }
    const tick = async () => {
      if (!this.api) {
        return;
      }
      const playing = this.playingState.get(zoneId) ?? true;
      try {
        await this.api.updateBuiltinPlayerState(playerId, { powered: true, playing, paused: !playing });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.debug('music assistant keepalive failed', { zoneId, message });
      }
    };
    const timer = setInterval(tick, 10000);
    this.keepAliveTimers.set(zoneId, timer);
  }

  private stopKeepAlive(zoneId: number): void {
    const timer = this.keepAliveTimers.get(zoneId);
    if (timer) {
      clearInterval(timer);
    }
    this.keepAliveTimers.delete(zoneId);
  }

  private markPendingStreamRequest(zoneId: number): number {
    const token = this.streamRequestSeq + 1;
    this.streamRequestSeq = token;
    this.pendingStreamRequests.set(zoneId, token);
    return token;
  }

  private clearPendingStreamRequest(zoneId: number, token: number): void {
    if (this.pendingStreamRequests.get(zoneId) === token) {
      this.pendingStreamRequests.delete(zoneId);
    }
  }

  private markPaused(zoneId: number): void {
    this.lastPauseAt.set(zoneId, Date.now());
  }


  private handleInputStreamStart(zoneId: number, playerId: string, stream: PassThrough, fmt: StreamFormat): void {
    if (!this.inputHandlers?.startPlayback) {
      return;
    }
    // A stream is (re)starting: this was a track change or a resume, not a pause.
    this.cancelPendingStreamStop(zoneId);
    this.lastStreamStartAt.set(zoneId, Date.now());
    const meta = this.lastMetadata.get(zoneId);
    const source: PlaybackSource = {
      kind: 'pipe',
      path: `sendspin:${playerId}`,
      format: fmt.bitDepth && fmt.bitDepth > 16 ? 's32le' : 's16le',
      sampleRate: fmt.sampleRate || 48000,
      channels: fmt.channels || 2,
      stream,
    };
    const encodedAudiopath = toLoxoneAudiopathHelper(meta?.audiopath ?? `musicassistant://${playerId}`, this.providerId);
    const metadata: PlaybackMetadata = {
      title: meta?.title ?? '',
      artist: meta?.artist ?? '',
      album: meta?.album ?? '',
      coverurl: meta?.coverurl ?? undefined,
      audiopath: encodedAudiopath,
      duration: meta?.duration,
      station: meta?.station,
      trackId: meta?.trackId,
    };
    if (!meta) {
      this.log.info('music assistant metadata missing; using fallback', {
        zoneId,
        playerId,
        keys: this.lastMetadataKeys.get(zoneId) ?? [],
      });
    }
    this.log.info('music assistant input stream start', {
      zoneId,
      playerId,
      sampleRate: source.sampleRate,
      channels: source.channels,
      title: metadata.title,
      artist: metadata.artist,
    });
    if (this.pendingStreamRequests.has(zoneId)) {
      this.log.debug('music assistant stream start suppressed; request in progress', {
        zoneId,
        playerId,
      });
      if (this.inputHandlers?.updateMetadata) {
        this.inputHandlers.updateMetadata(zoneId, metadata);
      }
      return;
    }
    this.inputHandlers.startPlayback(zoneId, 'musicassistant', source, metadata);
  }

  /**
   * MA has no player pause command: it pauses/stops by ending the stream. A track
   * change ends the stream too, but a fresh `stream/start` follows within
   * milliseconds — so debounce and only stop when nothing resumes.
   *
   * Deliberately does NOT gate on `playingState` / `recentPlayIntent`: MA never
   * reports a paused state to us, so `playingState` stays `true` forever and would
   * block every stop, and `recentPlayIntent` would swallow a pause pressed shortly
   * after play. The debounce is the reliable discriminator.
   */
  private handleInputStreamStop(zoneId: number, playerId: string): void {
    if (!this.inputHandlers?.stopPlayback) {
      return;
    }
    this.cancelPendingStreamStop(zoneId);
    const timer = setTimeout(() => {
      this.pendingStreamStopTimers.delete(zoneId);
      this.playingState.set(zoneId, false);
      this.log.info('music assistant input stream stop', { zoneId, playerId });
      this.inputHandlers?.stopPlayback?.(zoneId);
    }, MA_STREAM_STOP_DEBOUNCE_MS);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.pendingStreamStopTimers.set(zoneId, timer);
    this.log.debug('music assistant stream end; stop scheduled', {
      zoneId,
      playerId,
      delayMs: MA_STREAM_STOP_DEBOUNCE_MS,
    });
  }

  /** A new stream started (resume or next track) — abort a scheduled stop. */
  private cancelPendingStreamStop(zoneId: number): void {
    const pending = this.pendingStreamStopTimers.get(zoneId);
    if (pending) {
      clearTimeout(pending);
      this.pendingStreamStopTimers.delete(zoneId);
    }
  }

  private handleInputMetadata(zoneId: number, playerId: string, metadata: PlaybackMetadata): void {
    if (!metadata) {
      return;
    }
    const encodedAudiopath = toLoxoneAudiopathHelper(metadata.audiopath, this.providerId);
    const normalized: PlaybackMetadata = encodedAudiopath
      ? { ...metadata, audiopath: encodedAudiopath }
      : metadata;
    this.lastMetadata.set(zoneId, normalized);
    this.log.info('music assistant metadata (sendspin)', {
      zoneId,
      playerId,
      title: normalized.title || null,
      artist: normalized.artist || null,
      album: normalized.album || null,
      cover: normalized.coverurl || null,
      audiopath: normalized.audiopath || null,
    });
    if (this.inputHandlers?.updateMetadata) {
      this.inputHandlers.updateMetadata(zoneId, normalized);
    }
  }

  private handleInputCommand(
    zoneId: number,
    playerId: string,
    payload: { command?: string; volume?: number; mute?: boolean },
  ): void {
    const volume =
      typeof payload.volume === 'number' && Number.isFinite(payload.volume)
        ? Math.max(0, Math.min(100, Math.round(payload.volume)))
        : null;
    const muted = typeof payload.mute === 'boolean' ? payload.mute : null;
    const cmd = (payload.command || '').toString().toLowerCase();
    const deltaStep = 5;
    let effectiveVolume = volume;

    if (effectiveVolume === null && cmd) {
      const current = this.lastVolume.get(zoneId) ?? 100;
      if (cmd === 'volume_up' || cmd === 'vol_up' || cmd === 'volumeup') {
        effectiveVolume = Math.min(100, current + deltaStep);
      } else if (cmd === 'volume_down' || cmd === 'vol_down' || cmd === 'volumedown' || cmd === 'volume_decrease') {
        effectiveVolume = Math.max(0, current - deltaStep);
      }
    }
    if (volume !== null) {
      this.lastVolume.set(zoneId, volume);
      this.inputHandlers?.updateVolume?.(zoneId, volume);
    } else if (effectiveVolume !== null) {
      this.lastVolume.set(zoneId, effectiveVolume);
      this.inputHandlers?.updateVolume?.(zoneId, effectiveVolume);
    } else if (muted === true && this.lastVolume.has(zoneId)) {
      // Fallback: treat mute as volume 0 when explicit level is missing.
      this.inputHandlers?.updateVolume?.(zoneId, 0);
    }
    if (cmd === 'pause' || cmd === 'stop') {
      this.playingState.set(zoneId, false);
      if (cmd === 'pause') {
        this.markPaused(zoneId);
      }
    }
    if (cmd === 'play' || cmd === 'resume') {
      this.playingState.set(zoneId, true);
    }
    this.log.debug('music assistant command (sendspin)', {
      zoneId,
      playerId,
      command: cmd || null,
      volume: volume !== null ? volume : null,
      mute: muted,
    });
  }


  private toMetadataFromTrack(track: any): PlaybackMetadata | null {
    if (!track) {
      return null;
    }
    const title =
      track?.title ||
      track?.name ||
      track?.media_title ||
      track?.track_name ||
      '';
    const artist =
      track?.artist ||
      track?.artists?.[0]?.name ||
      track?.album_artist ||
      '';
    const album = track?.album?.name || track?.album || '';
    const cover = extractCoverHelper(track);
    const duration =
      typeof track?.duration === 'number' && track.duration > 0
        ? Math.round(track.duration)
        : undefined;
    const rawAudiopath =
      typeof track?.media_id === 'string'
        ? track.media_id
        : typeof track?.uri === 'string'
          ? track.uri
          : undefined;
    const audiopath = toLoxoneAudiopathHelper(rawAudiopath, this.providerId, track?.type || 'track');
    if (!title && !artist && !album && !cover && !audiopath && !duration) {
      return null;
    }
    const meta: PlaybackMetadata = {
      title: title || '',
      artist: artist || '',
      album: album || '',
    };
    if (cover) {
      meta.coverurl = cover;
    }
    if (audiopath) {
      meta.audiopath = audiopath;
    }
    if (duration) {
      meta.duration = duration;
    }
    return meta;
  }

  private async enrichMetadataFromApi(zoneId: number, mediaId: string): Promise<void> {
    const api = this.getApi();
    if (!api) {
      return;
    }
    const decoded = this.decodeMediaId(mediaId);
    const ref = parseMaMediaRef(decoded);
    if (ref.type !== 'track' || !ref.id) {
      return;
    }
    try {
      const track = await api.getTrack(ref.id, ref.provider || 'library');
      const meta = this.toMetadataFromTrack(track);
      if (meta) {
        this.lastMetadata.set(zoneId, meta);
        this.lastMetadataKeys.set(zoneId, Object.keys(track || {}));
        this.log.info('music assistant metadata (api)', {
          zoneId,
          mediaId: decoded,
          title: meta.title || null,
          artist: meta.artist || null,
          album: meta.album || null,
          cover: meta.coverurl || null,
          provider: ref.provider || 'library',
        });
        if (this.inputHandlers?.updateMetadata) {
          this.inputHandlers.updateMetadata(zoneId, meta);
        }
      } else {
        this.log.debug('music assistant metadata (api) empty', { zoneId, mediaId: decoded, provider: ref.provider || 'library' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.debug('music assistant metadata lookup failed', { zoneId, mediaId: decoded, provider: ref.provider || 'library', message });
    }
  }

  private async waitForSendspinStream(
    zoneId: number,
    client: SendspinClient,
    baseTimeoutMs = 8000,
  ): Promise<{ stream: PassThrough; format: StreamFormat } | null> {
    const maxWaitMs = this.playingState.get(zoneId) === true ? Math.max(15000, baseTimeoutMs) : baseTimeoutMs;
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const remaining = Math.max(1000, deadline - Date.now());
      const chunk = await client.awaitStream(Math.min(5000, remaining));
      if (chunk) {
        return chunk;
      }
      if (this.playingState.get(zoneId) !== true) {
        break;
      }
    }
    this.log.warn('sendspin stream await exceeded max wait', { zoneId, maxWaitMs, playing: this.playingState.get(zoneId) });
    return null;
  }

  private recentPlayIntent(zoneId: number, ms: number): boolean {
    const ts = this.lastPlayIntentAt.get(zoneId);
    return typeof ts === 'number' && Date.now() - ts < ms;
  }
}
