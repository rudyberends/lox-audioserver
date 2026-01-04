import { createLogger } from '@/core/logging/logger';
import {
  getConfig as getStoredConfig,
  loadConfig as loadStoredConfig,
  getSystemConfig,
} from '@/domain/config/configStore';
import type { ZoneConfig, InputConfig } from '@/domain/config/types';
import type { LoxoneZoneState } from '@/modules/zones/types/loxoneZoneState';
import { notifyQueueUpdated, notifyZoneStateChanged } from '@/modules/loxone/ws/notifier';
import { contentManager } from '@/modules/content/contentManager';
import { recentsManager } from '@/modules/zones/recents/recentsManager';
import {
  type PlaybackMetadata,
  type PlaybackSession,
  type PlaybackSource,
  type CoverArtPayload,
} from '@/modules/audio';
import type { ContentFolderItem } from '@/modules/content/types';
import { ZonePlayer } from '@/modules/audio/player/zonePlayer';
import { QueueController } from '@/modules/audio/player/queueController';
import { InputAdapter } from '@/modules/audio/player/inputAdapter';
import { SpotifyInputAdapter } from '@/modules/audio/player/spotifyInputAdapter';
import { registerPlayer, unregisterPlayer, clearPlayers } from '@/modules/audio/player/playerRegistry';
import { buildZoneTransports } from '@/modules/audio/outputs';
import type { ZoneTransport } from '@/modules/audio/outputs/types';
import { decodeAudiopath, encodeAudiopath, detectServiceFromAudiopath } from '@/modules/audio/utils/audiopath';
import { audioOutputSettings } from '@/modules/audio/utils/audioFormat';
import { airplayInputService } from '@/modules/audio/inputs/airplay/airplayInputService';
import { audioManager } from '@/modules/audio';
import { spotifyInputService } from '@/modules/audio/inputs/spotify/spotifyInputService';
import { musicAssistantInputService } from '@/modules/audio/inputs/musicassistant/musicAssistantInputService';
import { appleMusicInputService } from '@/modules/audio/inputs/applemusic/appleMusicInputService';
import { deezerInputService } from '@/modules/audio/inputs/deezer/deezerInputService';
import { tidalInputService } from '@/modules/audio/inputs/tidal/tidalInputService';
import {
  setQueueUpdateHandler,
  setTransportErrorHandler,
  setTransportStateHandler,
} from '@/modules/audio/outputs/queueUpdater';
import type { AlertMediaResource } from '@/modules/alerts/types';
import {
  createQueueItem,
  mapFolderItemsToQueue,
  parseSpotifyUser,
  normalizeSpotifyAudiopath,
  sanitizeStation,
} from '@/modules/zones/helpers/queueHelpers';
import {
  buildInitialState,
  clampVolumeForZone,
  getZoneDefaultVolume,
  cloneQueueState,
  fallbackTitle,
  sanitizeTitle,
  clamp,
} from '@/modules/zones/helpers/stateHelpers';
import {
  dispatchQueueStep,
  dispatchTransports,
  dispatchVolume,
  selectPlayOutputs,
} from '@/modules/zones/services/transportOrchestrator';

export interface QueueItem {
  album: string;
  artist: string;
  audiopath: string;
  audiotype: number;
  coverurl: string;
  duration: number;
  qindex: number;
  station: string;
  title: string;
  unique_id: string;
  user: string;
}

export type QueueAuthority =
  | 'local'
  | 'spotify'
  | 'musicassistant'
  | 'applemusic'
  | 'deezer'
  | 'tidal'
  | 'airplay'
  | `external:${string}`;

export interface QueueState {
  items: QueueItem[];
  shuffle: boolean;
  repeat: number;
  currentIndex: number;
  authority: QueueAuthority;
}

interface AlertSnapshot {
  mode: LoxoneZoneState['mode'];
  inputMode: ZoneContext['inputMode'];
  activeOutput: string | null;
  activeTransportTypes: Set<string>;
  volume: number;
  queue: QueueState;
  statePatch: Partial<LoxoneZoneState>;
}

interface ActiveAlertState {
  type: string;
  title: string;
  url: string;
  durationMs?: number;
  stopTimer?: NodeJS.Timeout;
  snapshot: AlertSnapshot;
}

const ALERT_AUDIO_TYPE = 9;
const ALERT_PRE_DELAY_MS = 10000;
const ALERT_PAD_TAIL_MS = 10000;
const MIN_ALERT_DURATION_MS = 20000;
const ALERT_STOP_MARGIN_MS = 750;
const MUSIC_ASSISTANT_PROVIDER_DEFAULT = 'spotify@musicassistant';
let musicAssistantProviderId = MUSIC_ASSISTANT_PROVIDER_DEFAULT;
const IGNORED_PLAYER_ERROR_REASONS = new Set([
  'alert_stop',
  'input_stop',
  'reconfigure',
  'shutdown',
  'command_stop',
  'queue_empty',
  'queue_end',
  'airplay_forced_stop',
  'airplay_stop',
]);
const PLAYBACK_ERROR_ALIASES: Record<string, string> = {
  uri: 'invalid or missing playback URI',
  auth: 'authentication required',
  device: 'playback device unavailable',
  error: 'transport error',
  queue_invalid_next: 'next queue item unavailable',
  queue_next_failed: 'failed to start next queue item',
  'airplay no source': 'AirPlay source missing',
  'airplay engine not ready': 'AirPlay engine not ready',
  'airplay pcm not ready': 'AirPlay not ready',
  'airplay pcm stream unavailable': 'AirPlay stream unavailable',
  'airplay stream not ready': 'AirPlay stream not ready',
};

function setMusicAssistantProviderId(providerId?: string): void {
  const normalized =
    typeof providerId === 'string' && providerId.trim()
      ? providerId.trim()
      : MUSIC_ASSISTANT_PROVIDER_DEFAULT;
  musicAssistantProviderId = normalized;
}

function getMusicAssistantProviderId(): string {
  return musicAssistantProviderId;
}

function getMusicAssistantUserId(): string {
  const provider = getMusicAssistantProviderId().trim();
  if (provider.toLowerCase().startsWith('spotify@')) {
    const user = provider.slice('spotify@'.length);
    return user || 'musicassistant';
  }
  return provider || 'musicassistant';
}

export interface ZoneContext {
  id: number;
  name: string;
  sourceMac: string;
  config: ZoneConfig;
  state: LoxoneZoneState;
  queue: QueueState;
  queueController: QueueController;
  inputAdapter: InputAdapter;
  spotifyAdapter: SpotifyInputAdapter;
  metadata: Record<string, unknown>;
  transports: ZoneTransport[];
  player: ZonePlayer;
  transportTimingActive: boolean;
  lastTransportTimingAt: number;
  /**
   * Throttle zone state broadcasts so Loxone clients aren't hammered.
   */
  lastZoneBroadcastAt: number;
  /**
   * Throttle player position updates to keep state/metadata churn reasonable.
   */
  lastPositionUpdateAt: number;
  lastPositionValue: number;
  activeTransportTypes: Set<string>;
  /**
   * Single-output slot for the zone; only this transport should receive play/pause/stop/metadata/volume.
   */
  activeOutput: string | null;
  activeInput: string | null;
  /**
   * Throttle metadata dispatch so transports do not get spammed with time-only updates.
   */
  lastMetadataDispatchAt: number;
  /**
   * Explicit input mode so commands/volume can be gated consistently.
   * queue: local queue/streams, spotify: Spotify Connect, airplay: AirPlay input,
   * musicassistant: MA stream proxy, applemusic: Apple Music stream proxy, deezer: Deezer stream proxy, tidal: Tidal stream proxy
   */
  inputMode: 'queue' | 'spotify' | 'airplay' | 'musicassistant' | 'applemusic' | 'deezer' | 'tidal' | 'alert' | null;
  alert?: ActiveAlertState;
}

class ZoneManager {
  private readonly log = createLogger('Zones', 'Manager');
  private readonly zones = new Map<number, ZoneContext>();
  private initialized = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly musicAssistantFlowMode = process.env.MUSICASSISTANT_FLOW_MODE !== 'false';
  private readonly musicAssistantInputHandlers = {
    startPlayback: (zoneId: number, label: string, source: PlaybackSource, metadata?: PlaybackMetadata) => {
      const ctx = this.zones.get(zoneId);
      if (!ctx || (ctx.activeInput && ctx.activeInput !== 'musicassistant')) {
        return;
      }
      this.playInputSource(zoneId, label, source, metadata);
    },
    stopPlayback: (zoneId: number) => {
      const ctx = this.zones.get(zoneId);
      if (!ctx || (ctx.activeInput && ctx.activeInput !== 'musicassistant')) {
        return;
      }
      this.stopInputSource(zoneId);
    },
    updateMetadata: (zoneId: number, metadata: Partial<PlaybackMetadata>) => {
      const ctx = this.zones.get(zoneId);
      if (!ctx || (ctx.activeInput && ctx.activeInput !== 'musicassistant')) {
        return;
      }
      this.updateInputMetadata(zoneId, metadata);
    },
    updateVolume: (zoneId: number, volume: number) => {
      const ctx = this.zones.get(zoneId);
      if (!ctx || (ctx.activeInput && ctx.activeInput !== 'musicassistant')) {
        return;
      }
      this.updateInputVolume(zoneId, volume);
    },
    updateTiming: (zoneId: number, elapsed: number, duration: number) => {
      const ctx = this.zones.get(zoneId);
      if (!ctx || (ctx.activeInput && ctx.activeInput !== 'musicassistant')) {
        return;
      }
      this.updateInputTiming(zoneId, elapsed, duration);
    },
  };

