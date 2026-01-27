import { networkInterfaces } from 'node:os';
import { createLogger } from '@/shared/logging/logger';
import { bestEffort } from '@/shared/bestEffort';
import type { PlaybackSession } from '@/application/playback/audioManager';
import type { HttpPreferences, PreferredOutput, OutputConfigDefinition, ZoneOutput } from '@/ports/OutputsTypes';
import { isHttpUrl } from '@/shared/coverArt';
import { buildBaseUrl, resolveStreamUrl } from '@/shared/streamUrl';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';
import type { CastDevice, DiscoveredDevice, MediaStatusModel } from '@lox-audioserver/node-googlecast';
import { loadGoogleCastModule } from '@/adapters/outputs/googleCast/googlecastLoader';

const DEFAULT_MEDIA_RECEIVER_APP_ID = 'CC1AD845';
export interface GoogleCastOutputConfig {
  host: string;
  name?: string;
  useSendspin?: boolean;
  sendspinNamespace?: string;
  sendspinPlayerId?: string;
  sendspinSyncDelayMs?: number;
}

export const GOOGLE_CAST_OUTPUT_DEFINITION: OutputConfigDefinition = {
  id: 'googleCast',
  label: 'Google Cast',
  description: 'Stream to a Google Cast device using the default media receiver.',
  fields: [],
};

export class GoogleCastOutput implements ZoneOutput {
  public readonly type = 'googleCast';
  private readonly log = createLogger('Output', 'GoogleCast');
  private castDevice: CastDevice | null = null;
  private connected = false;
  private lastLoadAt = 0;
  private lastLoadSignature: string | null = null;
  private lastMediaSessionId: number | null = null;
  private lastMetadataSignature: string | null = null;
  private lastMetadataUpdateAt = 0;
  private lastMetadataLoadAttemptAt = 0;
  private metadataLoadCooldownUntil = 0;
  private lastKnownVolume = 50;
  private lastOutboundVolumeAt: number | null = null;
  private lastOutboundVolume: number | null = null;
  private lastOutboundStateAt: number | null = null;
  private lastOutboundState: 'playing' | 'paused' | 'stopped' | null = null;
  private lastForwardedState: 'playing' | 'paused' | 'stopped' | null = null;
  private suppressRemoteStateUntil = 0;

  constructor(
    private readonly zoneId: number,
    private readonly zoneName: string,
    private readonly config: GoogleCastOutputConfig,
    private readonly ports: OutputPorts,
  ) {}

  public isReady(): boolean {
    return this.connected;
  }

  public async play(session: PlaybackSession): Promise<void> {
    if (!session.playbackSource) {
      this.log.warn('Google Cast output skipped; no playback source', { zoneId: this.zoneId });
      return;
    }
    this.markOutboundState('playing');
    await this.connect();
    await this.loadStream(session);
  }

  public async pause(_session: PlaybackSession | null): Promise<void> {
    if (this.castDevice) {
      // Best-effort pause; cast may reject during transitions.
      this.markOutboundState('paused');
      await bestEffort(() => this.castDevice!.media.pauseCurrent(), {
        fallback: undefined,
        onError: 'debug',
        log: this.log,
        label: 'cast pause failed',
        context: { zoneId: this.zoneId },
      });
      return;
    }
    await this.stopStream();
  }

  public async resume(session: PlaybackSession | null): Promise<void> {
    if (!session) return;
    if (this.castDevice) {
      // Best-effort resume; cast may reject during transitions.
      this.markOutboundState('playing');
      await bestEffort(() => this.castDevice!.media.playCurrent(), {
        fallback: undefined,
        onError: 'debug',
        log: this.log,
        label: 'cast resume failed',
        context: { zoneId: this.zoneId },
      });
      return;
    }
    await this.play(session);
  }

  public async stop(_session: PlaybackSession | null): Promise<void> {
    this.markOutboundState('stopped');
    await this.stopStream();
  }

  public async setPosition(positionMs: number): Promise<void> {
    if (!this.castDevice || !this.lastMediaSessionId) {
      this.log.debug('Google Cast seek skipped; no receiver or session', { zoneId: this.zoneId });
      return;
    }
    const seconds = Math.max(0, positionMs / 1000);
    this.log.debug('Google Cast seek', { zoneId: this.zoneId, seconds });
    await this.castDevice.media.seekCurrent(seconds).catch((err: any) => {
      this.log.debug('Google Cast seek failed', { zoneId: this.zoneId, message: err?.message });
    });
  }

  public async dispose(): Promise<void> {
    await this.stopStream();
    this.disconnect();
  }

  public async setVolume(level: number): Promise<void> {
    if (!this.castDevice) return;
    const volume = Math.max(0, Math.min(1, level / 100));
    this.markOutboundVolume(level);
    await this.castDevice.volume.setVolume(volume).catch((err: any) => {
      this.log.debug('Google Cast setVolume failed', {
        zoneId: this.zoneId,
        message: err?.message,
      });
    });
  }

  public async updateMetadata(session: PlaybackSession | null): Promise<void> {
    if (!session) return;

    const signature = this.buildMediaSignature(session);
    if (signature === this.lastMetadataSignature) {
      return;
    }
    const now = Date.now();
    if (signature === this.lastLoadSignature && now - this.lastLoadAt < 3000) {
      this.lastMetadataSignature = signature;
      this.lastMetadataUpdateAt = now;
      return;
    }
    if (now < this.metadataLoadCooldownUntil) {
      this.lastMetadataSignature = signature;
      this.lastMetadataUpdateAt = now;
      return;
    }
    if (now - this.lastMetadataUpdateAt < 1500) {
      return;
    }
    const meta = (session.metadata ?? {}) as { duration?: number };
    const durationSec = session.duration || meta.duration || 0;
    const isLiveStream = !durationSec || durationSec <= 0;
    if (isLiveStream) {
      // Avoid reloads for live streams; metadata updates require a session update API.
      this.lastMetadataSignature = signature;
      this.lastMetadataUpdateAt = now;
      return;
    }
    if (!this.castDevice) {
      this.lastMetadataSignature = signature;
      this.lastMetadataUpdateAt = now;
      return;
    }
    if (now - this.lastMetadataLoadAttemptAt < 1000) {
      return;
    }
    this.lastMetadataLoadAttemptAt = now;
    await bestEffort(() => this.loadStream(session), {
      fallback: undefined,
      onError: 'debug',
      log: this.log,
      label: 'cast metadata reload failed',
      context: { zoneId: this.zoneId },
    });
    this.lastMetadataSignature = signature;
    this.lastMetadataUpdateAt = now;
  }

  public getPreferredOutput(): PreferredOutput {
    // Cast typically prefers MP3/AAC streams; stick with MP3 profile at 44.1kHz.
    return { profile: 'mp3', sampleRate: 44100, channels: 2, prebufferBytes: 1024 * 256 };
  }

  public getHttpPreferences(): HttpPreferences {
    // Cast is happier with a stable Content-Length; disable ICY metadata.
    return { httpProfile: 'forced_content_length', icyEnabled: false };
  }

  private async connect(): Promise<void> {
    if (this.connected) return;
    const { connect } = await loadGoogleCastModule();
    const device = this.buildDeviceDescriptor();
    const castDevice = await connect(device);
    this.castDevice = castDevice;
    this.connected = true;
    this.log.info('Google Cast connected', { zoneId: this.zoneId, host: this.config.host });
    castDevice.on('disconnected', (err?: Error) => {
      this.log.warn('Google Cast disconnected', {
        zoneId: this.zoneId,
        host: this.config.host,
        message: err?.message,
      });
      this.disconnect();
    });
    castDevice.on('error', (err: Error) => {
      this.log.warn('Google Cast client error', { zoneId: this.zoneId, message: err?.message });
      this.disconnect();
    });
    castDevice.on('mediaStatusModel', (status: MediaStatusModel) => this.handleStatus(status));
    castDevice.on('volumeChanged', (volume) => this.handleVolume(volume));
  }

  private disconnect(): void {
    this.connected = false;
    if (this.castDevice) {
      // Best-effort close; cast clients may already be gone.
      void bestEffort(() => this.castDevice!.disconnect(), {
        fallback: undefined,
        onError: 'debug',
        log: this.log,
        label: 'cast client close failed',
        context: { zoneId: this.zoneId },
      });
    }
    this.castDevice = null;
    this.lastLoadSignature = null;
    this.lastMetadataSignature = null;
    this.lastMediaSessionId = null;
    this.lastLoadAt = 0;
  }

  private async loadStream(session: PlaybackSession): Promise<void> {
    if (!this.castDevice) return;
    const media = this.buildMedia(session);
    const signature = this.buildMediaSignature(session);
    if (this.lastLoadSignature === signature && Date.now() - this.lastLoadAt < 1000) {
      return;
    }

    await this.ensureReceiver();
    const now = Date.now();
    this.suppressRemoteStateUntil = Math.max(this.suppressRemoteStateUntil, now + 3000);
    let loaded = await this.loadMedia(media, {
      autoplay: true,
      currentTime: session.elapsed ? session.elapsed : 0,
    });
    if (!loaded) {
      await this.ensureReceiver();
      loaded = await this.loadMedia(media, {
        autoplay: true,
        currentTime: session.elapsed ? session.elapsed : 0,
      });
    }
    if (!loaded) {
      return;
    }
    this.lastLoadSignature = signature;
    this.lastMetadataSignature = signature;
    this.lastLoadAt = Date.now();
    await this.ensurePlayback();
  }