  /** Keep Music Assistant provider detection in sync with the configured bridge. */
  private refreshMusicAssistantProviderId(): void {
    try {
      const providerId = musicAssistantInputService.getProviderId();
      setMusicAssistantProviderId(providerId);
    } catch {
      setMusicAssistantProviderId(MUSIC_ASSISTANT_PROVIDER_DEFAULT);
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }
    const intervalMs = 60_000;
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const ctx of this.zones.values()) {
        if (!ctx.state) {
          continue;
        }
        ctx.lastZoneBroadcastAt = now;
        notifyZoneStateChanged(ctx.state);
      }
    }, intervalMs);
  }

  /** Minimal trace helper to see who drives volume changes. */
  private getVolumeOrigin(): string {
    const stack = new Error().stack;
    if (!stack) {
      return 'unknown';
    }
    // Keep the first few frames so we can pinpoint which caller drives a volume_set.
    const lines = stack
      .split('\n')
      .slice(1, 6)
      .map((l) => l.trim().replace(/^at\s+/, ''))
      .filter(Boolean);
    return lines.join(' | ') || 'unknown';
  }

  /** Read-only snapshot of the current zone state for external consumers (e.g. transports). */
  public getZoneState(zoneId: number): LoxoneZoneState | null {
    const ctx = this.zones.get(zoneId);
    return ctx ? ctx.state : null;
  }


  private stopSpotifyTransports(transports: ZoneTransport[]): void {
    transports
      .filter((t) => t.type === 'spotify')
      .forEach((t) => {
        try {
          t.stop?.(null);
        } catch {
          /* ignore */
        }
      });
  }

  private stopExternalInputSessions(
    zoneId: number,
    prevInput: ZoneContext['inputMode'],
    nextInput: ZoneContext['inputMode'],
  ): void {
    if (!prevInput || prevInput === nextInput) {
      return;
    }
    const reason = `switch_to_${nextInput ?? 'queue'}`;
    if (prevInput === 'airplay') {
      airplayInputService.stopActiveSession(zoneId, reason);
    }
    if (prevInput === 'spotify') {
      spotifyInputService.stopActiveSession(zoneId, reason);
    }
    if (prevInput === 'musicassistant') {
      void musicAssistantInputService.switchAway(zoneId);
    }
  }

  private isLocalQueueAuthority(authority: QueueAuthority | undefined | null): boolean {
    return !authority || authority === 'local';
  }

  private resolveQueueAuthorityFromItems(items: QueueItem[]): QueueAuthority | null {
    for (const item of items) {
      if (this.isMusicAssistantAudiopath(item.audiopath)) {
        return 'musicassistant';
      }
      if (this.isAppleMusicAudiopath(item.audiopath)) {
        return 'applemusic';
      }
      if (this.isDeezerAudiopath(item.audiopath)) {
        return 'deezer';
      }
      if (this.isTidalAudiopath(item.audiopath)) {
        return 'tidal';
      }
      if (this.isSpotifyAudiopath(item.audiopath)) {
        return 'spotify';
      }
      if ((item.audiopath || '').toLowerCase().startsWith('airplay://')) {
        return 'airplay';
      }
    }
    return null;
  }

  private transportsRequirePcm(transports: ZoneTransport[]): boolean {
    return transports.some((transport) => this.transportTypeRequiresPcm(transport.type));
  }

  private transportTypeRequiresPcm(type: string): boolean {
    return type === 'airplay' || type === 'sendspin' || type === 'sendspin-cast' || type === 'snapcast';
  }

  constructor() {
    airplayInputService.configure({
      startPlayback: (zoneId, label, source, metadata) => {
        this.playInputSource(zoneId, label, source, metadata);
      },
      updateMetadata: (zoneId, metadata) => {
        this.updateInputMetadata(zoneId, metadata);
      },
      updateCover: (zoneId, cover) => this.updateInputCover(zoneId, cover),
      updateVolume: (zoneId, volume) => this.updateInputVolume(zoneId, volume),
      updateTiming: (zoneId, elapsed, duration) => {
        this.updateInputTiming(zoneId, elapsed, duration);
      },
      pausePlayback: (zoneId) => this.pauseInputSource(zoneId),
      resumePlayback: (zoneId) => this.resumeInputSource(zoneId),
      stopPlayback: (zoneId) => {
        this.stopInputSource(zoneId);
      },
    });
    spotifyInputService.configure({
      startPlayback: (zoneId, label, source, metadata) => {
        const ctx = this.zones.get(zoneId);
        if (!ctx) {
          return;
        }
        // Ignore spotify input callbacks when another input is active (e.g. AirPlay).
        if (ctx.activeInput && ctx.activeInput !== 'spotify') {
          return;
        }
        ctx.spotifyAdapter.start(label, source, metadata);
      },
      updateMetadata: (zoneId, metadata) => {
        const ctx = this.zones.get(zoneId);
        if (!ctx || (ctx.activeInput && ctx.activeInput !== 'spotify')) {
          return;
        }
        ctx.spotifyAdapter.updateMetadata(metadata);
      },
      updateCover: (zoneId, cover) => {
        const ctx = this.zones.get(zoneId);
        if (!ctx || (ctx.activeInput && ctx.activeInput !== 'spotify')) {
          return;
        }
        return ctx.spotifyAdapter.updateCover(cover);
      },
      updateVolume: (zoneId, volume) => {
        const ctx = this.zones.get(zoneId);
        if (!ctx || (ctx.activeInput && ctx.activeInput !== 'spotify')) {
          return;
        }
        ctx.spotifyAdapter.updateVolume(volume);
      },
      updateTiming: (zoneId, elapsed, duration) => {
        const ctx = this.zones.get(zoneId);
        if (!ctx || (ctx.activeInput && ctx.activeInput !== 'spotify')) {
          return;
        }
        ctx.spotifyAdapter.updateTiming(elapsed, duration);
      },
      pausePlayback: (zoneId) => {
        const ctx = this.zones.get(zoneId);
        if (!ctx || (ctx.activeInput && ctx.activeInput !== 'spotify')) {
          return;
        }
        ctx.spotifyAdapter.pause();
      },
      resumePlayback: (zoneId) => {
        const ctx = this.zones.get(zoneId);
        if (!ctx || (ctx.activeInput && ctx.activeInput !== 'spotify')) {
          return;
        }
        ctx.spotifyAdapter.resume();
      },
      stopPlayback: (zoneId) => {
        const ctx = this.zones.get(zoneId);
        if (!ctx || (ctx.activeInput && ctx.activeInput !== 'spotify')) {
          return;
        }
        ctx.spotifyAdapter.stop();
      },
    });
    airplayInputService.setPlayerResolver((zoneId: number) => this.zones.get(zoneId)?.player ?? null);
    setQueueUpdateHandler((zoneId, items, currentIndex) => {
      this.updateQueueFromTransport(zoneId, items, currentIndex);
    });
    setTransportErrorHandler((zoneId, reason) => {
      this.handlePlaybackError(zoneId, reason, 'transport');
    });
    setTransportStateHandler((zoneId, state) => this.updateTransportState(zoneId, state));
  }

  private setInputMode(ctx: ZoneContext | undefined, mode: ZoneContext['inputMode']): void {
    if (!ctx) {
      return;
    }
    ctx.activeInput = mode;
    ctx.inputMode = mode;
  }

  private isQueueDriven(mode: ZoneContext['inputMode']): boolean {
    return (
      !mode ||
      mode === 'queue' ||
      mode === 'spotify' ||
      mode === 'musicassistant' ||
      mode === 'applemusic' ||
      mode === 'deezer' ||
      mode === 'tidal'
    );
  }

  private buildActiveItemPatch(ctx: ZoneContext): Partial<LoxoneZoneState> {
    if (ctx.alert) {
      return {
        title: ctx.alert.title,
        artist: '',
        album: '',
        coverurl: '',
        audiopath: ctx.alert.url,
        station: '',
        qindex: ctx.alert.snapshot.queue.currentIndex,
        qid: `alert-${ctx.id}`,
        audiotype: ALERT_AUDIO_TYPE,
        sourceName: ctx.name,
      };
    }
    const current = ctx.queueController.current();
    if (!current) {
      return {};
    }
    const audiotype = getInputAudioType(ctx);
    const stationForState = current.audiotype === 1 || current.audiotype === 4 ? current.station : '';
    const patch: Partial<LoxoneZoneState> = {
      title: current.title,
      artist: current.artist,
      album: current.album,
      coverurl: current.coverurl,
      audiopath: current.audiopath,
      station: stationForState,
      qindex: ctx.queueController.currentIndex(),
      qid: current.unique_id,
      duration: typeof current.duration === 'number' ? Math.max(0, Math.round(current.duration)) : 0,
      queueAuthority: ctx.queue.authority,
    };
    if (audiotype !== null) {
      patch.audiotype = audiotype;
      const sourceName = resolveSourceName(audiotype, ctx, current);
      if (sourceName) {
        patch.sourceName = sourceName;
      }
    }
    return patch;
  }

  public async initialize(): Promise<void> {
    if (!this.initialized) {
      await loadStoredConfig();
      const cfg = getStoredConfig();
      await this.replaceAll(cfg.zones, cfg.inputs);
      this.startHeartbeat();
      this.initialized = true;
    }
  }

  public async replaceAll(zoneConfigs: ZoneConfig[], inputs?: InputConfig | null): Promise<void> {
    this.disposeAllTransports();
    this.zones.clear();
    clearPlayers();
    zoneConfigs.forEach((cfg) => this.registerZone(cfg));
    airplayInputService.syncZones(zoneConfigs, inputs?.airplay ?? null);
    spotifyInputService.syncZones(zoneConfigs, inputs?.spotify ?? null);
    musicAssistantInputService.configure(this.musicAssistantInputHandlers);
    appleMusicInputService.configure();
    deezerInputService.configure();
    tidalInputService.configure();
    this.refreshMusicAssistantProviderId();
    await musicAssistantInputService.syncZones(zoneConfigs);
    this.log.info('zones registered', { count: this.zones.size });
    // Broadcast initial states so clients get defaults (including volume).
    for (const ctx of this.zones.values()) {
      ctx.state.volume = getZoneDefaultVolume(ctx.config);
      // Broadcast initial state using the same path as patches.
      this.patchState(ctx.id, ctx.state, true);
      // Push default volume to transports so they start at the configured level.
      this.dispatchVolume(ctx, ctx.transports, ctx.state.volume);
    }
  }

  public async replaceZones(zoneConfigs: ZoneConfig[], inputs?: InputConfig | null): Promise<void> {
    if (!zoneConfigs || zoneConfigs.length === 0) {
      return;
    }

    // Tear down existing contexts for the affected zones.
    for (const cfg of zoneConfigs) {
      await this.disposeZone(cfg.id);
    }

    // Register the new/updated zones.
    zoneConfigs.forEach((cfg) => this.registerZone(cfg));

    // Refresh input services using the full current set.
    const allZones = Array.from(this.zones.values()).map((ctx) => ctx.config);
    airplayInputService.syncZones(allZones, inputs?.airplay ?? null);
    spotifyInputService.syncZones(allZones, inputs?.spotify ?? null);
    musicAssistantInputService.configure(this.musicAssistantInputHandlers);
    appleMusicInputService.configure();
    deezerInputService.configure();
    tidalInputService.configure();
    this.refreshMusicAssistantProviderId();
    await musicAssistantInputService.syncZones(allZones);

    // Push initial state for the updated zones.
    for (const cfg of zoneConfigs) {
      const ctx = this.zones.get(cfg.id);
      if (!ctx) {
        continue;
      }
      ctx.state.volume = getZoneDefaultVolume(ctx.config);
      this.patchState(ctx.id, ctx.state, true);
      this.dispatchVolume(ctx, ctx.transports, ctx.state.volume);
    }
  }

  private async disposeZone(zoneId: number): Promise<void> {
    const ctx = this.zones.get(zoneId);
    if (!ctx) {
      return;
    }
    try {
      const session = ctx.player.stop('reconfigure');
      await this.stopTransports(ctx.transports, session);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('zone dispose failed', { zoneId, message });
    }
    unregisterPlayer(zoneId);
    this.zones.delete(zoneId);
  }

  public async shutdown(): Promise<void> {
    await Promise.all(
      Array.from(this.zones.values()).map(async (ctx) => {
        const session = ctx.player.stop('shutdown');
        await this.stopTransports(ctx.transports, session);
        unregisterPlayer(ctx.id);
      }),
    );
    this.disposeAllTransports();
    await airplayInputService.shutdown();
    await spotifyInputService.shutdown();
    musicAssistantInputService.shutdown();
    this.zones.clear();
    this.initialized = false;
  }

  public getState(zoneId: number): LoxoneZoneState | undefined {
    return this.zones.get(zoneId)?.state;
  }

  public getQueue(zoneId: number, start: number, limit: number) {
    const ctx = this.zones.get(zoneId);
    if (!ctx) {
      return {
        id: zoneId,
        items: [],
        shuffle: false,
        start: 0,
        totalitems: 0,
        authority: 'local' as QueueAuthority,
      };
    }

    if (isRadioAudiopath(ctx.state.audiopath, ctx.state.audiotype)) {
      return {
        id: zoneId,
        items: [],
        shuffle: ctx.queue.shuffle,
        start: 0,
        totalitems: 0,
        authority: ctx.queue.authority,
      };
    }

    const slice = ctx.queue.items.slice(start, start + limit).map((item) => ({
      ...item,
      // Loxone kan geen spotify@username prefixes aan; strip alleen voor output.
      audiopath: sanitizeAudiopathForOutput(item.audiopath),
      // Mask station for local/library items so they don't show as radio entries.
      station: (item.audiopath ?? '').startsWith('library:') ? '' : item.station ?? '',
    }));
    this.log.debug('getQueue', {
      zoneId,
      start,
      limit,
      total: ctx.queue.items.length,
      returned: slice.length,
    });
    return {
      id: zoneId,
      items: slice,
      shuffle: ctx.queue.shuffle,
      start,
      totalitems: ctx.queue.items.length,
      authority: ctx.queue.authority,
    };
  }

  public getZoneVolumes(zoneId: number): ZoneConfig['volumes'] | undefined {
    return this.zones.get(zoneId)?.config?.volumes;
  }

  public async playContent(
    zoneId: number,
    uri: string,
    type: string,
    metadata?: PlaybackMetadata,
  ): Promise<void> {
    const ctx = this.zones.get(zoneId);
    if (!ctx) {
      return;
    }

    const parentContext = this.parseParentContext(uri);
    const isAppleMusicUri = this.isAppleMusicAudiopath(uri);
    const isDeezerUri = this.isDeezerAudiopath(uri);
    const isTidalUri = this.isTidalAudiopath(uri);
    let resolvedTarget =
      parentContext?.parent ??
      (isAppleMusicUri || isDeezerUri || isTidalUri ? uri : decodeAudiopath(uri));
    let stationUri = parentContext?.parent ? normalizeSpotifyAudiopath(parentContext.parent) : '';
    let normalizedTarget = normalizeSpotifyAudiopath(resolvedTarget);
    const isMusicAssistantInitial = this.isMusicAssistantAudiopath(uri) || this.isMusicAssistantAudiopath(resolvedTarget);
    let queueAudiopath = isMusicAssistantInitial ? normalizeSpotifyAudiopath(uri) : normalizedTarget;
    if (isMusicAssistantInitial && parentContext?.parent) {
      const providerPrefix = queueAudiopath.split(':')[0] || getMusicAssistantProviderId();
      const parentType = /playlist/i.test(parentContext.parent)
        ? 'playlist'
        : /album/i.test(parentContext.parent)
          ? 'album'
          : /artist/i.test(parentContext.parent)
            ? 'artist'
            : 'track';
      const wrappedParent = encodeAudiopath(parentContext.parent, parentType, providerPrefix);
      resolvedTarget = wrappedParent;
      normalizedTarget = normalizeSpotifyAudiopath(resolvedTarget);
      stationUri = normalizeSpotifyAudiopath(resolvedTarget);
      queueAudiopath = normalizeSpotifyAudiopath(uri);
    }
    const isMusicAssistant = this.isMusicAssistantAudiopath(queueAudiopath) || this.isMusicAssistantAudiopath(resolvedTarget);
    const isAppleMusic = this.isAppleMusicAudiopath(queueAudiopath) || this.isAppleMusicAudiopath(resolvedTarget);
    const isDeezer = this.isDeezerAudiopath(queueAudiopath) || this.isDeezerAudiopath(resolvedTarget);
    const isTidal = this.isTidalAudiopath(queueAudiopath) || this.isTidalAudiopath(resolvedTarget);
    const nextInput: ZoneContext['inputMode'] =
      this.isSpotifyAudiopath(queueAudiopath)
        ? 'spotify'
        : isMusicAssistant
          ? 'musicassistant'
          : isAppleMusic
            ? 'applemusic'
            : isDeezer
              ? 'deezer'
              : isTidal
                ? 'tidal'
                : 'queue';
    if (isMusicAssistant && type === 'serviceplay' && this.isActiveInput(ctx, 'musicassistant')) {
      if (this.isSameAudiopath(ctx, queueAudiopath)) {
        this.log.debug('playContent ignored; musicassistant already playing target', {
          zoneId,
          target: normalizeSpotifyAudiopath(queueAudiopath),
        });
        return;
      }
    }
    this.stopExternalInputSessions(zoneId, ctx.inputMode ?? null, nextInput);
    let stationValue =
      parentContext?.parent && isMusicAssistant
        ? parentContext.parent
        : parentContext?.parent
          ? sanitizeStation(parentContext.parent, normalizedTarget)
          : stationUri;
    let isRadio = isRadioAudiopath(resolvedTarget) || isRadioAudiopath(uri);
    if (!isRadio) {
      const decodedTarget = decodeAudiopath(resolvedTarget) || resolvedTarget;
      const decodedUri = decodeAudiopath(uri) || uri;
      const isHttpStream =
        /^https?:\/\//i.test(decodedTarget) || /^https?:\/\//i.test(decodedUri);
      if (isHttpStream && !(metadata?.duration && metadata.duration > 0)) {
        isRadio = true;
      }
    }
    if (isRadio && !stationValue && metadata?.station?.trim()) {
      stationValue = metadata.station.trim();
    }
    if (isRadio && !stationValue && metadata?.title?.trim()) {
      stationValue = metadata.title.trim();
    }
    if (isRadio && !stationValue) {
      stationValue = deriveRadioStationLabel(resolvedTarget) ?? deriveRadioStationLabel(uri) ?? '';
    }
    this.log.info('playContent', {
      zoneId,
      type,
      uri,
      resolvedTarget,
      normalizedTarget,
      station: stationUri,
      hasParentContext: Boolean(parentContext),
    });

    // If this looks like a queue item selection (no parent context) and the item already
    // exists in our queue, just seek to it instead of rebuilding the queue.
    if (!parentContext && ctx.state.mode !== 'stop' && this.seekExistingQueueInternal(ctx, normalizedTarget)) {
      const current = ctx.queueController.current();
      if (!current) {
        this.log.warn('queue seek failed; no current item', { zoneId, target: normalizedTarget });
        return;
      }
      const session = await this.startQueuePlayback(ctx, current.audiopath, {
        title: current.title || ctx.name,
        artist: current.artist || '',
        album: current.album || '',
        coverurl: current.coverurl,
        duration: current.duration,
        audiopath: current.audiopath,
        station: current.station,
        stationIndex: ctx.queueController.currentIndex(),
        isRadio: isRadioAudiopath(current.audiopath, current.audiotype),
      });
      if (session) {
        void recentsManager.record(zoneId, current);
        if (!isRadioAudiopath(current.audiopath, current.audiotype)) {
          notifyQueueUpdated(zoneId, ctx.queue.items.length);
        }
      } else {
        this.log.warn('playback skipped; no playable source resolved', {
          zoneId,
          audiopath: current.audiopath,
        });
        const shouldStayOnline =
          this.isMusicAssistantAudiopath(current.audiopath) ||
          this.isSpotifyAudiopath(current.audiopath) ||
          this.isAppleMusicAudiopath(current.audiopath);
        this.patchState(
          zoneId,
          shouldStayOnline
            ? { mode: 'stop', clientState: 'on', power: 'on' }
            : { mode: 'stop', clientState: 'off', power: 'off' },
        );
        this.dispatchTransports(ctx, ctx.transports, 'stop', null);
      }
      return;
    }

    const queueSourcePath =
      isAppleMusic && parentContext?.parent ? parentContext.parent : uri;
    const expandedQueue = await this.buildQueueForUri(
      resolvedTarget,
      ctx.name,
      stationUri || undefined,
      queueSourcePath,
    );
    this.log.debug('queue build resolved', {
      zoneId,
      queueSourcePath,
      resolvedTarget,
      expandedCount: expandedQueue.length,
      isAppleMusic,
      isMusicAssistant,
    });
    const fallbackAudiopath = parentContext?.startItem ?? queueAudiopath;
    let enrichedMetadata: PlaybackMetadata | undefined =
      parentContext?.parent || metadata
        ? {
          ...(metadata ?? { title: '', artist: '', album: '' }),
          station: stationValue ?? (metadata as any)?.station,
        }
        : metadata;
    if ((isMusicAssistant || isAppleMusic) && (!enrichedMetadata || !enrichedMetadata.title || !enrichedMetadata.artist)) {
      try {
        const metaTarget = parentContext?.startItem ?? queueAudiopath;
        const meta = await contentManager.resolveMetadata(metaTarget);
        if (meta) {
          enrichedMetadata = { ...meta, station: stationValue };
        }
      } catch {
        /* ignore */
      }
    }
    const queueAudioType = isMusicAssistant || isAppleMusic || isDeezer || isTidal ? 5 : isRadio ? 1 : 0;
    let queueItems = expandedQueue.length
      ? expandedQueue.map((item) => ({
        ...item,
        audiopath: isRadio ? toRadioAudiopath(item.audiopath) : item.audiopath,
        audiotype: isRadio ? 1 : item.audiotype,
        station: parentContext?.parent
          ? isMusicAssistant
            ? parentContext.parent
            : sanitizeStation(parentContext.parent, item.audiopath)
          : item.station,
      }))
      : [
        createQueueItem(
          isRadio ? toRadioAudiopath(fallbackAudiopath) : normalizeSpotifyAudiopath(fallbackAudiopath),
          ctx.name,
          enrichedMetadata,
          queueAudioType,
        ),
      ];
    if (isRadio) {
      queueItems = queueItems.map((item) => ({
        ...item,
        title: '',
        artist: '',
        album: '',
        duration: 0,
        station: stationValue ?? item.station ?? '',
      }));
    }

    // determine the starting index
    let startIndex = parentContext?.startIndex ?? 0;
    const startHint = parentContext?.startItem ?? normalizedTarget;
    const normalizedStartHint = normalizeSpotifyAudiopath(startHint);
    const hintedIndex = queueItems.findIndex(
      (item) =>
        normalizeSpotifyAudiopath(item.audiopath) === normalizedStartHint ||
        normalizeSpotifyAudiopath(item.unique_id) === normalizedStartHint,
    );
    if (hintedIndex >= 0) {
      startIndex = hintedIndex;
    }

    // reset queue with resolved items
    const clampedIndex = clamp(startIndex, 0, queueItems.length - 1);
    const bridgeProvider =
      this.resolveBridgeProvider(queueAudiopath) ??
      this.resolveBridgeProvider(resolvedTarget) ??
      this.resolveBridgeProvider(uri);
    const forceLocalQueue =
      isAppleMusic ||
      (this.isSpotifyAudiopath(queueAudiopath) && Boolean(bridgeProvider && bridgeProvider !== 'spotify'));
    ctx.queue.authority = forceLocalQueue
      ? 'local'
      : isMusicAssistant
        ? 'musicassistant'
        : isAppleMusic
          ? 'applemusic'
          : isDeezer
            ? 'deezer'
            : isTidal
              ? 'tidal'
              : this.isSpotifyAudiopath(queueAudiopath)
                ? 'spotify'
                : 'local';
    this.log.debug('queue rebuilt', {
      zoneId: ctx.id,
      items: queueItems.length,
      startIndex: clampedIndex,
      target: queueItems[clampedIndex]?.audiopath,
      authority: ctx.queue.authority,
    });
    ctx.queueController.setItems(queueItems, clampedIndex);
    ctx.queue.shuffle = false;
    ctx.queue.repeat = 0;

    const current = ctx.queueController.current();
    if (!current) {
      this.log.warn('playback skipped; empty queue after build', { zoneId, uri });
      return;
    }

    const stationForPlayback =
      isMusicAssistant && current.station ? current.station : stationValue;
    const session = await this.startQueuePlayback(ctx, current.audiopath, {
      title: enrichedMetadata?.title?.trim() || current.title || ctx.name,
      artist: enrichedMetadata?.artist?.trim() || current.artist || '',
      album: enrichedMetadata?.album?.trim() || current.album || '',
      coverurl: enrichedMetadata?.coverurl || current.coverurl,
      duration: typeof enrichedMetadata?.duration === 'number' ? enrichedMetadata.duration : current.duration,
      audiopath: enrichedMetadata?.audiopath,
      trackId: enrichedMetadata?.trackId,
      station: stationForPlayback,
      stationIndex: ctx.queueController.currentIndex(),
      isRadio,
    });
    if (session) {
      void recentsManager.record(zoneId, current);
      if (!isRadio) {
        notifyQueueUpdated(zoneId, ctx.queue.items.length);
      }
    } else {
      this.log.warn('playback skipped; no playable source resolved', {
        zoneId,
        audiopath: current.audiopath,
      });
      const shouldStayOnline =
        this.isMusicAssistantAudiopath(current.audiopath) ||
        this.isSpotifyAudiopath(current.audiopath) ||
        this.isAppleMusicAudiopath(current.audiopath);
      this.patchState(
        zoneId,
        shouldStayOnline
          ? { mode: 'stop', clientState: 'on', power: 'on' }
          : { mode: 'stop', clientState: 'off', power: 'off' },
      );
      this.dispatchTransports(ctx, ctx.transports, 'stop', null);
    }
  }

  private async startQueuePlayback(
    ctx: ZoneContext,
    audiopath: string,
    metadata?: PlaybackMetadata,
  ): Promise<PlaybackSession | null> {
    // Apply preferred output from the primary target transport so we can resample/format accordingly.
    let override:
      | (Partial<import('@/modules/audio/utils/audioFormat').AudioOutputSettings> & {
          profile?: import('@/modules/audio/audioManager').OutputProfile;
        })
      | null = null;
    const primaryOutput =
      (ctx.activeOutput
        ? ctx.transports.find((transport) => transport.type === ctx.activeOutput)
        : null) ?? this.selectPlayOutputs(ctx.transports, null)[0] ?? null;
    if (primaryOutput && typeof (primaryOutput as any).getPreferredOutput === 'function') {
      const pref = (primaryOutput as any).getPreferredOutput?.();
      if (pref) {
        override = {};
        if (typeof pref.sampleRate === 'number') {
          override.sampleRate = pref.sampleRate;
        }
        if (typeof pref.channels === 'number') {
          override.channels = pref.channels;
        }
        if (pref.bitDepth) {
          override.pcmBitDepth = pref.bitDepth as any;
        }
        if (pref.profile) {
          override.profile = pref.profile as any;
        }
        if (typeof pref.prebufferBytes === 'number' && pref.prebufferBytes > 0) {
          override.prebufferBytes = pref.prebufferBytes;
        }
      }
    }
    if (this.shouldReducePrebuffer(ctx, audiopath)) {
      const radioPrebufferBytes = 8 * 1024;
      const current =
        typeof override?.prebufferBytes === 'number'
          ? override.prebufferBytes
          : audioOutputSettings.prebufferBytes;
      const clamped = Math.min(current, radioPrebufferBytes);
      if (!override) {
        override = {};
      }
      override.prebufferBytes = clamped;
    }
    audioManager.setPreferredOutputSettings(ctx.id, override);
    if (primaryOutput && typeof (primaryOutput as any).getHttpPreferences === 'function') {
      const prefs = (primaryOutput as any).getHttpPreferences?.();
      if (prefs) {
        audioManager.setHttpPreferences(ctx.id, prefs);
      }
    } else {
      audioManager.setHttpPreferences(ctx.id, null);
    }
    const isSpotify = this.isSpotifyAudiopath(audiopath);
    const isMusicAssistant = this.isMusicAssistantAudiopath(audiopath);
    const isAppleMusic = this.isAppleMusicAudiopath(audiopath);
    const isDeezer = this.isDeezerAudiopath(audiopath);
    const isTidal = this.isTidalAudiopath(audiopath);
    const nextInput: ZoneContext['inputMode'] =
      isSpotify
        ? 'spotify'
        : isMusicAssistant
          ? 'musicassistant'
          : isAppleMusic
            ? 'applemusic'
            : isDeezer
              ? 'deezer'
              : isTidal
                ? 'tidal'
                : 'queue';
    const prevInput = ctx.inputMode;
    this.setInputMode(ctx, nextInput);
    this.stopExternalInputSessions(ctx.id, prevInput, nextInput);
    if (!isSpotify) {
      this.stopSpotifyTransports(ctx.transports);
    }
    const enrichedMetadata =
      metadata && metadata.audiopath
        ? metadata
        : { ...(metadata ?? { title: '', artist: '', album: '' }), audiopath };
    if (isMusicAssistant) {
      const result = await musicAssistantInputService.startStreamForAudiopath(
        ctx.id,
        ctx.name,
        audiopath,
        {
          flow: this.musicAssistantFlowMode,
          parentAudiopath: enrichedMetadata.station,
          startItem: audiopath,
          startIndex: typeof (enrichedMetadata as any).stationIndex === 'number'
            ? (enrichedMetadata as any).stationIndex
            : undefined,
          zoneConfig: ctx.config,
        },
      );
      const meta = { ...enrichedMetadata, audiotype: 5 } as PlaybackMetadata;
      if (result.playbackSource) {
        return ctx.player.playExternal('musicassistant', result.playbackSource, meta);
      }
      if (result.transportOnly) {
        return ctx.player.playExternal('musicassistant', null, meta);
      }
      this.handlePlaybackError(ctx.id, 'music assistant stream unavailable', 'transport');
      this.log.warn('music assistant stream not ready; skipping playback', {
        zoneId: ctx.id,
      });
      return null;
    }
    if (isAppleMusic) {
      const result = await appleMusicInputService.startStreamForAudiopath(
        ctx.id,
        ctx.name,
        audiopath,
      );
      const meta = { ...enrichedMetadata, audiotype: 5 } as PlaybackMetadata;
      if (result.playbackSource) {
        return ctx.player.playExternal('applemusic', result.playbackSource, meta);
      }
      if (result.transportOnly) {
        return ctx.player.playExternal('applemusic', null, meta);
      }
      this.handlePlaybackError(ctx.id, 'apple music stream unavailable', 'transport');
      this.log.warn('apple music stream not ready; skipping playback', { zoneId: ctx.id });
      return null;
    }
    if (isDeezer) {
      const result = await deezerInputService.startStreamForAudiopath(
        ctx.id,
        ctx.name,
        audiopath,
      );
      const meta = { ...enrichedMetadata, audiotype: 5 } as PlaybackMetadata;
      if (result.playbackSource) {
        return ctx.player.playExternal('deezer', result.playbackSource, meta);
      }
      if (result.transportOnly) {
        return ctx.player.playExternal('deezer', null, meta);
      }
      this.handlePlaybackError(ctx.id, 'deezer stream unavailable', 'transport');
      this.log.warn('deezer stream not ready; skipping playback', { zoneId: ctx.id });
      return null;
    }
    if (isTidal) {
      const result = await tidalInputService.startStreamForAudiopath(
        ctx.id,
        ctx.name,
        audiopath,
      );
      const meta = { ...enrichedMetadata, audiotype: 5 } as PlaybackMetadata;
      if (result.playbackSource) {
        return ctx.player.playExternal('tidal', result.playbackSource, meta);
      }
      if (result.transportOnly) {
        return ctx.player.playExternal('tidal', null, meta);
      }
      this.handlePlaybackError(ctx.id, 'tidal stream unavailable', 'transport');
      this.log.warn('tidal stream not ready; skipping playback', { zoneId: ctx.id });
      return null;
    }
    if (isSpotify) {
      const offloadEnabled = ctx.config.inputs?.spotify?.offload === true;
      const accountId = parseSpotifyUser(audiopath);
      let playbackSource: PlaybackSource | null = null;
      if (!offloadEnabled) {
        playbackSource =
          (await spotifyInputService.getPlaybackSourceForUri(
            ctx.id,
            normalizeSpotifyAudiopath(audiopath),
            0,
            accountId,
          )) ?? spotifyInputService.getPlaybackSource(ctx.id);
      }
      this.log.debug('startQueuePlayback spotify', {
        zoneId: ctx.id,
        audiopath,
        hasPlaybackSource: Boolean(playbackSource),
        playbackKind: playbackSource?.kind,
        connectEnabled: offloadEnabled,
        queueSize: ctx.queue.items.length,
      });
      if (!playbackSource && !offloadEnabled) {
        this.log.warn('spotify input not ready; blocking playback to avoid skips', { zoneId: ctx.id });
        return null;
      }
      const playbackIsPipe = playbackSource?.kind === 'pipe';
      const queueUris = ctx.queue.items.map((q) => q.audiopath);
      const queueIndex = ctx.queueController.currentIndex();
      const session = ctx.player.playExternal('spotify', playbackSource, {
        ...enrichedMetadata,
        queue: queueUris,
        queueIndex,
      });
      if (playbackIsPipe) {
        spotifyInputService.markSessionActive(ctx.id, enrichedMetadata);
      }
      return session;
    }
    return ctx.player.playUri(audiopath, enrichedMetadata);
  }

  public playInputSource(
    zoneId: number,
    label: string,
    playbackSource: PlaybackSource,
    metadata?: PlaybackMetadata,
  ): void {
    const ctx = this.zones.get(zoneId);
    if (!ctx) {
      return;
    }
    const normalized = label.toLowerCase();
    if (!['airplay', 'spotify', 'musicassistant', 'applemusic', 'deezer', 'tidal'].includes(normalized)) {
      return;
    }
    const mode = normalized as ZoneContext['inputMode'];
    // Avoid re-dispatching transports when the same input/track is already playing.
    if (metadata?.audiopath && this.isActiveInput(ctx, mode) && this.isSameAudiopath(ctx, metadata.audiopath)) {
      this.updateInputMetadata(zoneId, metadata);
      return;
    }
    const prevInput = ctx.inputMode;
    this.setInputMode(ctx, mode);
    this.stopExternalInputSessions(zoneId, prevInput, mode);
    if (mode !== 'spotify') {
      this.stopSpotifyTransports(ctx.transports);
    }
    ctx.queue.authority =
      mode === 'airplay'
        ? 'airplay'
        : mode === 'spotify'
          ? 'spotify'
          : mode === 'musicassistant'
            ? 'musicassistant'
            : mode === 'deezer'
              ? 'deezer'
              : mode === 'tidal'
                ? 'tidal'
                : 'applemusic';
    ctx.inputAdapter.playInput(label, playbackSource, metadata);
  }

  public stopInputSource(zoneId: number): void {
    const ctx = this.zones.get(zoneId);
    if (!ctx) {
      return;
    }
    this.setInputMode(ctx, null);
    ctx.player.stop('input_stop');
  }

  public pauseInputSource(zoneId: number): void {
    const ctx = this.zones.get(zoneId);
    if (!ctx) {
      return;
    }
    if (ctx.activeInput && ctx.activeInput !== 'spotify') {
      this.stopSpotifyTransports(ctx.transports);
    }
    ctx.player.pause();
  }

  public resumeInputSource(zoneId: number): void {
    const ctx = this.zones.get(zoneId);
    if (!ctx) {
      return;
    }
    if (ctx.activeInput && ctx.activeInput !== 'spotify') {
      this.stopSpotifyTransports(ctx.transports);
    }
    ctx.player.resume();
  }

  public updateInputMetadata(zoneId: number, metadata: Partial<PlaybackMetadata>): void {
    const ctx = this.zones.get(zoneId);
    if (!ctx) {
      return;
    }
    const allowedInputs = new Set(['spotify', 'airplay', 'musicassistant', 'applemusic', 'deezer', 'tidal']);
    if (ctx.activeInput && !allowedInputs.has(ctx.activeInput)) {
      return;
    }
    ctx.player.updateMetadata(metadata as PlaybackMetadata);
    const didSeek =
      ctx.inputMode === 'musicassistant' && metadata.audiopath
        ? this.seekExistingQueueInternal(ctx, metadata.audiopath)
        : false;

    // Propagate richer metadata into the current queue item so recents/queue
    // can retain album/artist/cover details (especially for Music Assistant streams).
    const current = ctx.queueController.current();
    if (current) {
      let changed = false;
      const assign = (key: 'title' | 'artist' | 'album' | 'coverurl' | 'audiopath', value?: string) => {
        const trimmed = typeof value === 'string' ? value.trim() : '';
        if (trimmed && current[key] !== trimmed) {
          current[key] = trimmed;
          changed = true;
        }
      };

      assign('title', metadata.title);
      assign('artist', metadata.artist);
      assign('album', metadata.album);
      assign('coverurl', metadata.coverurl as string | undefined);
      assign('audiopath', metadata.audiopath);

      if (changed) {
        void recentsManager.record(zoneId, current);
      }
    }

    const patch: Partial<LoxoneZoneState> = {};
    const assignPatch = (key: keyof Pick<LoxoneZoneState, 'title' | 'artist' | 'album' | 'coverurl' | 'audiopath'>, value?: string) => {
      const trimmed = typeof value === 'string' ? value.trim() : '';
      if (!trimmed) {
        return;
      }
      patch[key] = trimmed as any;
    };
    assignPatch('title', metadata.title ? sanitizeTitle(metadata.title, fallbackTitle(ctx.state.title, ctx.name)) : undefined);
    assignPatch('artist', metadata.artist);
    assignPatch('album', metadata.album);
    assignPatch('coverurl', metadata.coverurl as string | undefined);
    assignPatch('audiopath', metadata.audiopath);
    if (typeof metadata.duration === 'number' && metadata.duration > 0) {
      patch.duration = Math.round(metadata.duration);
    }
    if (didSeek && current) {
      patch.qindex = ctx.queueController.currentIndex();
      patch.qid = current.unique_id;
    }
    if (ctx.queue.authority) {
      patch.queueAuthority = ctx.queue.authority;
    }
    if (Object.keys(patch).length > 0) {
      this.patchState(zoneId, patch);
    }
  }

  public updateInputCover(zoneId: number, cover?: CoverArtPayload): string | undefined {
    const ctx = this.zones.get(zoneId);
    if (!ctx) {
      return undefined;
    }
    const allowedInputs = new Set(['spotify', 'airplay', 'musicassistant', 'applemusic', 'deezer', 'tidal']);
    if (ctx.activeInput && !allowedInputs.has(ctx.activeInput)) {
      return undefined;
    }
    const relativePath = ctx.player.updateCover(cover) ?? '';
    const baseUrl =
      relativePath && cover ? this.buildAbsoluteCoverUrl(relativePath) : '';
    const coverUrl = baseUrl ? `${baseUrl}?t=${Date.now()}` : '';
    const current = ctx.queueController.current();
    if (current) {
      current.coverurl = coverUrl;
    }
    return coverUrl || undefined;
  }

  public updateInputVolume(zoneId: number, volume: number): void {
    const ctx = this.zones.get(zoneId);
    if (!ctx) {
      return;
    }
    const allowedInputs = new Set(['spotify', 'airplay', 'musicassistant', 'applemusic', 'deezer', 'tidal']);
    if (ctx.activeInput && !allowedInputs.has(ctx.activeInput)) {
      return;
    }
    const level = clampVolumeForZone(ctx.config, volume);
    ctx.player.setVolume(level);
  }

  public updateInputTiming(zoneId: number, elapsed: number, duration: number): void {
    const ctx = this.zones.get(zoneId);
    if (!ctx) {
      return;
    }
    const safeDuration = Math.max(0, Math.round(duration));
    const safeElapsed = Math.max(0, Math.round(elapsed));
    const boundedElapsed =
      safeDuration > 0 ? Math.min(safeElapsed, safeDuration) : safeElapsed;
    ctx.player.updateTiming(boundedElapsed, safeDuration);
  }

  public renameZone(zoneId: number, name: string): void {
    const ctx = this.zones.get(zoneId);
    if (!ctx) {
      return;
    }
    const trimmed = name.trim();
    if (!trimmed || ctx.name === trimmed) {
      return;
    }
    ctx.name = trimmed;
    const patch: Partial<LoxoneZoneState> = { name: trimmed };
    const current = ctx.queueController.current();
    const sourceName = resolveSourceName(ctx.state.audiotype ?? getInputAudioType(ctx), ctx, current);
    if (sourceName) {
      patch.sourceName = sourceName;
    }
    this.patchState(zoneId, patch);
    void airplayInputService.renameZone(zoneId, trimmed);
    void spotifyInputService.renameZone(zoneId, trimmed);
  }

  private parseParentContext(raw: string): {
    parent: string;
    startItem?: string;
    startIndex?: number;
  } | null {
    const sep = '/parentpath/';
    if (!raw.includes(sep)) {
      return null;
    }
    const idx = raw.indexOf(sep);
    const childRaw = raw.slice(0, idx);
    const parentAndRest = raw
      .slice(idx + sep.length)
      .replace(/\/noshuffle.*$/i, '')
      .replace(/\/\?q&ZW5mb3JjZVVzZXI9dHJ1ZQ.*$/i, '')
      .replace(/\/\?q&[A-Za-z0-9+/=]+$/i, '')
      .replace(/\/+$/, '');
    const lastSlash = parentAndRest.lastIndexOf('/');
    const parentRaw = lastSlash >= 0 ? parentAndRest.slice(0, lastSlash) : parentAndRest;
    const indexPart = lastSlash >= 0 ? parentAndRest.slice(lastSlash + 1) : '';

    const startIndex =
      indexPart && /^\d+$/.test(indexPart) ? Number(indexPart) : undefined;

    const parentProvider = parentRaw.split(':')[0] ?? '';
    const isAppleMusicParent =
      Boolean(parentProvider && appleMusicInputService.isAppleMusicProvider(parentProvider)) ||
      /applemusic/i.test(parentRaw);
    const isDeezerParent =
      Boolean(parentProvider && deezerInputService.isDeezerProvider(parentProvider)) ||
      /deezer/i.test(parentRaw);
    const isTidalParent =
      Boolean(parentProvider && tidalInputService.isTidalProvider(parentProvider)) ||
      /tidal/i.test(parentRaw);
    return {
      parent: (isAppleMusicParent || isDeezerParent || isTidalParent)
        ? normalizeSpotifyAudiopath(parentRaw)
        : decodeAudiopath(parentRaw),
      // Keep the original provider wrapper (e.g., spotify@bridge:track:...) for the item so routing stays intact.
      startItem: normalizeSpotifyAudiopath(childRaw),
      startIndex,
    };
  }

  public seekInQueue(zoneId: number, target: string): boolean {
    const ctx = this.zones.get(zoneId);
    if (!ctx) {
      return false;
    }
    return this.seekExistingQueueInternal(ctx, target);
  }

  private seekExistingQueueInternal(ctx: ZoneContext, target: string): boolean {
    if (!target || ctx.queue.items.length === 0) {
      return false;
    }
    const normalizedTarget = normalizeSpotifyAudiopath(target);
    const idx = ctx.queue.items.findIndex(
      (item) =>
        normalizeSpotifyAudiopath(item.audiopath) === normalizedTarget ||
        normalizeSpotifyAudiopath(item.unique_id) === normalizedTarget,
    );
    if (idx < 0) {
      return false;
    }
    // Only record the index change; actual seeking is handled via explicit HTTP commands.
    ctx.queueController.setCurrentIndex(idx);
    this.log.debug('queue seek requested; qindex updated', {
      zoneId: ctx.id,
      target,
      qindex: idx,
    });
    return true;
  }

  private async buildQueueForUri(
    uri: string,
    zoneName: string,
    station?: string,
    rawAudiopath?: string,
  ): Promise<QueueItem[]> {
    const stripRoutingSuffixLocal = (value: string): string =>
      value
        .replace(/\/parentid\/.*$/i, '')
        .replace(/\/parentpath\/.*$/i, '')
        .replace(/\/noshuffle.*$/i, '')
        .replace(/\/\?q&ZW5mb3JjZVVzZXI9dHJ1ZQ.*$/i, '')
        .replace(/\/\?q&[A-Za-z0-9+/=]+$/i, '')
        .replace(/\/+$/, '');
    const rawPath = rawAudiopath ?? uri;
    const rawLower = (rawPath || '').toLowerCase();
    const bridgeProvider = this.resolveBridgeProvider(rawPath);
    const forceSpotify = rawLower.startsWith('spotify@') && !bridgeProvider;
    const rawClean = stripRoutingSuffixLocal(rawPath);
    const decoded = forceSpotify ? rawClean : decodeAudiopath(uri);
    if (!decoded) {
      return [];
    }
    const isMusicAssistant = bridgeProvider === 'musicassistant' || (!forceSpotify && this.isMusicAssistantAudiopath(rawPath));
    const service =
      bridgeProvider ||
      (forceSpotify
        ? 'spotify'
        : isMusicAssistant
          ? 'musicassistant'
          : detectServiceFromAudiopath(rawPath));
    const isAppleMusic = !forceSpotify && (service === 'applemusic' || /applemusic/i.test(rawPath));
    const isDeezer = !forceSpotify && (service === 'deezer' || /deezer/i.test(rawPath));
    const isTidal = !forceSpotify && (service === 'tidal' || /tidal/i.test(rawPath));

    // Local library content
    if (!forceSpotify && (decoded.startsWith('library:') || decoded.startsWith('library-'))) {
      const folder = await contentManager.getMediaFolder(decoded, 0, 500);
      if (folder?.items?.length) {
        // local library items are not radio; do not propagate station
        return mapFolderItemsToQueue(folder.items, zoneName, 0, 'nouser', '');
      }
      const meta = await contentManager.resolveMetadata(decoded);
      if (meta) {
        return [createQueueItem(uri, zoneName, meta, 0)];
      }
      return [];
    }

    // Music Assistant bridge content
    if (!forceSpotify && (isMusicAssistant || service === 'musicassistant' || /musicassistant/i.test(rawPath))) {
      const user = getMusicAssistantUserId();
      const sourcePath =
        (station && station.trim()
          ? station
          : decoded || rawAudiopath || uri || '') || '';
      const folderId = sourcePath
        .replace(/^spotify@[^:]+:/i, '')
        .replace(/^musicassistant@[^:]+:/i, '')
        .replace(/^spotify:/i, '')
        .replace(/^musicassistant:/i, '');
      if (folderId.toLowerCase().startsWith('track:')) {
        const trackId = folderId.split(':').pop() ?? '';
        const track = await contentManager.getServiceTrack('musicassistant', user, trackId);
        if (track) {
          return mapFolderItemsToQueue([track], zoneName, 5, user);
        }
      }
      const allItems: ContentFolderItem[] = [];
      const pageSize = 50;
      let offset = 0;
      let total = Number.MAX_SAFE_INTEGER;
      while (offset < total) {
        const folder = await contentManager.getServiceFolder('musicassistant', user, folderId, offset, pageSize);
        const items = folder?.items ?? [];
        if (items.length === 0) {
          break;
        }
        allItems.push(...items);
        total = Number.isFinite(folder?.totalitems) ? (folder as any).totalitems : Number.MAX_SAFE_INTEGER;
        offset += items.length;
        if (items.length < pageSize) {
          break;
        }
        if (allItems.length >= 1000) {
          break;
        }
      }
      if (allItems.length) {
        return mapFolderItemsToQueue(allItems, zoneName, 5, user, station ?? decoded);
      }
    }

    // Apple Music bridge content
    if (!forceSpotify && (isAppleMusic || service === 'applemusic' || /applemusic/i.test(rawPath))) {
      const providerId = rawClean.split(':')[0] || 'applemusic';
      const user = providerId.split('@')[1] ?? 'applemusic';
      const sourcePath =
        (station && station.trim()
          ? station
          : decoded || rawAudiopath || uri || '') || '';
      const folderId = sourcePath
        .replace(/^spotify@[^:]+:/i, '')
        .replace(/^applemusic@[^:]+:/i, '')
        .replace(/^spotify:/i, '')
        .replace(/^applemusic:/i, '');
      if (/^(library-)?track:/i.test(folderId)) {
        const trackId = folderId.split(':').slice(1).join(':');
        const track = await contentManager.getServiceTrack(providerId, user, `${folderId.split(':')[0]}:${trackId}`);
        if (track) {
          return mapFolderItemsToQueue([track], zoneName, 5, user);
        }
        this.log.debug('apple music queue track lookup failed', {
          providerId,
          folderId,
          trackId,
        });
      }
      const allItems: ContentFolderItem[] = [];
      const pageSize = 50;
      let offset = 0;
      let total = Number.MAX_SAFE_INTEGER;
      while (offset < total) {
        const folder = await contentManager.getServiceFolder(providerId, user, folderId, offset, pageSize);
        const items = folder?.items ?? [];
        if (items.length === 0) {
          break;
        }
        allItems.push(...items);
        total = Number.isFinite(folder?.totalitems) ? (folder as any).totalitems : Number.MAX_SAFE_INTEGER;
        offset += items.length;
        if (items.length < pageSize) {
          break;
        }
        if (allItems.length >= 1000) {
          break;
        }
      }
      if (allItems.length) {
        return mapFolderItemsToQueue(allItems, zoneName, 5, user, station ?? decoded);
      }
    }

    // Deezer bridge content
    if (!forceSpotify && (isDeezer || service === 'deezer' || /deezer/i.test(rawPath))) {
      const providerId = rawClean.split(':')[0] || 'deezer';
      const user = providerId.split('@')[1] ?? 'deezer';
      const sourcePath =
        (station && station.trim()
          ? station
          : decoded || rawAudiopath || uri || '') || '';
      const folderId = sourcePath
        .replace(/^spotify@[^:]+:/i, '')
        .replace(/^deezer@[^:]+:/i, '')
        .replace(/^spotify:/i, '')
        .replace(/^deezer:/i, '');
      if (/^track:/i.test(folderId)) {
        const trackId = folderId.split(':').slice(1).join(':');
        const track = await contentManager.getServiceTrack(providerId, user, `track:${trackId}`);
        if (track) {
          return mapFolderItemsToQueue([track], zoneName, 5, user);
        }
        this.log.debug('deezer queue track lookup failed', {
          providerId,
          folderId,
          trackId,
        });
      }
      const allItems: ContentFolderItem[] = [];
      const pageSize = 50;
      let offset = 0;
      let total = Number.MAX_SAFE_INTEGER;
      while (offset < total) {
        const folder = await contentManager.getServiceFolder(providerId, user, folderId, offset, pageSize);
        const items = folder?.items ?? [];
        if (items.length === 0) {
          break;
        }
        allItems.push(...items);
        total = Number.isFinite(folder?.totalitems) ? (folder as any).totalitems : Number.MAX_SAFE_INTEGER;
        offset += items.length;
        if (items.length < pageSize) {
          break;
        }
        if (allItems.length >= 1000) {
          break;
        }
      }
      if (allItems.length) {
        return mapFolderItemsToQueue(allItems, zoneName, 5, user, station ?? decoded);
      }
    }

    // Tidal bridge content
    if (!forceSpotify && (isTidal || service === 'tidal' || /tidal/i.test(rawPath))) {
      const providerId = rawClean.split(':')[0] || 'tidal';
      const user = providerId.split('@')[1] ?? 'tidal';
      const sourcePath =
        (station && station.trim()
          ? station
          : decoded || rawAudiopath || uri || '') || '';
      const folderId = sourcePath
        .replace(/^spotify@[^:]+:/i, '')
        .replace(/^tidal@[^:]+:/i, '')
        .replace(/^spotify:/i, '')
        .replace(/^tidal:/i, '');
      if (/^track:/i.test(folderId)) {
        const trackId = folderId.split(':').slice(1).join(':');
        const track = await contentManager.getServiceTrack(providerId, user, `track:${trackId}`);
        if (track) {
          return mapFolderItemsToQueue([track], zoneName, 5, user);
        }
        this.log.debug('tidal queue track lookup failed', {
          providerId,
          folderId,
          trackId,
        });
      }
      const allItems: ContentFolderItem[] = [];
      const pageSize = 50;
      let offset = 0;
      let total = Number.MAX_SAFE_INTEGER;
      while (offset < total) {
        const folder = await contentManager.getServiceFolder(providerId, user, folderId, offset, pageSize);
        const items = folder?.items ?? [];
        if (items.length === 0) {
          break;
        }
        allItems.push(...items);
        total = Number.isFinite(folder?.totalitems) ? (folder as any).totalitems : Number.MAX_SAFE_INTEGER;
        offset += items.length;
        if (items.length < pageSize) {
          break;
        }
        if (allItems.length >= 1000) {
          break;
        }
      }
      if (allItems.length) {
        return mapFolderItemsToQueue(allItems, zoneName, 5, user, station ?? decoded);
      }
    }

    // Spotify content
    const spotifyCandidate = forceSpotify ? rawClean : decoded;
    if (spotifyCandidate.startsWith('spotify@') || spotifyCandidate.startsWith('spotify:')) {
      const user = spotifyCandidate.startsWith('spotify@')
        ? parseSpotifyUser(spotifyCandidate)
        : contentManager.getDefaultSpotifyAccountId() ?? 'nouser';
      const folderId = spotifyCandidate
        .replace(/^spotify@[^:]+:/i, '')
        .replace(/^spotify:/i, '');
      if (folderId.toLowerCase().startsWith('track:')) {
        const trackId = folderId.split(':').pop() ?? '';
        const track = await contentManager.getServiceTrack('spotify', user, trackId);
        if (track) {
          return mapFolderItemsToQueue([track], zoneName, 5, user);
        }
      }
      // Fetch full playlist/album in pages of 50.
      const allItems: ContentFolderItem[] = [];
      const pageSize = 50;
      let offset = 0;
      let total = Number.MAX_SAFE_INTEGER;
      while (offset < total) {
        const folder = await contentManager.getServiceFolder('spotify', user, folderId, offset, pageSize);
        const items = folder?.items ?? [];
        if (items.length === 0) {
          break;
        }
        allItems.push(...items);
        total = Number.isFinite(folder?.totalitems) ? (folder as any).totalitems : Number.MAX_SAFE_INTEGER;
        offset += items.length;
        if (items.length < pageSize) {
          break;
        }
        if (allItems.length >= 1000) {
          break;
        }
      }
      if (allItems.length) {
        return mapFolderItemsToQueue(allItems, zoneName, 5, user, station ?? decoded);
      }
    }

    return [];
  }

  public handleCommand(zoneId: number, command: string, payload?: string): void {
    const ctx = this.zones.get(zoneId);
    if (!ctx) {
      return;
    }
    const mode = ctx.inputMode ?? null;
    switch (command) {
      case 'play':
      case 'resume':
        {
          if (mode === 'airplay') {
            airplayInputService.remoteControl(zoneId, 'Play');
            break;
          }
          if (mode === 'musicassistant') {
            void musicAssistantInputService.playerCommand(zoneId, 'play');
            const session = ctx.player.resume();
            this.dispatchTransports(ctx, ctx.transports, 'resume', session ?? ctx.player.getSession());
            this.patchState(zoneId, { mode: 'play', clientState: 'on', power: 'on' });
            break;
          }
          const session = ctx.player.resume();
          this.dispatchTransports(ctx, ctx.transports, 'resume', session ?? ctx.player.getSession());
          this.patchState(zoneId, { mode: 'play', clientState: 'on', power: 'on' });
        }
        break;
      case 'pause':
        {
          if (mode === 'airplay') {
            airplayInputService.remoteControl(zoneId, 'Pause');
            this.patchState(zoneId, { mode: 'pause', clientState: 'on', power: 'on' });
            break;
          }
          if (mode === 'musicassistant') {
            void musicAssistantInputService.playerCommand(zoneId, 'pause');
            const session = ctx.player.pause();
            this.dispatchTransports(ctx, ctx.transports, 'pause', session ?? ctx.player.getSession());
            this.patchState(zoneId, { mode: 'pause', clientState: 'on', power: 'on' });
            break;
          }
          const session = ctx.player.pause();
          this.dispatchTransports(ctx, ctx.transports, 'pause', session ?? ctx.player.getSession());
          this.patchState(zoneId, { mode: 'pause', clientState: 'on', power: 'on' });
        }
        break;
      case 'stop':
      case 'off':
        {
          if (mode === 'airplay') {
            airplayInputService.remoteControl(zoneId, 'Stop');
            this.setInputMode(ctx, null);
            break;
          }
          if (mode === 'musicassistant') {
            void musicAssistantInputService.playerCommand(zoneId, 'stop');
            const session = ctx.player.stop('command_stop');
            this.dispatchTransports(ctx, ctx.transports, 'stop', session ?? ctx.player.getSession());
            this.setInputMode(ctx, null);
            break;
          }
          const session = ctx.player.stop('command_stop');
          this.dispatchTransports(ctx, ctx.transports, 'stop', session ?? ctx.player.getSession());
          this.setInputMode(ctx, null);
        }
        break;
      case 'position': {
        // Do not drive transports from here; seeking is handled via dedicated HTTP endpoints.
        const posSeconds = Number(payload);
        if (!Number.isFinite(posSeconds) || posSeconds < 0) {
          break;
        }
        if (!this.isQueueDriven(mode)) {
          break;
        }
        if (mode === 'musicassistant') {
          void musicAssistantInputService.playerCommand(zoneId, 'seek', { position: posSeconds });
          break;
        }
        const session = ctx.player.getSession();
        const duration = session?.duration ?? ctx.state.duration ?? 0;
        const clamped = duration > 0 ? Math.min(posSeconds, duration) : posSeconds;
        ctx.player.updateTiming(Math.round(clamped), duration);
        this.log.debug('position command ignored for transports (manual seek endpoint only)', {
          zoneId,
          requestedSeconds: posSeconds,
          clampedSeconds: clamped,
        });
        break;
      }
      case 'volume':
      case 'volume_set': {
        const vol = Number(payload);
        if (Number.isFinite(vol)) {
          const current = ctx.state.volume ?? 0;
          const isRelative = typeof payload === 'string' && /^[+-]/.test(payload);
          const maxVol =
            typeof ctx.config.volumes?.maxVolume === 'number' && ctx.config.volumes.maxVolume > 0
              ? ctx.config.volumes.maxVolume
              : 100;
          const step =
            typeof ctx.config.volumes?.volstep === 'number' && ctx.config.volumes.volstep > 0
              ? ctx.config.volumes.volstep
              : null;
          let target = clamp(isRelative ? current + vol : vol, 0, maxVol);
          if (step) {
            if (isRelative) {
              if (target > current) {
                target = Math.min(maxVol, Math.ceil(target / step) * step);
              } else if (target < current) {
                target = Math.max(0, Math.floor(target / step) * step);
              } else {
                target = current;
              }
            } else {
              target = clamp(Math.round(target / step) * step, 0, maxVol);
            }
          }
          this.log.debug('zone volume command', {
            zoneId,
            command,
            payload,
            target,
            origin: this.getVolumeOrigin(),
          });
          if (mode === 'airplay') {
            airplayInputService.remoteVolume(zoneId, target);
          }
          if (mode === 'musicassistant') {
            void musicAssistantInputService.playerCommand(zoneId, 'volume_set', {
              volume_level: target,
            });
          }
          // Apply locally and push to transports immediately so repeated relative commands
          // use the updated level even if input callbacks lag.
          ctx.player.setVolume(target);
          ctx.state.volume = target;
          this.patchState(zoneId, { volume: target });
          this.dispatchVolume(ctx, ctx.transports, target);
        }
        break;
      }
      case 'queueplus':
        if (mode === 'airplay') {
          airplayInputService.remoteControl(zoneId, 'Next');
          break;
        }
        if (mode === 'musicassistant') {
          void musicAssistantInputService.playerCommand(zoneId, 'next');
          break;
        }
        if (!this.isQueueDriven(mode)) {
          break;
        }
        if (!this.dispatchQueueStep(ctx, ctx.transports, 1)) {
          if (this.isLocalQueueAuthority(ctx.queue.authority)) {
            this.stepQueue(zoneId, 1);
          }
        }
        break;
      case 'queueminus':
        if (mode === 'airplay') {
          airplayInputService.remoteControl(zoneId, 'Previous');
          break;
        }
        if (mode === 'musicassistant') {
          void musicAssistantInputService.playerCommand(zoneId, 'previous');
          break;
        }
        if (!this.isQueueDriven(mode)) {
          break;
        }
        if (!this.dispatchQueueStep(ctx, ctx.transports, -1)) {
          if (this.isLocalQueueAuthority(ctx.queue.authority)) {
            this.stepQueue(zoneId, -1);
          }
        }
        break;
      default:
        break;
    }
  }

  public async startAlert(
    zoneId: number,
    type: string,
    media: AlertMediaResource,
    volume: number,
  ): Promise<void> {
    const ctx = this.zones.get(zoneId);
    if (!ctx) {
      return;
    }

    await this.stopAlert(zoneId);

    await this.waitForOutputReady(ctx);

    const snapshot = this.createAlertSnapshot(ctx);
    const rawDurationMs =
      !media.loop && typeof media.duration === 'number' && media.duration > 0
        ? Math.round(media.duration * 1000)
        : undefined;
    const estimatedStreamMs =
      rawDurationMs !== undefined ? rawDurationMs + ALERT_PRE_DELAY_MS + ALERT_PAD_TAIL_MS : undefined;
    const durationMs =
      estimatedStreamMs !== undefined
        ? Math.max(estimatedStreamMs + ALERT_STOP_MARGIN_MS, MIN_ALERT_DURATION_MS)
        : MIN_ALERT_DURATION_MS;
    const playUrl = media.url;
    const title = media.title ?? type;

    ctx.alert = {
      type,
      title,
      url: playUrl,
      durationMs,
      snapshot,
    };

    this.setInputMode(ctx, 'alert');

    const clampedVolume = clampVolumeForZone(ctx.config, volume);
    ctx.player.setVolume(clampedVolume);

    const metadata: PlaybackMetadata = {
      title,
      artist: '',
      album: '',
      coverurl: '',
      duration: durationMs ? Math.round(durationMs / 1000) : media.duration,
      audiopath: playUrl,
      station: '',
    };

    const session = ctx.player.playUri(playUrl, metadata);
    if (!session) {
      this.log.warn('alert playback skipped; no session', { zoneId, type });
      await this.stopAlert(zoneId);
      return;
    }

    if (durationMs && durationMs > 0) {
      ctx.alert.stopTimer = setTimeout(() => {
        void this.stopAlert(zoneId);
      }, durationMs + 150);
    }

    this.patchState(zoneId, {
      title,
      artist: '',
      album: '',
      coverurl: '',
      audiopath: media.url,
      station: '',
      mode: 'play',
      clientState: 'on',
      power: 'on',
      audiotype: ALERT_AUDIO_TYPE,
      sourceName: ctx.name,
    });
  }

  public async stopAlert(zoneId: number): Promise<void> {
    const ctx = this.zones.get(zoneId);
    const activeAlert = ctx?.alert;
    if (!ctx || !activeAlert) {
      return;
    }
    if (activeAlert.stopTimer) {
      clearTimeout(activeAlert.stopTimer);
    }
    ctx.alert = undefined;

    try {
      ctx.player.stop('alert_stop');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.debug('alert stop failed to stop player cleanly', { zoneId, message });
    }

    this.setInputMode(ctx, activeAlert.snapshot.inputMode);
    ctx.activeOutput = activeAlert.snapshot.activeOutput;
    ctx.activeTransportTypes = new Set(activeAlert.snapshot.activeTransportTypes);
    ctx.queue.shuffle = activeAlert.snapshot.queue.shuffle;
    ctx.queue.repeat = activeAlert.snapshot.queue.repeat;
    ctx.queueController.setItems(
      activeAlert.snapshot.queue.items,
      activeAlert.snapshot.queue.currentIndex,
    );

    const restoreVolume = clampVolumeForZone(ctx.config, activeAlert.snapshot.volume);
    ctx.player.setVolume(restoreVolume);

    this.patchState(zoneId, {
      ...activeAlert.snapshot.statePatch,
      mode: activeAlert.snapshot.mode,
      clientState: 'on',
      power: 'on',
    });

    if (activeAlert.snapshot.mode === 'play') {
      const current = ctx.queueController.current();
      if (current) {
        const session = await this.startQueuePlayback(ctx, current.audiopath, {
          title: current.title,
          artist: current.artist,
          album: current.album,
          coverurl: current.coverurl,
          audiopath: current.audiopath,
          duration: current.duration,
          station: current.station,
          isRadio: isRadioAudiopath(current.audiopath, current.audiotype),
        });
        if (session) {
          const isMusicAssistant = this.isMusicAssistantAudiopath(current.audiopath);
          const resumedAudiotype = isMusicAssistant ? 5 : current.audiotype === 5 ? 0 : current.audiotype;
          const sourceName = resolveSourceName(
            isMusicAssistant ? 5 : current.audiotype,
            ctx,
            current,
          );
          this.patchState(zoneId, {
            title: current.title,
            artist: current.artist,
            album: current.album,
            coverurl: current.coverurl,
            audiopath: current.audiopath,
            station: current.station,
            qindex: ctx.queueController.currentIndex(),
            qid: current.unique_id,
            mode: 'play',
            clientState: 'on',
            power: 'on',
            audiotype: resumedAudiotype,
            ...(sourceName ? { sourceName } : {}),
          });
        }
      }
    } else if (activeAlert.snapshot.mode === 'pause') {
      this.patchState(zoneId, { mode: 'pause', clientState: 'on', power: 'on' });
    } else if (activeAlert.snapshot.mode === 'stop') {
      this.patchState(zoneId, { mode: 'stop', clientState: 'on', power: 'on' });
    }
  }

  private shouldReducePrebuffer(ctx: ZoneContext, audiopath: string): boolean {
    const decoded = decodeAudiopath(audiopath) || audiopath;
    if (!decoded) {
      return false;
    }
    if (!/^https?:/i.test(decoded)) {
      return false;
    }
    if (isRadioAudiopath(audiopath)) {
      return true;
    }
    return ctx.queue.authority === 'local';
  }

  private createAlertSnapshot(ctx: ZoneContext): AlertSnapshot {
    const queueClone = cloneQueueState(ctx.queue);
    return {
      mode: ctx.state.mode,
      inputMode: ctx.inputMode,
      activeOutput: ctx.activeOutput,
      activeTransportTypes: new Set(ctx.activeTransportTypes),
      volume: ctx.state.volume ?? 0,
      queue: queueClone,
      statePatch: {
        title: ctx.state.title,
        artist: ctx.state.artist,
        album: ctx.state.album,
        coverurl: ctx.state.coverurl,
        audiopath: ctx.state.audiopath,
        station: ctx.state.station,
        qindex: ctx.state.qindex,
        qid: ctx.state.qid,
        audiotype: ctx.state.audiotype,
        sourceName: ctx.state.sourceName,
      },
    };
  }

  private async waitForOutputReady(ctx: ZoneContext, timeoutMs = 2000): Promise<void> {
    const outputs = ctx.transports.filter((t) => t.type !== 'spotify-input');
    if (!outputs.length) {
      return;
    }
    const start = Date.now();
    const ready = (): boolean =>
      outputs.some((t) => {
        const maybe = (t as any).isReady;
        if (typeof maybe === 'function') {
          try {
            return maybe.call(t) === true;
          } catch {
            return false;
          }
        }
        return true;
      });
    if (ready()) {
      return;
    }
    return new Promise<void>((resolve) => {
      const tick = () => {
        if (ready() || Date.now() - start >= timeoutMs) {
          resolve();
          return;
        }
        setTimeout(tick, 100);
      };
      setTimeout(tick, 50);
    });
  }

  public patchState(zoneId: number, patch: Partial<LoxoneZoneState>, force = false): void {
    const ctx = this.zones.get(zoneId);
    if (!ctx) {
      return;
    }

    const mergedForType = { ...ctx.state, ...patch } as LoxoneZoneState;
    const isRadioState = isRadioAudiopath(mergedForType.audiopath, mergedForType.audiotype);
    const desiredType = resolveLoxoneType(mergedForType.audiopath, mergedForType.audiotype);
    if (desiredType !== mergedForType.type) {
      patch.type = desiredType;
    }
    if (isRadioState) {
      if (!('audiotype' in patch) || patch.audiotype !== 1) {
        patch.audiotype = 1;
      }
      if (!('time' in patch) || patch.time !== 0) {
        patch.time = 0;
      }
      if (!('duration' in patch) || patch.duration !== 0) {
        patch.duration = 0;
      }
      if (!mergedForType.station?.trim()) {
        const fallbackStation = deriveRadioStationLabel(mergedForType.audiopath);
        if (fallbackStation) {
          patch.station = fallbackStation;
        }
      }
      if ('title' in patch && patch.title) {
        patch.title = '';
      }
    }

    // Prevent overwriting a valid duration with zero/invalid values.
    if ('duration' in patch) {
      const nextDuration = patch.duration;
      const currentDuration = ctx.state.duration;
      if (typeof nextDuration !== 'number' || (!isRadioState && nextDuration <= 0)) {
        delete (patch as any).duration;
      } else if (!isRadioState && typeof currentDuration === 'number' && currentDuration > 0) {
        // keep the larger of the known durations
        (patch as any).duration = Math.max(nextDuration, currentDuration);
      }
    }

    const entries = Object.entries(patch);
    // Skip if nothing actually changes.
    if (!force && !entries.some(([key, value]) => (ctx.state as any)[key] !== value)) {
      return;
    }

    ctx.state = { ...ctx.state, ...patch };

    const isTimeOnlyUpdate = entries.length === 1 && entries[0][0] === 'time';
    const now = Date.now();
    // Avoid blasting Loxone clients with time-only ticks faster than ~1 Hz.
    if (force || !(isTimeOnlyUpdate && now - ctx.lastZoneBroadcastAt < 1000)) {
      ctx.lastZoneBroadcastAt = now;
      notifyZoneStateChanged(ctx.state);
    }
    const session = audioManager.getSession(zoneId);
    if (session) {
      if ('time' in patch || 'duration' in patch) {
        const elapsed = typeof ctx.state.time === 'number' ? ctx.state.time : session.elapsed;
        const duration = typeof ctx.state.duration === 'number' ? ctx.state.duration : session.duration;
        audioManager.updateSessionTiming(zoneId, elapsed, duration);
      }
      const hasMetadataUpdate =
        'title' in patch ||
        'artist' in patch ||
        'album' in patch ||
        'coverurl' in patch ||
        'station' in patch ||
        'audiopath' in patch;
      if (hasMetadataUpdate) {
        const base = session.metadata ?? { title: '', artist: '', album: '' };
        const nextMetadata = {
          title: ctx.state.title || base.title,
          artist: ctx.state.artist || base.artist,
          album: ctx.state.album || base.album,
          coverurl: ctx.state.coverurl || base.coverurl,
          duration: typeof ctx.state.duration === 'number' && ctx.state.duration > 0 ? ctx.state.duration : base.duration,
          audiopath: ctx.state.audiopath || base.audiopath,
          station: ctx.state.station || base.station,
          trackId: base.trackId,
          stationIndex: base.stationIndex,
          queue: base.queue,
          queueIndex: base.queueIndex,
        };
        const prev = session.metadata;
        const unchanged =
          prev &&
          prev.title === nextMetadata.title &&
          prev.artist === nextMetadata.artist &&
          prev.album === nextMetadata.album &&
          prev.coverurl === nextMetadata.coverurl &&
          prev.duration === nextMetadata.duration &&
          prev.audiopath === nextMetadata.audiopath &&
          prev.station === nextMetadata.station;
        if (!unchanged) {
          audioManager.updateSessionMetadata(zoneId, nextMetadata);
        }
      }
    }
    this.notifyTransportMetadata(zoneId, ctx, patch);
  }

  public getMetadata(zoneId: number): Record<string, unknown> | undefined {
    return this.zones.get(zoneId)?.metadata;
  }

  public getTechnicalSnapshot(zoneId: number): {
    inputMode: ZoneContext['inputMode'];
    activeInput: string | null;
    activeOutput: string | null;
    transports: string[];
    outputs: string[];
  } | null {
    const ctx = this.zones.get(zoneId);
    if (!ctx) {
      return null;
    }
    const transports = ctx.transports.map((t) => t.type);
    const outputs =
      ctx.activeOutput !== null
        ? ctx.transports.filter((t) => t.type === ctx.activeOutput).map((t) => t.type)
        : [];
    return {
      inputMode: ctx.inputMode,
      activeInput: ctx.activeInput,
      activeOutput: ctx.activeOutput,
      transports,
      outputs,
    };
  }

  private updateTransportState(
    zoneId: number,
    state: {
      status?: 'playing' | 'paused' | 'stopped';
      position?: number;
      duration?: number;
      uri?: string;
    },
  ): void {
    const ctx = this.zones.get(zoneId);
    if (!ctx) {
      return;
    }
    if (ctx.alert) {
      // Ignore transport updates while an alert is active to avoid clobbering alert metadata.
      return;
    }
    const patch: Partial<LoxoneZoneState> = {};
    if (state.status === 'paused' || state.status === 'stopped') {
      ctx.transportTimingActive = false;
      ctx.lastTransportTimingAt = 0;
    }
    const normalizedUri = state.uri ? normalizeSpotifyAudiopath(state.uri) : null;
    if (normalizedUri && ctx.queue.items.length) {
      const idx = ctx.queue.items.findIndex(
        (item) => normalizeSpotifyAudiopath(item.audiopath) === normalizedUri,
      );
      if (idx >= 0 && idx !== ctx.queue.currentIndex) {
        ctx.queueController.setCurrentIndex(idx);
        const current = ctx.queueController.current();
        if (current) {
          const fallback = fallbackTitle(ctx.state.title, ctx.name);
          patch.title = sanitizeTitle(current.title, fallback);
          patch.artist = current.artist;
          patch.album = current.album;
          patch.coverurl = current.coverurl;
          patch.audiopath = current.audiopath;
          patch.station = current.station;
          patch.qindex = idx;
          patch.qid = current.unique_id;
          patch.audiotype = current.audiotype === 5 ? 0 : current.audiotype;
        }
      }
    }
    if (typeof state.duration === 'number' && state.duration > 0) {
      patch.duration = Math.round(state.duration);
    }
    // Ignore transport-provided position ticks; the player already drives timing,
    // and accepting external time updates can create feedback loops and noisy broadcasts.
    if (state.status === 'paused') {
      patch.mode = 'pause';
      patch.clientState = 'on';
      patch.power = 'on';
    } else if (state.status === 'playing') {
      patch.mode = 'play';
      patch.clientState = 'on';
      patch.power = 'on';
    }
    if (Object.keys(patch).length > 0) {
      this.patchState(zoneId, patch);
    }
  }

  private handlePlaybackError(
    zoneId: number,
    reason: string | undefined,
    source: 'player' | 'transport',
    extraLog?: Record<string, unknown>,
  ): void {
    const ctx = this.zones.get(zoneId);
    if (!ctx) {
      return;
    }
    const normalized = typeof reason === 'string' ? reason.trim() : '';
    if (normalized && IGNORED_PLAYER_ERROR_REASONS.has(normalized)) {
      return;
    }
    const cleaned = normalized ? normalized.replace(/\s+/g, ' ') : '';
    const alias = cleaned ? PLAYBACK_ERROR_ALIASES[cleaned.toLowerCase()] : undefined;
    const detail = alias ?? cleaned;
    const title = detail ? `Playback error: ${detail}` : 'Playback error';
    this.patchState(zoneId, {
      title,
      artist: '',
      album: '',
      station: '',
      time: 0,
      mode: 'stop',
      clientState: 'on',
      power: 'on',
    });
    if (ctx.player.getState().mode !== 'stopped') {
      ctx.player.stop();
    }
    this.log.warn('playback error', { zoneId, reason: cleaned || undefined, source, ...extraLog });
  }

  public setShuffle(zoneId: number, enabled: boolean): void {
    const ctx = this.zones.get(zoneId);
    if (!ctx) {
      return;
    }
    ctx.queue.shuffle = enabled;
    this.patchState(zoneId, { plshuffle: enabled ? 1 : 0 });
  }

  public setRepeatMode(zoneId: number, mode: 'off' | 'one' | 'all'): void {
    const ctx = this.zones.get(zoneId);
    if (!ctx) {
      return;
    }
    const repeat = mode === 'one' ? 1 : mode === 'all' ? 2 : 0;
    ctx.queue.repeat = repeat;
    this.patchState(zoneId, { plrepeat: repeat });
  }

  private registerZone(config: ZoneConfig): void {
    const transports = buildZoneTransports(config);
    const requiresPcm = this.transportsRequirePcm(transports);
    const player = new ZonePlayer(config.id, config.name, config.sourceMac, requiresPcm);
    this.setupPlayerListeners(player, transports, config.id, config.name, config.sourceMac);
    const queue: QueueState = {
      items: [],
      shuffle: false,
      repeat: 0,
      currentIndex: 0,
      authority: 'local',
    };
    const queueController = new QueueController(queue);
    registerPlayer(config.id, player);
    const inputAdapter = new InputAdapter({
      player,
      zoneName: config.name,
      sourceMac: config.sourceMac,
      replaceQueue: (items, startIndex = 0) => {
        queueController.setItems(items, startIndex);
        queue.shuffle = false;
        queue.repeat = 0;
        return queueController.current();
      },
      patchState: (patch) => this.patchState(config.id, patch as any),
    });
    const spotifyAdapter = new SpotifyInputAdapter(inputAdapter, {
      startPlayback: (_zoneId, label, source, metadata) =>
        this.playInputSource(config.id, label, source, metadata),
      updateMetadata: (zoneId, metadata) => this.updateInputMetadata(zoneId, metadata),
      updateCover: (zoneId, cover) => this.updateInputCover(zoneId, cover),
      updateVolume: (zoneId, volume) => this.updateInputVolume(zoneId, volume),
      updateTiming: (zoneId, elapsed, duration) =>
        this.updateInputTiming(zoneId, elapsed, duration),
      pausePlayback: (zoneId) => this.pauseInputSource(zoneId),
      resumePlayback: (zoneId) => this.resumeInputSource(zoneId),
      stopPlayback: (zoneId) => this.stopInputSource(zoneId),
    }, config.id);
    const context: ZoneContext = {
      id: config.id,
      name: config.name,
      sourceMac: config.sourceMac,
      config,
      state: buildInitialState(config),
      metadata: {},
      queue,
      queueController,
      inputAdapter,
      spotifyAdapter,
      transports,
      player,
      transportTimingActive: false,
      lastTransportTimingAt: 0,
      lastZoneBroadcastAt: 0,
      lastPositionUpdateAt: 0,
      lastPositionValue: 0,
      lastMetadataDispatchAt: 0,
      activeTransportTypes: new Set(),
      activeOutput: null,
      activeInput: null,
      inputMode: null,
      alert: undefined,
    };
    this.zones.set(config.id, context);
  }

  private setupPlayerListeners(
    player: ZonePlayer,
    transports: ZoneTransport[],
    zoneId: number,
    zoneName: string,
    sourceMac: string,
  ): void {
    player.on('paused', (session) => {
      const ctxLocal = this.zones.get(zoneId);
      if (ctxLocal) {
        this.dispatchTransports(ctxLocal, transports, 'pause', session);
      }
      this.patchState(zoneId, { mode: 'pause', clientState: 'on', power: 'on' });
    });
    player.on('started', (session) => {
      const ctxReset = this.zones.get(zoneId);
      if (ctxReset) {
        ctxReset.transportTimingActive = false;
        ctxReset.lastTransportTimingAt = 0;
      }
      const ctxLocal = this.zones.get(zoneId);
      if (ctxLocal) {
        this.dispatchTransports(ctxLocal, transports, 'play', session);
      }
      const ctx = this.zones.get(zoneId);
      if (ctx) {
        this.dispatchVolume(ctx, transports, ctx.state.volume);
        const meta = session.metadata ?? ({} as PlaybackMetadata);
        const basePatch: Partial<LoxoneZoneState> = {
          mode: 'play',
          clientState: 'on',
          power: 'on',
          title: sanitizeTitle(meta.title, fallbackTitle(ctx.state.title, ctx.name)),
          artist: meta.artist ?? ctx.state.artist,
          album: meta.album ?? ctx.state.album,
          coverurl: meta.coverurl ?? ctx.state.coverurl,
          audiopath: meta.audiopath ?? ctx.state.audiopath,
          queueAuthority: ctx.queue.authority,
          duration:
            typeof meta.duration === 'number' && meta.duration > 0
              ? Math.max(ctx.state.duration ?? 0, Math.round(meta.duration))
              : ctx.state.duration,
        };
        this.patchState(zoneId, { ...basePatch, ...this.buildActiveItemPatch(ctx) });
      }
    });
    player.on('resumed', (session) => {
      const ctxReset = this.zones.get(zoneId);
      if (ctxReset) {
        ctxReset.transportTimingActive = false;
        ctxReset.lastTransportTimingAt = 0;
      }
      const ctxLocal = this.zones.get(zoneId);
      if (ctxLocal) {
        this.dispatchTransports(ctxLocal, transports, 'resume', session);
      }
      const ctx = this.zones.get(zoneId);
      const itemPatch = ctx ? this.buildActiveItemPatch(ctx) : {};
      this.patchState(zoneId, { mode: 'play', clientState: 'on', power: 'on', ...itemPatch });
    });
    player.on('stopped', (session) => {
      const ctxReset = this.zones.get(zoneId);
      if (ctxReset) {
        ctxReset.transportTimingActive = false;
        ctxReset.lastTransportTimingAt = 0;
      }
      const ctxLocal = this.zones.get(zoneId);
      if (ctxLocal) {
        this.dispatchTransports(ctxLocal, transports, 'stop', session);
      }
      this.patchState(zoneId, { mode: 'stop', clientState: 'on', power: 'on' });
    });
    player.on('position', (time, duration) => {
      const ctx = this.zones.get(zoneId);
      if (!ctx) {
        return;
      }
      if (isRadioAudiopath(ctx.state.audiopath, ctx.state.audiotype)) {
        if (ctx.state.time !== 0 || ctx.state.duration !== 0) {
          this.patchState(zoneId, { time: 0, duration: 0 });
        }
        return;
      }
      const now = Date.now();
      const safeDuration = Math.max(0, duration);
      const safeTime = Math.max(0, Math.min(time, safeDuration || Number.MAX_SAFE_INTEGER));
      const durationChanged =
        safeDuration > 0 &&
        (typeof ctx.state.duration !== 'number' || Math.round(ctx.state.duration) !== safeDuration);
      const withinThrottle = now - ctx.lastPositionUpdateAt < 1000 && safeTime === ctx.lastPositionValue && !durationChanged;
      if (withinThrottle) {
        return;
      }
      ctx.lastPositionUpdateAt = now;
      ctx.lastPositionValue = safeTime;
      this.patchState(zoneId, { time: safeTime, duration: safeDuration > 0 ? safeDuration : undefined });
      if (ctx.transportTimingActive && now - ctx.lastTransportTimingAt < 8000) {
        return;
      }
      if (ctx.transportTimingActive && now - ctx.lastTransportTimingAt >= 8000) {
        ctx.transportTimingActive = false;
      }
    });
    player.on('metadata', (metadata) => {
      const patch: Partial<LoxoneZoneState> = {};
      if (typeof metadata.title === 'string') {
        patch.title = metadata.title;
      }
      if (typeof metadata.artist === 'string') {
        patch.artist = metadata.artist;
      }
      if (typeof metadata.album === 'string') {
        patch.album = metadata.album;
      }
      if (typeof metadata.coverurl === 'string') {
        patch.coverurl = metadata.coverurl;
      }
      if (typeof metadata.duration === 'number' && metadata.duration > 0) {
        patch.duration = Math.max(patch.duration ?? 0, Math.round(metadata.duration));
      }
      if (Object.keys(patch).length > 0) {
        this.patchState(zoneId, patch);
      }
    });
    player.on('cover', (relative) => {
      const coverurl = relative ? `${this.buildAbsoluteCoverUrl(relative)}?t=${Date.now()}` : '';
      if (coverurl) {
        this.patchState(zoneId, { coverurl });
      }
    });
    player.on('volume', (level) => {
      const ctx = this.zones.get(zoneId);
      if (!ctx) {
        return;
      }
      const clamped = clampVolumeForZone(ctx.config, level);
      this.patchState(zoneId, { volume: clamped });
      this.dispatchVolume(ctx, transports, clamped);
    });
    player.on('ended', () => {
      const ctx = this.zones.get(zoneId);
      if (!ctx) {
        return;
      }
      if (ctx.alert) {
        void this.stopAlert(zoneId);
        return;
      }
      void this.handleEndOfTrack(ctx);
    });
    player.on('error', (reason) => {
      this.handlePlaybackError(zoneId, reason, 'player', { zone: zoneName, sourceMac });
    });
  }

  private disposeAllTransports(): void {
    for (const ctx of this.zones.values()) {
      for (const transport of ctx.transports ?? []) {
        try {
          const result = transport.dispose();
          if (result instanceof Promise) {
            void result.catch((error) => {
              this.log.warn('transport dispose failed', {
                zoneId: ctx.id,
                message: (error as Error).message,
              });
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log.warn('transport dispose failed', { zoneId: ctx.id, message });
        }
      }
    }
    clearPlayers();
  }

  private dispatchTransports(
    ctx: ZoneContext,
    transports: ZoneTransport[],
    action: 'play' | 'pause' | 'resume' | 'stop',
    payload: PlaybackSession | null | undefined,
  ): void {
    dispatchTransports(ctx, transports, action, payload, this.log);
  }

  private notifyTransportMetadata(
    zoneId: number,
    ctx: ZoneContext,
    patch: Partial<LoxoneZoneState>,
  ): void {
    // Only trigger when metadata-relevant fields change.
    const touchesMeta =
      'title' in patch ||
      'artist' in patch ||
      'album' in patch ||
      'coverurl' in patch ||
      'duration' in patch ||
      'station' in patch ||
      'sourceName' in patch;
    if (!touchesMeta) {
      return;
    }
    const now = Date.now();
    const patchKeys = Object.keys(patch);
    const isTimeOnly = patchKeys.length === 1 && patchKeys[0] === 'time';
    // Limit pure time ticks to once per second to avoid noisy metadata spam.
    if (isTimeOnly && now - ctx.lastMetadataDispatchAt < 1000) {
      return;
    }
    ctx.lastMetadataDispatchAt = now;
    const session = audioManager.getSession(zoneId);
    const outputTargets =
      ctx.activeOutput !== null
        ? ctx.transports.filter((t) => t.type === ctx.activeOutput)
        : ctx.transports.filter((t) => t.type !== 'spotify-input');
    const controllerTargets = ctx.transports.filter((t) => t.type === 'spotify-input');
    const targets = [...outputTargets, ...controllerTargets];

    this.log.spam('dispatch transport metadata', {
      zoneId,
      activeOutput: ctx.activeOutput,
      targetCount: targets.length,
    });

    for (const transport of targets) {
      if (typeof transport.updateMetadata === 'function') {
        try {
          const result = transport.updateMetadata(session);
          if (result instanceof Promise) {
            void result.catch((err) =>
              this.log.debug('transport metadata update failed', {
                zoneId,
                type: transport.type,
                message: (err as Error)?.message ?? String(err),
              }),
            );
          }
        } catch (err) {
          this.log.debug('transport metadata update failed', {
            zoneId,
            type: transport.type,
            message: (err as Error)?.message ?? String(err),
          });
        }
      }
    }
  }

  private selectPlayOutputs(
    transports: ZoneTransport[],
    _session: PlaybackSession | null,
  ): ZoneTransport[] {
    return selectPlayOutputs(transports);
  }

  private isSpotifyAudiopath(audiopath: string | null | undefined): boolean {
    if (!audiopath) {
      return false;
    }
    const decoded = decodeAudiopath(audiopath) || audiopath;
    const lower = decoded.toLowerCase();
    if (lower.includes('musicassistant')) {
      return false;
    }
    if (this.isAppleMusicAudiopath(decoded)) {
      return false;
    }
    if (this.isDeezerAudiopath(decoded)) {
      return false;
    }
    if (this.isTidalAudiopath(decoded)) {
      return false;
    }
    return lower.includes('spotify:') || lower.startsWith('spotify@');
  }

  private isActiveInput(ctx: ZoneContext, mode: ZoneContext['inputMode']): boolean {
    return ctx.inputMode === mode && ctx.state.mode !== 'stop';
  }

  private isSameAudiopath(ctx: ZoneContext, target: string): boolean {
    if (!target) {
      return false;
    }
    const current = ctx.queueController.current()?.audiopath ?? ctx.state.audiopath ?? '';
    if (!current) {
      return false;
    }
    return normalizeSpotifyAudiopath(current) === normalizeSpotifyAudiopath(target);
  }

  private isAppleMusicAudiopath(audiopath: string | null | undefined): boolean {
    if (!audiopath) {
      return false;
    }
    const raw = String(audiopath);
    const rawProvider = raw.split(':')[0] ?? '';
    if (rawProvider && appleMusicInputService.isAppleMusicProvider(rawProvider)) {
      return true;
    }
    if (raw.toLowerCase().includes('applemusic')) {
      return true;
    }
    const decoded = decodeAudiopath(raw) || raw;
    const providerSegment = decoded.split(':')[0] ?? '';
    if (providerSegment && appleMusicInputService.isAppleMusicProvider(providerSegment)) {
      return true;
    }
    return decoded.toLowerCase().includes('applemusic');
  }

  private isDeezerAudiopath(audiopath: string | null | undefined): boolean {
    if (!audiopath) {
      return false;
    }
    const raw = String(audiopath);
    const rawProvider = raw.split(':')[0] ?? '';
    if (rawProvider && deezerInputService.isDeezerProvider(rawProvider)) {
      return true;
    }
    if (raw.toLowerCase().includes('deezer')) {
      return true;
    }
    const decoded = decodeAudiopath(raw) || raw;
    const providerSegment = decoded.split(':')[0] ?? '';
    if (providerSegment && deezerInputService.isDeezerProvider(providerSegment)) {
      return true;
    }
    return decoded.toLowerCase().includes('deezer');
  }

  private isTidalAudiopath(audiopath: string | null | undefined): boolean {
    if (!audiopath) {
      return false;
    }
    const raw = String(audiopath);
    const rawProvider = raw.split(':')[0] ?? '';
    if (rawProvider && tidalInputService.isTidalProvider(rawProvider)) {
      return true;
    }
    if (raw.toLowerCase().includes('tidal')) {
      return true;
    }
    const decoded = decodeAudiopath(raw) || raw;
    const providerSegment = decoded.split(':')[0] ?? '';
    if (providerSegment && tidalInputService.isTidalProvider(providerSegment)) {
      return true;
    }
    return decoded.toLowerCase().includes('tidal');
  }

  private isMusicAssistantAudiopath(audiopath: string | null | undefined): boolean {
    const providerLower = getMusicAssistantProviderId().toLowerCase();
    const userLower = getMusicAssistantUserId().toLowerCase();
    const matches = (value: string | null | undefined): boolean => {
      if (!value) {
        return false;
      }
      const lower = value.toLowerCase();
      if (lower.startsWith('musicassistant://') || lower.startsWith('musicassistant:') || lower.startsWith('musicassistant@')) {
        return true;
      }
      if (providerLower && (lower.startsWith(providerLower) || lower.startsWith(`${providerLower}:`))) {
        return true;
      }
      if (userLower && (lower.startsWith(`spotify@${userLower}`) || lower.startsWith(`musicassistant@${userLower}`))) {
        return true;
      }
      return lower.includes('musicassistant');
    };
    if (matches(audiopath)) {
      return true;
    }
    const decoded = decodeAudiopath(audiopath ?? '');
    return matches(decoded || audiopath || '');
  }

  /** Resolve a bridge provider from an audiopath like spotify@bridge-<provider>-xyz:... */
  private resolveBridgeProvider(rawAudiopath: string | undefined | null): string | null {
    const raw = (rawAudiopath || '').toLowerCase();
    const match = /^spotify@([^:]+):/.exec(raw);
    const bridgeId = match?.[1] ?? null;
    if (!bridgeId) {
      return null;
    }
    // First, try exact bridge lookup from config.
    try {
      const cfg = getStoredConfig();
      const bridges = cfg?.content?.spotify?.bridges ?? [];
      const bridge = bridges.find((b: any) => String(b?.id ?? '').toLowerCase() === bridgeId);
      const provider = String(bridge?.provider ?? '').trim().toLowerCase();
      if (provider) {
        return provider;
      }
    } catch {
      /* ignore */
    }
    // Fallback: derive provider from id pattern bridge-<provider>-...
    const inferred = /^bridge-([a-z0-9]+)-/.exec(bridgeId)?.[1];
    return inferred || null;
  }

  private dispatchQueueStep(ctx: ZoneContext, transports: ZoneTransport[], delta: number): boolean {
    return dispatchQueueStep(ctx, transports, delta, this.log);
  }

  private dispatchVolume(
    ctx: ZoneContext,
    transports: ZoneTransport[],
    volume: number,
  ): void {
    dispatchVolume(ctx, transports, volume, this.log);
  }

  private updateQueueFromTransport(zoneId: number, items: QueueItem[], currentIndex: number): void {
    const ctx = this.zones.get(zoneId);
    if (!ctx || !Array.isArray(items)) {
      return;
    }
    if (ctx.alert) {
      return;
    }
    if (items.length === 0) {
      // Ignore empty snapshots from transports so we don't wipe the local queue on transient polls.
      return;
    }
    let applyItems = items;
    let applyIndex = currentIndex;
    const existingItems = ctx.queue.items ?? [];

    // If the transport only returns the current item, merge it into the existing queue
    // instead of wiping the full queue that the user built.
    if (items.length === 1 && existingItems.length > 1) {
      const targetIndex = Math.max(
        0,
        Math.min(
          typeof currentIndex === 'number' ? currentIndex : ctx.queueController.currentIndex(),
          existingItems.length - 1,
        ),
      );
      applyItems = existingItems.map((existing, idx) =>
        idx === targetIndex ? { ...existing, ...items[0], qindex: idx } : { ...existing, qindex: idx },
      );
      applyIndex = targetIndex;
      this.log.debug('queue update merged single transport item into existing queue', {
        zoneId,
        targetIndex,
        existing: existingItems.length,
      });
    }

    // Skip queue update if nothing changed (same items and index).
    const buildSignature = (list: QueueItem[]): string =>
      `${list.length}:${list
        .map((item) => normalizeSpotifyAudiopath(item.audiopath ?? '') || '')
        .join('|')}`;
    const newSignature = buildSignature(applyItems);
    const prevSignature = ctx.metadata.lastQueueSignature as string | undefined;
    const prevIndex = ctx.queueController.currentIndex();
    const targetIndex =
      typeof applyIndex === 'number' && applyItems.length
        ? Math.max(0, Math.min(applyIndex, applyItems.length - 1))
        : prevIndex;
    const signatureUnchanged = newSignature === prevSignature && targetIndex === prevIndex;

    const current = signatureUnchanged
      ? ctx.queueController.current()
      : ctx.queueController.updateFromTransport(applyItems, targetIndex);
    if (!current) {
      return;
    }
    const authority = this.resolveQueueAuthorityFromItems(applyItems);
    if (authority) {
      ctx.queue.authority = authority;
    }
    if (!signatureUnchanged) {
      ctx.metadata.lastQueueSignature = newSignature;
      ctx.metadata.lastQueueIndex = ctx.queueController.currentIndex();
      this.log.debug('queue updated from transport', {
        zoneId: ctx.id,
        items: items.length,
        currentIndex: ctx.queueController.currentIndex(),
        authority: ctx.queue.authority,
      });
    }
    const duration =
      typeof current.duration === 'number' && current.duration > 0
        ? current.duration
        : typeof ctx.state.duration === 'number'
          ? ctx.state.duration
          : 0;
    const fallback = fallbackTitle(ctx.state.title, ctx.name);
    const nextTitle = sanitizeTitle(current.title, fallback);
    const useTitle =
      nextTitle !== (ctx.state.title ?? '') || (current.title && !nextTitle.startsWith(ctx.name));
    const isMusicAssistant = this.isMusicAssistantAudiopath(current.audiopath);
    const displayAudiotype = isMusicAssistant
      ? 5
      : current.audiotype === 5
        ? 0
        : current.audiotype;
    const sourceName = resolveSourceName(isMusicAssistant ? 5 : current.audiotype, ctx, current);
    this.patchState(zoneId, {
      ...(useTitle ? { title: nextTitle } : {}),
      artist: current.artist,
      album: current.album,
      coverurl: current.coverurl,
      audiopath: current.audiopath,
      station: current.station,
      qindex: ctx.queueController.currentIndex(),
      qid: current.unique_id,
      audiotype: displayAudiotype,
      duration: duration > 0 ? duration : undefined,
      queueAuthority: ctx.queue.authority,
      ...(sourceName ? { sourceName } : {}),
    });
    if (duration <= 0) {
      void this.resolveTrackDuration(current.audiopath).then((dur) => {
        if (dur > 0) {
          this.patchState(zoneId, { duration: dur });
        }
      });
    }
    if (!isRadioAudiopath(current.audiopath, current.audiotype)) {
      notifyQueueUpdated(zoneId, ctx.queue.items.length);
    }
  }

  private async resolveTrackDuration(audiopath: string): Promise<number> {
    const match = audiopath.match(/^spotify@([^:]+):track:([^/?#]+)/i) ??
      audiopath.match(/^spotify:track:([^/?#]+)/i);
    if (!match) {
      return 0;
    }
    const user = match.length === 3 ? match[1] : '';
    const trackId = match.length === 3 ? match[2] : match[1];
    const track = await contentManager.getServiceTrack('spotify', user, trackId);
    if (track && typeof (track as any).duration === 'number') {
      const d = Math.round((track as any).duration);
      return d > 0 ? d : 0;
    }
    return 0;
  }

  private buildAbsoluteCoverUrl(pathname: string): string {
    if (!pathname) {
      return '';
    }
    if (/^https?:\/\//i.test(pathname)) {
      return pathname;
    }
    const sys = getSystemConfig();
    const host =
      sys.audioserver.ip?.trim() ||
      process.env.PUBLIC_HOST ||
      process.env.HTTP_HOST ||
      '127.0.0.1';
    const port = Number(process.env.HTTP_PORT ?? '7090');
    const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
    return `http://${host}:${port}${normalized}`;
  }

  private stepQueue(zoneId: number, delta: number): void {
    void this.stepQueueAsync(zoneId, delta);
  }

  private async stepQueueAsync(zoneId: number, delta: number): Promise<void> {
    const ctx = this.zones.get(zoneId);
    if (!ctx || ctx.queue.items.length === 0) {
      return;
    }
    if (!this.isLocalQueueAuthority(ctx.queue.authority)) {
      return;
    }

    const nextIndex = ctx.queueController.step(delta);
    if (nextIndex < 0) {
      return;
    }

    const item = ctx.queueController.current();
    if (!item) {
      return;
    }
    const session = await this.startQueuePlayback(ctx, item.audiopath, {
      title: item.title,
      artist: item.artist,
      album: item.album,
      coverurl: item.coverurl,
      audiopath: item.audiopath,
      duration: item.duration,
      station: item.station,
      isRadio: isRadioAudiopath(item.audiopath, item.audiotype),
    });
    if (session) {
      const sourceName = resolveSourceName(item.audiotype ?? getInputAudioType(ctx), ctx, item);
      this.patchState(zoneId, {
        title: item.title,
        artist: item.artist,
        album: item.album,
        coverurl: item.coverurl,
        audiopath: item.audiopath,
        station: item.station,
        qindex: nextIndex,
        qid: item.unique_id,
        mode: 'play',
        clientState: 'on',
        power: 'on',
        audiotype: item.audiotype ?? getInputAudioType(ctx) ?? 0,
        duration: typeof item.duration === 'number' ? Math.max(0, Math.round(item.duration)) : undefined,
        queueAuthority: ctx.queue.authority,
        ...(sourceName ? { sourceName } : {}),
        time: 0,
      });
    }
  }

  private async stopTransports(
    transports: ZoneTransport[],
    session: PlaybackSession | null | undefined,
  ): Promise<void> {
    await Promise.all(
      transports.map(async (transport) => {
        try {
          await transport.stop(session ?? null);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log.warn('transport stop failed', { zoneId: session?.zoneId, message });
        }
      }),
    );
  }

  private async handleEndOfTrack(ctx: ZoneContext): Promise<void> {
    const queueSize = ctx.queue.items.length;
    if (queueSize === 0) {
      const stopped = ctx.player.stop('queue_empty');
      this.dispatchTransports(ctx, ctx.transports, 'stop', stopped);
      return;
    }

    if (!this.isLocalQueueAuthority(ctx.queue.authority)) {
      return;
    }

    const nextIndex = ctx.queueController.nextIndex();

    if (nextIndex < 0) {
      const stopped = ctx.player.stop('queue_end');
      this.dispatchTransports(ctx, ctx.transports, 'stop', stopped);
      return;
    }

    ctx.queueController.setCurrentIndex(nextIndex);
    const next = ctx.queueController.current();
    if (!next) {
      const stopped = ctx.player.stop('queue_invalid_next');
      this.dispatchTransports(ctx, ctx.transports, 'stop', stopped);
      return;
    }
    const session = await this.startQueuePlayback(ctx, next.audiopath, {
      title: next.title,
      artist: next.artist,
      album: next.album,
      coverurl: next.coverurl,
      audiopath: next.audiopath,
      duration: next.duration,
      station: next.station,
    });
    if (session) {
      const sourceName = resolveSourceName(next.audiotype, ctx, next);
      this.patchState(ctx.id, {
        title: next.title,
        artist: next.artist,
        album: next.album,
        coverurl: next.coverurl,
        audiopath: next.audiopath,
        station: next.station,
        qindex: ctx.queueController.currentIndex(),
        qid: next.unique_id,
        mode: 'play',
        clientState: 'on',
        power: 'on',
        audiotype: next.audiotype,
        ...(sourceName ? { sourceName } : {}),
        time: 0,
      });
      void recentsManager.record(ctx.id, next);
      return;
    }

    // If we failed to start the next track, stop cleanly.
    const stopped = ctx.player.stop('queue_next_failed');
    this.dispatchTransports(ctx, ctx.transports, 'stop', stopped);
  }
}

function getInputAudioType(ctx: ZoneContext): number | null {
  const current = ctx.queueController.current();
  const audiopath = current?.audiopath ?? ctx.state.audiopath ?? '';
  const lowerAudiopath = audiopath.toLowerCase();
  const maProvider = getMusicAssistantProviderId().toLowerCase();
  const maUser = getMusicAssistantUserId().toLowerCase();
  // Prefer the active input mode when available, otherwise fall back to URI heuristics.
  if (ctx.inputMode === 'airplay' || audiopath.startsWith('airplay://')) {
    return 4;
  }
  if (ctx.inputMode === 'spotify' || audiopath.startsWith('spotify://') || audiopath.startsWith('spotify:')) {
    return 5;
  }
  if (ctx.inputMode === 'applemusic' || lowerAudiopath.includes('applemusic')) {
    return 5;
  }
  if (ctx.inputMode === 'deezer' || lowerAudiopath.includes('deezer')) {
    return 5;
  }
  if (ctx.inputMode === 'tidal' || lowerAudiopath.includes('tidal')) {
    return 5;
  }
  if (
    ctx.inputMode === 'musicassistant' ||
    lowerAudiopath.startsWith('musicassistant://') ||
    lowerAudiopath.startsWith('musicassistant:') ||
    (maProvider && lowerAudiopath.startsWith(maProvider)) ||
    (maUser && lowerAudiopath.startsWith(`spotify@${maUser}`)) ||
    (maUser && lowerAudiopath.startsWith(`musicassistant@${maUser}`)) ||
    lowerAudiopath.includes('musicassistant')
  ) {
    return 5;
  }
  if (detectServiceFromAudiopath(audiopath) === 'radio') {
    return 1;
  }
  return null;
}

function isRadioAudiopath(audiopath: string | undefined, audiotype?: number | null): boolean {
  if (audiotype === 1 || audiotype === 4) {
    return true;
  }
  const raw = (audiopath ?? '').trim();
  if (!raw) {
    return false;
  }
  if (detectServiceFromAudiopath(raw) === 'radio') {
    return true;
  }
  const decoded = decodeAudiopath(raw);
  if (!decoded) {
    return false;
  }
  return detectServiceFromAudiopath(decoded) === 'radio';
}

function toRadioAudiopath(audiopath: string | undefined): string {
  const raw = (audiopath ?? '').trim();
  if (!raw) {
    return '';
  }
  const lower = raw.toLowerCase();
  if (lower.startsWith('tunein:') || lower.startsWith('radio:')) {
    return raw;
  }
  return encodeAudiopath(raw, 'station', 'tunein', true);
}

function resolveLoxoneType(audiopath: string | undefined, audiotype?: number | null): number {
  return isRadioAudiopath(audiopath, audiotype) ? 2 : 3;
}

function deriveRadioStationLabel(audiopath: string | undefined): string | undefined {
  const raw = (audiopath ?? '').trim();
  if (!raw) {
    return undefined;
  }
  const decoded = decodeAudiopath(raw) ?? raw;
  if (!/^https?:\/\//i.test(decoded)) {
    return undefined;
  }
  try {
    const url = new URL(decoded);
    const host = url.hostname.replace(/^www\./i, '').trim();
    return host || undefined;
  } catch {
    return undefined;
  }
}

function resolveSourceName(
  audiotype: number | null | undefined,
  ctx: ZoneContext,
  current?: QueueItem | null,
): string | undefined {
  if (audiotype === null) {
    return undefined;
  }
  if (audiotype === 4) {
    return ctx.name;
  }
  if (audiotype === 5) {
    const raw =
      current?.audiopath ??
      ctx.queueController.current()?.audiopath ??
      ctx.state.audiopath ??
      '';
    if (ctx.inputMode === 'musicassistant') {
      return stripSpotifyPrefix(getMusicAssistantProviderId()) || 'musicassistant';
    }
    const user =
      (current?.user && current.user !== 'nouser' ? current.user : undefined) ??
      (() => {
        const parsed = parseSpotifyUser(normalizeSpotifyAudiopath(raw));
        return parsed && parsed !== 'nouser' ? parsed : undefined;
      })();
    return user ?? 'nouser';
  }
  return ctx.sourceMac;
}

function sanitizeAudiopathForOutput(audiopath: string): string {
  if (!audiopath) {
    return audiopath;
  }
  if (/^spotify@/i.test(audiopath)) {
    return `spotify:${audiopath.replace(/^spotify@[^:]+:/i, '')}`;
  }
  return audiopath;
}

function stripSpotifyPrefix(value: string): string {
  if (!value) {
    return value;
  }
  return value.toLowerCase().startsWith('spotify@') ? value.slice('spotify@'.length) : value;
}

export const zoneManager = new ZoneManager();