  private async stopStream(): Promise<void> {
    if (!this.castDevice) return;
    // Best-effort stop; receiver may already be idle.
    await bestEffort(() => this.castDevice!.media.stopCurrent(), {
      fallback: undefined,
      onError: 'debug',
      log: this.log,
      label: 'cast stop failed',
      context: { zoneId: this.zoneId },
    });
  }

  private async ensureReceiver(): Promise<void> {
    if (!this.castDevice) return;
    try {
      await this.castDevice.launchApp(DEFAULT_MEDIA_RECEIVER_APP_ID);
    } catch (err: any) {
      this.log.warn('Google Cast launch error', { zoneId: this.zoneId, message: err?.message });
      throw err;
    }
  }

  private handleStatus(status: MediaStatusModel): void {
    if (!status) return;
    if (typeof status.mediaSessionId === 'number') {
      this.lastMediaSessionId = status.mediaSessionId;
    }
    this.log.debug('Google Cast status', { zoneId: this.zoneId, state: status.playerState });
    const mappedStatus =
      status.playerIsPlaying ? 'playing' : status.playerIsPaused ? 'paused' : status.playerIsIdle ? 'stopped' : undefined;
    if (!mappedStatus) {
      return;
    }
    const duration = typeof status.duration === 'number' ? status.duration : undefined;
    const position = typeof status.currentTime === 'number' ? status.currentTime : undefined;
    const customData = status.mediaCustomData as Record<string, unknown>;
    const uriCandidate =
      customData?.uri ??
      customData?.queue_item_id ??
      status.contentId ??
      undefined;
    const uri = typeof uriCandidate === 'string' ? uriCandidate : undefined;
    this.ports.outputHandlers.onOutputState(this.zoneId, {
      status: mappedStatus,
      position,
      duration,
      uri,
    });
    const ignoreStop =
      mappedStatus === 'stopped' && status.playerIsIdle && status.idleReason === 'FINISHED';
    this.maybeForwardRemoteState(mappedStatus, { ignoreStop });
  }

  private handleVolume(volume?: {
    level?: number;
    muted?: boolean;
    controlType?: 'fixed' | 'attenuation' | 'master';
  }): void {
    if (!volume) return;
    if (typeof volume.level === 'number' && Number.isFinite(volume.level)) {
      const vol = Math.min(100, Math.max(0, Math.round(volume.level * 100)));
      const now = Date.now();
      const recentlySent =
        this.lastOutboundVolumeAt != null && now - this.lastOutboundVolumeAt < 1000;
      const outboundMatches =
        this.lastOutboundVolume != null && Math.abs(vol - this.lastOutboundVolume) <= 1;
      if (recentlySent && outboundMatches) {
        return;
      }
      if (vol !== this.lastKnownVolume) {
        this.lastKnownVolume = vol;
        this.ports.zoneManager.handleCommand(this.zoneId, 'volume_set', String(vol));
      }
    }
    if (typeof volume.muted === 'boolean') {
      if (volume.muted) {
        this.ports.zoneManager.handleCommand(this.zoneId, 'volume_set', '0');
      } else {
        this.ports.zoneManager.handleCommand(
          this.zoneId,
          'volume_set',
          String(this.lastKnownVolume),
        );
      }
    }
  }

  private maybeForwardRemoteState(
    state: 'playing' | 'paused' | 'stopped',
    options?: { ignoreStop?: boolean },
  ): void {
    const now = Date.now();
    if (now < this.suppressRemoteStateUntil) {
      return;
    }
    if (this.lastForwardedState === state) {
      return;
    }
    if (
      this.lastOutboundState === state &&
      this.lastOutboundStateAt != null &&
      now - this.lastOutboundStateAt < 1500
    ) {
      return;
    }
    this.lastForwardedState = state;
    switch (state) {
      case 'playing':
        this.ports.zoneManager.handleCommand(this.zoneId, 'play');
        break;
      case 'paused':
        this.ports.zoneManager.handleCommand(this.zoneId, 'pause');
        break;
      case 'stopped':
        if (options?.ignoreStop) {
          break;
        }
        this.ports.zoneManager.handleCommand(this.zoneId, 'stop');
        break;
      default:
        break;
    }
  }

  private markOutboundVolume(level: number): void {
    this.lastOutboundVolumeAt = Date.now();
    this.lastOutboundVolume = Math.min(100, Math.max(0, Math.round(level)));
  }

  private markOutboundState(state: 'playing' | 'paused' | 'stopped'): void {
    this.lastOutboundStateAt = Date.now();
    this.lastOutboundState = state;
  }

  private buildMedia(session: PlaybackSession): any {
    const { baseUrl, streamUrl } = this.resolveStreamUrls(session);
    const coverUrl = this.resolveCoverUrl(session);
    const meta = (session.metadata ?? {}) as {
      title?: string;
      artist?: string;
      subtitle?: string;
      album?: string;
      station?: string;
      duration?: number;
    };
    const durationSec = session.duration || meta.duration || 0;
    const normalizedDuration = durationSec > 0 ? durationSec : undefined;
    const streamType = normalizedDuration && normalizedDuration > 0 ? 'BUFFERED' : 'LIVE';
    const currentTimeSec = session.elapsed ? session.elapsed : 0;
    return {
      contentId: streamUrl,
      contentType: 'audio/mpeg',
      streamType,
      duration: normalizedDuration,
      currentTime: currentTimeSec,
      metadata: {
        metadataType: 3, // MUSIC_TRACK
        title: meta.title ?? this.zoneName,
        artist: meta.artist ?? meta.subtitle ?? '',
        albumName: meta.album ?? '',
        images: coverUrl ? [{ url: coverUrl }] : [],
        customData: {
          zoneId: this.zoneId,
          source: session.source,
          duration: normalizedDuration || null,
          station: meta.station ?? null,
        },
      },
      customData: {
        baseUrl,
      },
    };
  }

  private buildMediaSignature(session: PlaybackSession): string {
    const { streamUrl, coverUrl } = this.resolveStreamUrls(session);
    const meta = (session.metadata ?? {}) as {
      title?: string;
      artist?: string;
      subtitle?: string;
      album?: string;
    };
    const durationSec = session.duration || (meta as any).duration || 0;
    return JSON.stringify({
      streamUrl,
      title: meta?.title,
      artist: meta?.artist ?? (meta as any)?.subtitle,
      album: (meta as any)?.album,
      coverUrl,
      durationSec,
    });
  }

  private resolveStreamUrls(session: PlaybackSession): { baseUrl: string; streamUrl: string; coverUrl?: string } {
    const baseUrl = this.resolveBaseUrl();
    const streamUrl = resolveStreamUrl({
      baseUrl,
      zoneId: this.zoneId,
      streamPath: session.stream?.url,
      defaultExt: 'mp3',
      prime: '0',
      primeMode: 'upsert',
    });
    return { baseUrl, streamUrl };
  }

  private async loadMedia(
    media: any,
    options: { autoplay?: boolean; currentTime?: number } = {},
  ): Promise<boolean> {
    if (!this.castDevice) return false;
    try {
      const response: any = await this.castDevice.media.load(media.contentId, media.contentType, {
        metadata: media.metadata,
        streamType: media.streamType,
        customData: media.customData,
        autoplay: options.autoplay ?? true,
        startTime: options.currentTime ?? 0,
      });
      const sessionId = response?.status?.[0]?.mediaSessionId;
      if (typeof sessionId === 'number') {
        this.lastMediaSessionId = sessionId;
      }
      this.log.info('Google Cast stream loaded', { zoneId: this.zoneId });
      return true;
    } catch (loadErr: any) {
      this.log.warn('Google Cast load error', { zoneId: this.zoneId, message: loadErr?.message });
      const message = loadErr?.message ?? '';
      if (typeof message === 'string' && message.toLowerCase().includes('load cancelled')) {
        this.metadataLoadCooldownUntil = Date.now() + 3000;
      }
      return false;
    }
  }

  private async ensurePlayback(): Promise<void> {
    try {
      if (!this.castDevice) return;
      const status = await this.castDevice.media.getStatusModel();
      if (typeof status.mediaSessionId === 'number') {
        this.lastMediaSessionId = status.mediaSessionId;
      }
      const shouldPlay = status.mediaSessionId && status.playerState !== 'PLAYING';
      if (shouldPlay) {
        await this.castDevice.media.playCurrent();
      }
    } catch (err: any) {
      this.log.debug('Google Cast play after load failed', {
        zoneId: this.zoneId,
        message: err?.message,
      });
    }
  }

  private resolveBaseUrl(): string {
    const sys = this.ports.config.getSystemConfig() as any;
    return buildBaseUrl({
      host: sys?.audioserver?.ip?.trim(),
      fallbackHost: this.pickLocalAddress(),
    });
  }

  private buildDeviceDescriptor(): DiscoveredDevice {
    const name = this.config.name?.trim() || this.zoneName;
    return {
      id: `googlecast-${this.zoneId}-${this.config.host}`,
      name,
      host: this.config.host,
      port: 8009,
      lastSeen: Date.now(),
    };
  }

  private resolveCoverUrl(session: PlaybackSession): string | undefined {
    const cover = session.metadata?.coverurl;
    if (!cover) {
      return undefined;
    }
    const trimmed = cover.trim();
    if (!trimmed) {
      return undefined;
    }
    return isHttpUrl(trimmed) ? trimmed : undefined;
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
    return '127.0.0.1';
  }
}
