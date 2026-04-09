import { existsSync } from 'node:fs';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@/shared/logging/logger';
import { bestEffort } from '@/shared/bestEffort';
import type {
  GlobalSpotifyConfig,
  SpotifyAccountConfig,
  ZoneConfig,
  ZoneSpotifyConfig,
} from '@/domain/config/types';
import type { SpotifyDeviceRegistry } from '@/adapters/outputs/spotify/deviceRegistry';
import { audioOutputSettings } from '@/ports/types/audioFormat';
import type { PlaybackMetadata, PlaybackSource } from '@/application/playback/audioManager';
import type { SpotifyConnectController } from '@/ports/InputsPort';
import { PassThrough } from 'node:stream';
import { getPlayer } from '@/application/playback/playerRegistry';
import {
  createNativeLibrespotSession,
  getNativeLibrespotStream,
  startNativeConnectHost,
} from '@/adapters/inputs/spotify/spotifyStreamingService';
import type { SpotifyServiceManagerProvider } from '@/adapters/content/providers/spotifyServiceManager';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { LibrespotSession } from '@lox-audioserver/node-librespot';

type AirplaySessionStopper = (zoneId: number, reason?: string) => void;
type OutputErrorHandler = (zoneId: number, reason?: string) => void;

function isValidSpotifyDeviceId(deviceId: string): boolean {
  return /^[0-9a-f]{40}$/i.test((deviceId || '').trim());
}

function stableSpotifyDeviceId(seed: string): string {
  // Spotify/librespot device ids are typically 40-hex (sha1-like). Keep it stable per zone.
  return crypto.createHash('sha1').update(seed).digest('hex');
}

class SpotifyConnectInstance {
  private readonly log = createLogger('Input', `Spotify][${this.zoneName}`);
  private readonly cacheDir: string;
  public accountId: string | undefined;
  private readonly configPort: ConfigPort;
  private readonly spotifyManagers: SpotifyServiceManagerProvider;
  private readonly deviceRegistry: SpotifyDeviceRegistry;
  private readonly stopAirplaySession: AirplaySessionStopper;
  private readonly notifyOutputError: OutputErrorHandler;
  private nativeConnectStream: PassThrough | null = null;
  private nativeConnectStop?: () => void;
  private nativeConnectControls:
    | { play: () => void; pause: () => void; next: () => void; prev: () => void }
    | null = null;

  private nativeSampleRate = audioOutputSettings.sampleRate;
  private nativeChannels = 2;
  private nativeStream: PassThrough | null = null;
  private nativeStreamStop?: () => void;
  // Set during getDirectPlaybackSource() to protect against concurrent Connect stop events.
  private directPlaybackPending = false;
  private nativeSession: LibrespotSession | null = null;
  private nativeSessionAccessToken: string | null = null;
  private nativeSessionClientId: string | null = null;
  private nativeSessionDeviceName: string | null = null;
  private nativeSessionCredentialsHash: string | null = null;
  private credentialsPayload: string | null = null;
  private currentMetadata: PlaybackMetadata | null = null;
  private currentTrackId: string | null = null;
  private hasActiveSession = false;
  private isPaused = false;
  private isActive = false;
  private isReady = false;
  private restarting = false;
  private stopping = false;
  private readonly restartBackoffMs = [4000, 8000, 15000, 30000, 45000, 60000];
  private restartBackoffIndex = 0;
  private restartStreak = { count: 0, firstAt: 0 };
  private readonly restartCooldownMs = 5 * 60 * 1000; // 5 minutes
  private readonly restartStreakWindowMs = 30 * 1000; // 30 seconds
  static accountCredentials = new Map<string, string>();
  private readonly pipeId: string;

  constructor(
    private readonly controller: SpotifyConnectController,
    private readonly zoneId: number,
    private zoneName: string,
    private config: ZoneSpotifyConfig,
    cacheDirOverride: string | undefined,
    accountId: string | undefined,
    private deviceId: string,
    private credentialsPath: string,
    configPort: ConfigPort,
    spotifyManagers: SpotifyServiceManagerProvider,
    deviceRegistry: SpotifyDeviceRegistry,
    stopAirplaySession: AirplaySessionStopper,
    notifyOutputError: OutputErrorHandler,
  ) {
    const cacheRoot = path.join('/tmp', 'lox-librespot');
    this.cacheDir = cacheDirOverride ?? path.join(cacheRoot, String(zoneId), 'cache');
    this.accountId = accountId;
    this.pipeId = `librespot-native-${zoneId}`;
    this.configPort = configPort;
    this.spotifyManagers = spotifyManagers;
    this.deviceRegistry = deviceRegistry;
    this.stopAirplaySession = stopAirplaySession;
    this.notifyOutputError = notifyOutputError;
  }

  public async start(): Promise<void> {
    if (this.config.offload) {
      this.isReady = false;
      return;
    }
    const credPath = this.credentialsPath;
    const deviceId =
      this.deviceRegistry.getSpotifyDeviceId(this.zoneId) ?? this.deviceId ?? `lox-zone-${this.zoneId}`;
    this.deviceId = deviceId;
    const publishName = this.config.publishName || this.zoneName;

    const manager = this.spotifyManagers.get();
    const accessToken = await manager?.getAccessTokenForAccount(this.accountId ?? undefined);
    const canUseToken = Boolean(accessToken);

    const haveCreds = await this.ensureCredentials(credPath, deviceId, publishName);
    if (!haveCreds && !canUseToken) {
      this.log.debug('spotify connect start skipped; no credentials payload or access token');
      this.isReady = false;
      return;
    }
    if (!this.config.enabled) {
      this.isReady = false;
      return;
    }

    const native = await startNativeConnectHost({
      credentialsPath: this.credentialsPayload ?? credPath,
      deviceName: deviceId,
      publishName,
      onEvent: (ev) => this.handleNativeEvent(ev),
      accessToken: accessToken ?? undefined,
      // Do not pass our Web API app client id into librespot.
      // librespot's internal client id defaults are more likely to be accepted for playback/connect.
      clientId: undefined,
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('spotify connect host start failed', { zoneId: this.zoneId, message });
      return null;
    });

    if (!native) {
      this.isReady = false;
      this.scheduleRestart();
      return;
    }

    this.nativeSampleRate = native.sampleRate || audioOutputSettings.sampleRate;
    this.nativeChannels = native.channels || 2;
    this.nativeConnectStream = native.stream as PassThrough;
    this.nativeConnectStop = native.stop;
    this.nativeConnectControls = {
      play: native.play,
      pause: native.pause,
      next: native.next,
      prev: native.prev,
    };
    this.isReady = true;
    this.restartBackoffIndex = 0;
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    this.stopConnectHost();
    this.stopNativeStream(true);
    await this.closeNativeSession('stop');
    this.teardownPlaybackSession();
    this.stopping = false;
    this.isReady = false;
  }

  public updateConfig(config: ZoneSpotifyConfig): void {
    this.config = config;
  }

  public setAccount(accountId?: string): void {
    if (accountId) {
      this.accountId = accountId;
      const payload = SpotifyConnectInstance.accountCredentials.get(accountId);
      if (payload) {
        this.credentialsPayload = payload;
      }
    }
  }

  public async updateZoneName(name: string): Promise<void> {
    this.zoneName = name;
  }

  public updateCredentialPath(cacheDir: string, credPath: string): void {
    this.credentialsPath = credPath;
  }

  public getCredentialState() {
    const hasCredentials = this.credentialsPath.startsWith('/')
      ? existsSync(this.credentialsPath)
      : Boolean(this.credentialsPayload);
    return {
      zoneId: this.zoneId,
      accountId: this.accountId,
      deviceId: this.deviceId,
      credentialsPath: this.credentialsPath,
      cacheDir: this.cacheDir,
      hasCredentials,
      pendingZeroconf: false,
      isReady: this.isReady,
    };
  }

  public setCredentialsPayload(payload: string): void {
    this.credentialsPayload = payload;
  }

  private resolveClientId(accountId?: string): string | null {
    const cfg = this.configPort.getConfig()?.content?.spotify;
    const accId = accountId ?? this.accountId;
    const account = cfg?.accounts?.find(
      (acc) =>
        acc.id === accId || acc.spotifyId === accId || acc.user === accId || acc.email === accId,
    );
    return account?.clientId ?? cfg?.clientId ?? null;
  }

  public getZoneId(): number {
    return this.zoneId;
  }

  private async ensureCredentials(
    credPath: string,
    deviceId: string,
    publishName: string,
  ): Promise<boolean> {
    if (this.accountId) {
      const updated = SpotifyConnectInstance.accountCredentials.get(this.accountId);
      if (updated && updated !== this.credentialsPayload) {
        this.credentialsPayload = updated;
      }
    }
    if (this.accountId && SpotifyConnectInstance.accountCredentials.has(this.accountId)) {
      this.credentialsPayload = SpotifyConnectInstance.accountCredentials.get(this.accountId)!;
      return true;
    }
    if (this.credentialsPayload) {
      return true;
    }
    if (credPath.startsWith('/') && existsSync(credPath)) {
      try {
        this.credentialsPayload = await fsp.readFile(credPath, 'utf8');
        return true;
      } catch {
        /* ignore */
      }
    }
    this.log.warn('spotify credentials missing', {
      zoneId: this.zoneId,
      deviceId,
      publishName,
    });
    return false;
  }

  private scheduleRestart(options?: { minDelayMs?: number; rateLimited?: boolean }): void {
    if (this.restarting || this.stopping) {
      return;
    }
    const now = Date.now();
    if (now - this.restartStreak.firstAt > this.restartStreakWindowMs) {
      this.restartStreak = { count: 0, firstAt: now };
    }
    this.restartStreak.count += 1;
    if (this.restartStreak.count >= 10) {
      this.log.warn('spotify connect restart suppressed after repeated failures', {
        zoneId: this.zoneId,
        attempts: this.restartStreak.count,
        windowMs: this.restartStreakWindowMs,
      });
      setTimeout(() => {
        this.restartStreak = { count: 0, firstAt: Date.now() };
        if (!this.stopping) {
          this.start().catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            this.log.warn('spotify connect restart after cooldown failed', {
              zoneId: this.zoneId,
              message,
            });
          });
        }
      }, this.restartCooldownMs);
      return;
    }
    this.restarting = true;
    const baseDelay =
      this.restartBackoffMs[Math.min(this.restartBackoffIndex, this.restartBackoffMs.length - 1)];
    this.restartBackoffIndex = Math.min(
      this.restartBackoffIndex + 1,
      this.restartBackoffMs.length - 1,
    );
    const rateLimitBoostMs = options?.rateLimited ? 30_000 : 0;
    const minDelayMs = options?.minDelayMs ?? 0;
    const zoneSpreadMs = (this.zoneId % 13) * 500;
    const jitterMs = Math.floor(Math.random() * 1250);
    const delay = Math.max(baseDelay + rateLimitBoostMs + zoneSpreadMs + jitterMs, minDelayMs);
    this.log.debug('spotify connect restart scheduled', {
      zoneId: this.zoneId,
      delayMs: delay,
      baseDelayMs: baseDelay,
      rateLimited: options?.rateLimited === true,
    });
    setTimeout(() => {
      this.restarting = false;
      this.start().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn('spotify connect restart failed', { zoneId: this.zoneId, message });
      });
    }, delay);
  }

  public stopConnectHost(): void {
    if (this.nativeConnectStop) {
      try {
        this.nativeConnectStop();
      } catch {
        /* ignore */
      }
      this.nativeConnectStop = undefined;
    }
    this.nativeConnectStream = null;
    this.nativeConnectControls = null;
    this.isReady = false;
  }

  private handleNativeEvent(ev: any): void {
    if (!ev || typeof ev !== 'object') {
      return;
    }
    const typeRaw = typeof ev.type === 'string' ? ev.type.toLowerCase() : '';
    const trackIdRaw = ev.trackId || ev.track_id || null;
    const trackUri = ev.uri || null;
    const positionMs =
      typeof ev.positionMs === 'number' && Number.isFinite(ev.positionMs) ? ev.positionMs : undefined;
    const durationMs =
      typeof ev.durationMs === 'number' && Number.isFinite(ev.durationMs) ? ev.durationMs : undefined;
    const positionSec =
      positionMs !== undefined ? Math.max(0, Math.round(positionMs / 1000)) : undefined;
    const durationSec =
      durationMs !== undefined ? Math.max(0, Math.round(durationMs / 1000)) : undefined;

    const resolvedTrackId =
      trackIdRaw ||
      this.extractTrackIdFromUri(trackUri || undefined) ||
      this.extractTrackIdFromUri(this.currentMetadata?.audiopath) ||
      this.currentTrackId;

    if (typeRaw === 'error') {
      const message =
        typeof ev.errorMessage === 'string' && ev.errorMessage.length > 0
          ? ev.errorMessage
          : typeof ev.errorCode === 'string' && ev.errorCode.length > 0
            ? ev.errorCode
            : 'playback failed';
      const lowerMessage = message.toLowerCase();
      const rateLimited =
        lowerMessage.includes('429') ||
        lowerMessage.includes('too many requests') ||
        lowerMessage.includes('rate limit');
      if (ev.errorCode === 'audio_key_error') {
        // Audio key errors usually mean the session is unhealthy; trigger a cool-down.
        this.restartStreak = { count: 10, firstAt: Date.now() };
      } else if (lowerMessage.includes('bad_request') || lowerMessage.includes('bad request')) {
        // Likely invalid/insufficient access token scopes; avoid tight loops.
        this.restartStreak = { count: 10, firstAt: Date.now() };
      }
      this.notifyOutputError(this.zoneId, `spotify ${message}`);
      this.stopConnectHost();
      this.scheduleRestart({
        rateLimited,
      });
      return;
    }

    const eventMeta = this.buildMetadataFromNativeEvent(ev, resolvedTrackId, trackUri);

    const shouldBootstrapSession =
      typeRaw !== 'stopped' &&
      typeRaw !== 'error' &&
      (typeRaw === 'playing' ||
        typeRaw === 'started' ||
        typeRaw === 'loading' ||
        typeRaw === 'track_changed' ||
        typeRaw === 'paused' ||
        typeRaw === 'position_correction' ||
        Boolean(eventMeta) ||
        Boolean(trackUri) ||
        Boolean(resolvedTrackId) ||
        positionSec !== undefined ||
        durationSec !== undefined);

    if (
      this.nativeConnectStream &&
      !this.hasActiveSession &&
      !this.stopping &&
      !this.restarting &&
      !this.nativeStreamStop &&
      !this.directPlaybackPending &&
      shouldBootstrapSession
    ) {
      if (resolvedTrackId) {
        this.currentTrackId = resolvedTrackId;
      }
      const seedMeta =
        this.attachTrackInfo(eventMeta ?? this.buildFallbackMetadata(), resolvedTrackId, trackUri) ??
        this.buildFallbackMetadata();
      this.startControllerPlayback(seedMeta);
    }

    if (durationSec !== undefined || positionSec !== undefined) {
      const playerState = this.resolvePlayer(this.zoneId)?.getState?.();
      const fallbackElapsed = playerState?.time ?? 0;
      const fallbackDuration = playerState?.duration ?? this.currentMetadata?.duration ?? 0;
      const nextElapsed = positionSec ?? fallbackElapsed;
      const nextDuration = durationSec ?? fallbackDuration;
      this.controller.updateTiming(this.zoneId, nextElapsed, nextDuration);
    }

    if (!this.hasActiveSession) {
      return;
    }

    if (resolvedTrackId) {
      this.currentTrackId = resolvedTrackId;
    }

    const nextMeta = this.attachTrackInfo(
      eventMeta ?? this.currentMetadata ?? this.buildFallbackMetadata(),
      resolvedTrackId,
      trackUri,
    );
    if (nextMeta) {
      this.applyMetadataUpdate(nextMeta);
    }

    if (typeRaw === 'playing' || typeRaw === 'started') {
      if (this.isPaused) {
        this.isPaused = false;
        this.controller.resumePlayback(this.zoneId);
        this.resolvePlayer(this.zoneId)?.resume();
      }
    } else if (typeRaw === 'paused') {
      this.isPaused = true;
      this.controller.pausePlayback(this.zoneId);
    } else if (typeRaw === 'stopped') {
      this.handleStopped();
    }
  }

  private handleStopped(): void {
    if (!this.hasActiveSession) {
      return;
    }
    this.teardownPlaybackSession(true);
  }

  private applyMetadataUpdate(metadata: PlaybackMetadata): void {
    if (!this.isActive) {
      return;
    }
    const prevMetadata = this.currentMetadata;
    const prevTrackId = prevMetadata?.trackId ?? this.currentTrackId ?? null;
    const nextTrackId = metadata.trackId ?? prevTrackId;
    const prevKey = prevMetadata
      ? `${prevMetadata.title ?? ''}::${prevMetadata.artist ?? ''}::${prevMetadata.album ?? ''}`
      : '';
    const nextKey = `${metadata.title ?? prevMetadata?.title ?? ''}::${metadata.artist ?? prevMetadata?.artist ?? ''}::${metadata.album ?? prevMetadata?.album ?? ''}`;
    const trackChanged =
      (prevTrackId && nextTrackId && prevTrackId !== nextTrackId) ||
      (!prevTrackId && Boolean(nextTrackId)) ||
      (prevKey && nextKey && prevKey !== nextKey);
    this.currentMetadata = metadata;
    this.ensurePlaybackSession(metadata);
    this.controller.updateMetadata(this.zoneId, metadata);
    const player = this.resolvePlayer(this.zoneId);
    player?.updateMetadata(metadata);
    if (metadata.duration !== undefined && trackChanged) {
      this.controller.updateTiming(this.zoneId, 0, metadata.duration);
      player?.updateTiming(0, metadata.duration);
    }
  }

  private extractTrackIdFromUri(trackUri?: string): string | undefined {
    if (!trackUri) {
      return undefined;
    }
    const match = trackUri.match(/spotify:[a-zA-Z]+:([A-Za-z0-9]+)/);
    if (match?.[1]) {
      return match[1];
    }
    if (/^[A-Za-z0-9]+$/.test(trackUri)) {
      return trackUri;
    }
    return undefined;
  }

  private attachTrackInfo(
    metadata: PlaybackMetadata | Partial<PlaybackMetadata> | null | undefined,
    trackId?: string | null,
    trackUri?: string | null,
  ): PlaybackMetadata | null {
    if (!metadata) {
      return null;
    }
    if (!this.isActive && !this.hasActiveSession) {
      return null;
    }
    const next: PlaybackMetadata = {
      title: metadata.title ?? this.zoneName,
      artist: metadata.artist ?? '',
      album: metadata.album ?? '',
      coverurl: metadata.coverurl,
      duration: metadata.duration,
      trackId: metadata.trackId,
      audiopath: metadata.audiopath,
    };
    const resolvedUri =
      trackUri ??
      (next.audiopath && next.audiopath.startsWith('spotify:')
        ? next.audiopath
        : undefined);
    const resolvedId = trackId ?? this.extractTrackIdFromUri(resolvedUri);
    if (resolvedId && !next.trackId) {
      next.trackId = resolvedId;
    }
    if (!next.audiopath) {
      if (resolvedUri?.startsWith('spotify:')) {
        next.audiopath = resolvedUri;
      } else if (resolvedId) {
        next.audiopath = `spotify:track:${resolvedId}`;
      }
    }
    return next;
  }

  public async getDirectPlaybackSource(
    spotifyUri: string,
    seekPositionMs = 0,
  ): Promise<PlaybackSource | null> {
    const manager = this.spotifyManagers.get();
    // Do not force-refresh the token on every track start. Forcing a refresh returns a new token
    // value which causes ensureNativeSession() to close and recreate the librespot session,
    // adding 1-3s of Spotify reconnect latency. The cached token is valid for ~1h; let it expire
    // naturally. Access tokens are only needed when the session itself must be recreated.
    const accessToken = await manager?.getAccessTokenForAccount(this.accountId ?? undefined);
    if (!accessToken) {
      this.log.warn('spotify stream aborted; missing access token', {
        zoneId: this.zoneId,
        hasAccessToken: Boolean(accessToken),
      });
      // Continue when we have stored librespot credentials; access token isn't required then.
    }
    const deviceId = this.deviceId || `lox-zone-${this.zoneId}`;
    const deviceName = deviceId;
    const clientId: string | null = null;
    const credentialsJson = this.credentialsPayload;

    const session = await this.ensureNativeSession({
      accessToken,
      credentialsJson,
      clientId,
      deviceName,
    });
    if (!session) {
      this.log.warn('native librespot session unavailable', { zoneId: this.zoneId });
      return null;
    }

    this.stopNativeStream(false);
    // Guard against Connect 'stopped' events that arrive while the new stream is being set up.
    // These are usually caused by the native session and the Connect host sharing a device ID on
    // Spotify's servers — when the native track starts, Spotify may stop the Connect host.
    this.directPlaybackPending = true;

    const nativeStream = await getNativeLibrespotStream({
      uri: spotifyUri,
      accessToken,
      credentialsJson,
      // Do not pass our Web API app client id into librespot.
      clientId: undefined,
      deviceName,
      bitrate: 320,
      startPositionMs: seekPositionMs > 0 ? Math.round(seekPositionMs) : undefined,
      reuseStream: this.nativeStream,
      reuseSession: session,
      endStreamOnStop: false,
      closeSessionOnStop: false,
      onEvent: (ev: any) => {
        if (!ev || typeof ev !== 'object') {
          return;
        }
        const posSec =
          typeof ev.positionMs === 'number' && Number.isFinite(ev.positionMs)
            ? Math.max(0, Math.round(ev.positionMs / 1000))
            : undefined;
        const durSec =
          typeof ev.durationMs === 'number' && Number.isFinite(ev.durationMs)
            ? Math.max(0, Math.round(ev.durationMs / 1000))
            : undefined;
        if (ev.type === 'error') {
          const message =
            typeof ev.errorMessage === 'string' && ev.errorMessage.length > 0
              ? ev.errorMessage
              : typeof ev.errorCode === 'string' && ev.errorCode.length > 0
                ? ev.errorCode
                : 'playback failed';
          this.notifyOutputError(this.zoneId, `spotify ${message}`);
          this.stopNativeStream(true);
          void this.closeNativeSession('stream_error');
          return;
        }
        if (posSec !== undefined || durSec !== undefined) {
          const playerState = this.resolvePlayer(this.zoneId)?.getState?.();
          const fallbackElapsed = playerState?.time ?? 0;
          const fallbackDuration = playerState?.duration ?? this.currentMetadata?.duration ?? 0;
          const nextElapsed = posSec ?? fallbackElapsed;
          const nextDuration = durSec ?? fallbackDuration;
          this.controller.updateTiming(this.zoneId, nextElapsed, nextDuration);
        }
      },
    });

    if (!nativeStream) {
      this.directPlaybackPending = false;
      this.log.warn('native librespot stream unavailable', { zoneId: this.zoneId });
      if (this.nativeStream) {
        try {
          this.nativeStream.end();
        } catch {
          /* ignore */
        }
        this.nativeStream = null;
      }
      return null;
    }

    this.nativeSampleRate = nativeStream.sampleRate || audioOutputSettings.sampleRate;
    this.nativeChannels = nativeStream.channels || 2;
    this.nativeStream = nativeStream.stream as PassThrough;
    this.nativeStreamStop = () => {
      try {
        nativeStream.stop();
      } catch {
        /* ignore */
      }
    };
    this.directPlaybackPending = false;
    return {
      kind: 'pipe',
      path: this.pipeId,
      format: 's16le',
      sampleRate: this.nativeSampleRate,
      channels: this.nativeChannels,
      // Librespot already outputs in real time; disabling ffmpeg -re removes startup lag.
      realTime: false,
      stream: this.nativeStream,
    };
  }

  public getPlaybackSource(): PlaybackSource {
    if (this.nativeConnectStream) {
      const sampleRate = this.nativeSampleRate || audioOutputSettings.sampleRate;
      return {
        kind: 'pipe',
        path: 'librespot-native-connect',
        format: 's16le',
        sampleRate,
        channels: this.nativeChannels || 2,
        // Source is already paced; avoid extra ffmpeg input pacing.
        realTime: false,
        stream: this.nativeConnectStream,
      };
    }
    if (this.nativeStream) {
      return {
        kind: 'pipe',
        path: this.pipeId,
        format: 's16le',
        sampleRate: this.nativeSampleRate || audioOutputSettings.sampleRate,
        channels: this.nativeChannels || 2,
        realTime: false,
        stream: this.nativeStream,
      };
    }
    return {
      kind: 'pipe',
      path: this.pipeId,
      format: 's16le',
      sampleRate: audioOutputSettings.sampleRate,
      channels: 2,
      realTime: false,
      stream: new PassThrough(),
    };
  }

  private buildFallbackMetadata(): PlaybackMetadata {
    return {
      title: this.zoneName,
      artist: '',
      album: '',
    };
  }

  private buildMetadataFromNativeEvent(
    ev: any,
    trackId: string | null,
    trackUri: string | null,
  ): Partial<PlaybackMetadata> | null {
    if (!ev) {
      return null;
    }
    const title = typeof ev.title === 'string' && ev.title.trim() ? ev.title.trim() : undefined;
    const artist = typeof ev.artist === 'string' && ev.artist.trim() ? ev.artist.trim() : undefined;
    const album = typeof ev.album === 'string' && ev.album.trim() ? ev.album.trim() : undefined;
    const durationMs =
      typeof ev.durationMs === 'number' && Number.isFinite(ev.durationMs) ? ev.durationMs : undefined;
    if (!title && !artist && !album && !durationMs) {
      return null;
    }
    const meta: Partial<PlaybackMetadata> = {};
    if (title) {
      meta.title = title;
    }
    if (artist) {
      meta.artist = artist;
    }
    if (album) {
      meta.album = album;
    }
    if (durationMs && durationMs > 0) {
      meta.duration = Math.round(durationMs / 1000);
    }
    return this.attachTrackInfo(
      meta as PlaybackMetadata,
      trackId ?? this.extractTrackIdFromUri(trackUri ?? undefined),
      trackUri ?? undefined,
    );
  }

  private ensurePlaybackSession(metadata?: PlaybackMetadata | null): void {
    if (this.hasActiveSession) {
      return;
    }
    this.startControllerPlayback(metadata ?? this.buildFallbackMetadata());
  }

  public markSessionActive(metadata?: PlaybackMetadata | null): void {
    this.hasActiveSession = true;
    this.isPaused = false;
    this.isActive = true;
    if (metadata) {
      this.currentMetadata = metadata;
      if (metadata.trackId) {
        this.currentTrackId = metadata.trackId;
      }
    }
  }

  private startControllerPlayback(metadata: PlaybackMetadata): void {
    this.isActive = true;
    try {
      this.stopAirplaySession(this.zoneId, 'switch_to_spotify');
    } catch {
      /* ignore */
    }
    const playbackSource = this.getPlaybackSource();
    this.controller.startPlayback(this.zoneId, 'spotify', playbackSource, metadata);
    this.hasActiveSession = true;
    this.isPaused = false;
    this.currentMetadata = metadata;
    if (metadata.trackId) {
      this.currentTrackId = metadata.trackId;
    }
  }

  private teardownPlaybackSession(keepBlock = false): void {
    const shouldStop = this.hasActiveSession && (this.isActive || this.isPaused);
    // When this is called from a Connect 'stopped' event (keepBlock=true) and a native (direct)
    // stream is already in progress, the stop is almost certainly a Spotify device-conflict
    // artifact: the native session and the Connect host share a device ID, so when the native
    // track starts, Spotify stops the Connect host. Killing the audio session here would produce
    // silence. Just update internal state and leave the stream/session running.
    const hasDirectPlayback = Boolean(this.nativeStreamStop || this.directPlaybackPending);
    if (keepBlock && hasDirectPlayback) {
      this.log.debug('Connect stop event suppressed during native stream playback', {
        zoneId: this.zoneId,
        directPlaybackPending: this.directPlaybackPending,
      });
      this.hasActiveSession = false;
      this.isPaused = false;
      this.isActive = false;
      this.currentMetadata = null;
      return;
    }
    if (shouldStop) {
      this.controller.stopPlayback(this.zoneId);
    }
    this.hasActiveSession = false;
    this.isPaused = false;
    this.isActive = false;
    this.currentMetadata = null;
    if (!keepBlock) {
      this.isReady = false;
    }
    this.stopNativeStream(true);
    void this.closeNativeSession('teardown');
  }

  private stopNativeStream(endStream = false): void {
    if (this.nativeStreamStop) {
      try {
        this.nativeStreamStop();
      } catch {
        /* ignore */
      }
      this.nativeStreamStop = undefined;
    }
    if (endStream && this.nativeStream) {
      try {
        this.nativeStream.end();
      } catch {
        /* ignore */
      }
      this.nativeStream = null;
    }
  }

  private async ensureNativeSession(params: {
    accessToken?: string | null;
    credentialsJson?: string | null;
    clientId: string | null;
    deviceName: string;
  }): Promise<LibrespotSession | null> {
    const { accessToken, credentialsJson, clientId, deviceName } = params;
    const credHash =
      credentialsJson && credentialsJson.trim()
        ? crypto.createHash('sha1').update(credentialsJson).digest('hex')
        : null;

    // Avoid churning sessions for consecutive tracks on the same credentials + device.
    // When stored credentials (credentialsJson) are available, librespot authenticates via the
    // credentials blob, not the OAuth access token. Token rotation should not invalidate the
    // session; only a credentials change warrants a reconnect.
    const authMatches = credHash !== null
      ? this.nativeSessionCredentialsHash === credHash
      : this.nativeSessionAccessToken === (accessToken ?? null);
    if (
      this.nativeSession &&
      authMatches &&
      this.nativeSessionClientId === (clientId ?? null) &&
      this.nativeSessionDeviceName === deviceName
    ) {
      return this.nativeSession;
    }

    await this.closeNativeSession('replace');
    const session = await createNativeLibrespotSession({
      accessToken: accessToken ?? null,
      credentialsJson: credentialsJson ?? null,
      clientId,
      deviceName,
    });
    if (!session) {
      return null;
    }
    this.nativeSession = session;
    this.nativeSessionAccessToken = accessToken ?? null;
    this.nativeSessionCredentialsHash = credHash;
    this.nativeSessionClientId = clientId ?? null;
    this.nativeSessionDeviceName = deviceName;
    return session;
  }

  private async closeNativeSession(reason: string): Promise<void> {
    const session = this.nativeSession;
    if (!session) {
      return;
    }
    this.nativeSession = null;
    this.nativeSessionAccessToken = null;
    this.nativeSessionClientId = null;
    this.nativeSessionDeviceName = null;
    this.nativeSessionCredentialsHash = null;
    try {
      await session.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.debug('native librespot session close failed', { zoneId: this.zoneId, reason, message });
    }
  }

  private resolvePlayer(zoneId: number) {
    return getPlayer(zoneId);
  }
}

export class SpotifyInputService {
  private readonly log = createLogger('Audio', 'SpotifyService');
  private readonly instances = new Map<number, SpotifyConnectInstance>();
  private accountIndex = new Map<string, SpotifyAccountConfig>();
  private controller: SpotifyConnectController | null = null;
  private enabled = false;
  private readonly pendingStartTimers = new Map<number, NodeJS.Timeout>();
  constructor(
    private readonly notifyOutputError: OutputErrorHandler,
    private readonly configPort: ConfigPort,
    private readonly spotifyManagers: SpotifyServiceManagerProvider,
    private readonly deviceRegistry: SpotifyDeviceRegistry,
    private readonly airplaySessionStopper: AirplaySessionStopper,
  ) {}

  public stopActiveSession(zoneId: number, reason?: string): void {
    const instance = this.instances.get(zoneId);
    if (!instance) {
      return;
    }
    this.log.info('forcing spotify session stop', { zoneId, reason });
    const shouldRestart = Boolean(reason?.startsWith('switch_to_'));
    bestEffort(
      async () => {
        await instance.stop();
        return true;
      },
      {
        fallback: false,
        onError: 'debug',
        log: this.log,
        label: 'spotify connect stop failed',
        context: { zoneId },
      },
    ).then((stopped) => {
      if (!stopped || !shouldRestart || !this.enabled) {
        return;
      }
      setTimeout(() => {
        this.queueStart(zoneId, instance, 1000, 'restart_after_stop');
      }, 1500);
    });
  }

  public listCredentialStates(): Array<{
    zoneId: number;
    accountId?: string;
    deviceId?: string;
    credentialsPath: string;
    cacheDir: string;
    hasCredentials: boolean;
    pendingZeroconf: boolean;
    isReady: boolean;
  }> {
    const states: Array<{
      zoneId: number;
      accountId?: string;
      deviceId?: string;
      credentialsPath: string;
      cacheDir: string;
      hasCredentials: boolean;
      pendingZeroconf: boolean;
      isReady: boolean;
    }> = [];
    for (const instance of this.instances.values()) {
      states.push(instance.getCredentialState());
    }
    return states;
  }

  public async applyLibrespotCredentials(
    accountId: string,
    credentials: string | Record<string, unknown>,
  ): Promise<void> {
    const serialized =
      typeof credentials === 'string' ? credentials : JSON.stringify(credentials, null, 2);
    SpotifyConnectInstance.accountCredentials.set(accountId, serialized);
    await bestEffort(
      () =>
        this.configPort.updateConfig((cfg) => {
          const accounts =
            cfg.content?.spotify?.accounts ??
            cfg.inputs?.spotify?.accounts ??
            (cfg.content?.spotify ? (cfg.content.spotify.accounts = []) : undefined);
          if (!accounts) {
            return;
          }
          const target = accounts.find(
            (acc: any) =>
              acc.id === accountId ||
              acc.user === accountId ||
              acc.email === accountId ||
              acc.spotifyId === accountId,
          );
          if (target) {
            (target as any).librespotCredentials = (() => {
              try {
                return typeof credentials === 'string' ? JSON.parse(credentials) : credentials;
              } catch {
                return credentials;
              }
            })();
          }
        }),
      {
        // Best-effort config update; credentials are still cached in memory.
        fallback: undefined,
        onError: 'debug',
        log: this.log,
        label: 'spotify credentials config update failed',
        context: { accountId },
      },
    );

    for (const instance of this.instances.values()) {
      if (instance.accountId !== accountId) {
        continue;
      }
      try {
        instance.setCredentialsPayload(serialized);
        instance.stopConnectHost();
        instance
          .start()
          .then(() => {
            this.log.info('spotify connect reinitialized after credentials update', {
              zoneId: instance.getZoneId(),
              accountId,
            });
          })
          .catch((error) => {
            this.log.warn('spotify connect reinit failed after credentials update', {
              zoneId: instance.getZoneId(),
              accountId,
              message: error instanceof Error ? error.message : String(error),
            });
          });
      } catch (error) {
        this.log.debug('failed to push credentials to instance', {
          zoneId: instance.getZoneId(),
          accountId,
          message: (error as Error).message,
        });
      }
    }
  }

  public configure(controller: SpotifyConnectController): void {
    this.controller = controller;
  }

  public syncZones(zones: ZoneConfig[], spotifyConfig?: GlobalSpotifyConfig | null): void {
    this.configPort.ensureInputs();
    this.enabled = spotifyConfig?.enabled ?? true;
    const inputsEnabled = this.enabled;
    if (!this.controller) {
      this.log.debug('spotify controller not configured; skipping sync');
      return;
    }

    this.accountIndex.clear();
    SpotifyConnectInstance.accountCredentials.clear();
    let accounts = spotifyConfig?.accounts ?? [];
    const storedConfig = this.configPort.getConfig();
    if ((!accounts || accounts.length === 0) && storedConfig?.content?.spotify?.accounts) {
      accounts = storedConfig.content.spotify.accounts;
    }
    accounts.forEach((acc) => {
      if (acc.id) {
        this.accountIndex.set(acc.id, acc);
        if ((acc as any).librespotCredentials) {
          try {
            const raw =
              typeof (acc as any).librespotCredentials === 'string'
                ? (acc as any).librespotCredentials
                : JSON.stringify((acc as any).librespotCredentials, null, 2);
            SpotifyConnectInstance.accountCredentials.set(acc.id, raw);
          } catch {
            /* ignore */
          }
        }
      }
    });
    const defaultAccount = this.resolveAccount();

    const desired = new Set<number>();
    const connectZones = zones.filter((zone) => {
      const config = zone.inputs?.spotify ?? this.buildDefaultZoneConfig(zone);
      const offloadEnabled = config.offload === true;
      return inputsEnabled && Boolean(config.enabled) && !offloadEnabled;
    });
    const connectZoneOrder = new Map<number, number>();
    connectZones.forEach((zone, index) => {
      connectZoneOrder.set(zone.id, index);
    });
    for (const zone of zones) {
      const deviceId =
        typeof zone.inputs?.spotify?.deviceId === 'string' && zone.inputs.spotify.deviceId.trim()
          ? zone.inputs.spotify.deviceId.trim()
          : undefined;

      const ensuredDeviceId = this.ensureDeviceId(zone, deviceId);
      this.deviceRegistry.setSpotifyDeviceId(zone.id, ensuredDeviceId);

      const config = zone.inputs?.spotify ?? this.buildDefaultZoneConfig(zone);
      const offloadEnabled = config.offload === true;
      const connectEnabled = inputsEnabled && Boolean(config?.enabled) && !offloadEnabled;
      const account = this.resolveAccount(config.accountId) ?? defaultAccount;
      const credPath = 'inline';
      desired.add(zone.id);
      const existing = this.instances.get(zone.id);
      if (existing) {
        existing.updateConfig(config);
        existing.setAccount(account?.id);
        existing.updateCredentialPath('inline', credPath);
        if (connectEnabled) {
          const delayMs = this.computeStartupDelay(zone.id, connectZoneOrder.get(zone.id) ?? 0);
          this.queueStart(zone.id, existing, delayMs, 'sync_existing');
        } else {
          this.cancelQueuedStart(zone.id);
          existing.stopConnectHost();
        }
        continue;
      }
      const instance = new SpotifyConnectInstance(
        this.controller,
        zone.id,
        zone.name,
        config,
        'inline',
        account?.id,
        ensuredDeviceId,
        credPath,
        this.configPort,
        this.spotifyManagers,
        this.deviceRegistry,
        this.airplaySessionStopper,
        this.notifyOutputError,
      );
      this.instances.set(zone.id, instance);
      if (connectEnabled) {
        const delayMs = this.computeStartupDelay(zone.id, connectZoneOrder.get(zone.id) ?? 0);
        this.queueStart(zone.id, instance, delayMs, 'sync_new');
      } else {
        this.cancelQueuedStart(zone.id);
        if (inputsEnabled && !offloadEnabled) {
          // Best-effort warm start; failure will be retried via normal lifecycle.
          void bestEffort(() => instance.start(), {
            fallback: undefined,
            onError: 'debug',
            log: this.log,
            label: 'spotify connect warm start failed',
            context: { zoneId: zone.id },
          });
        }
        instance.stopConnectHost();
      }
    }

    for (const zoneId of this.instances.keys()) {
      if (!desired.has(zoneId)) {
        this.removeInstance(zoneId);
      }
    }
  }

  public async shutdown(): Promise<void> {
    this.clearQueuedStarts();
    await Promise.all(
      Array.from(this.instances.values()).map((instance) =>
        // Best-effort shutdown; continue stopping remaining instances.
        bestEffort(() => instance.stop(), {
          fallback: undefined,
          onError: 'debug',
          log: this.log,
          label: 'spotify connect stop failed',
        }),
      ),
    );
    this.instances.clear();
  }

  public async renameZone(zoneId: number, name: string): Promise<void> {
    const instance = this.instances.get(zoneId);
    if (!instance) {
      return;
    }
    await instance.updateZoneName(name);
  }

  private removeInstance(zoneId: number): void {
    this.cancelQueuedStart(zoneId);
    const instance = this.instances.get(zoneId);
    if (!instance) {
      return;
    }
    instance.stop().catch((error) => {
      this.log.warn('failed to stop spotify connect', {
        zoneId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    this.instances.delete(zoneId);
  }

  private disableAllInstances(): void {
    this.clearQueuedStarts();
    for (const [zoneId, instance] of this.instances.entries()) {
      instance.stop().catch((error) => {
        this.log.warn('failed to stop spotify connect', {
          zoneId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
    this.instances.clear();
  }

  private buildDefaultZoneConfig(zone: ZoneConfig): ZoneSpotifyConfig {
    return {
      enabled: true,
      publishName: zone.name,
    };
  }

  public getPlaybackSource(zoneId: number): PlaybackSource | null {
    const instance = this.instances.get(zoneId);
    if (!instance) {
      this.log.debug('playback source unavailable; no spotify instance for zone', { zoneId });
      return null;
    }
    return instance.getPlaybackSource();
  }

  public async streamSpotifyUri(
    spotifyUri: string,
    options: { seekPositionMs?: number; accountId?: string; zoneId?: number } = {},
  ): Promise<{ stream: NodeJS.ReadableStream; playbackSource: PlaybackSource; stop: () => void } | null> {
    const account = this.resolveAccount(options.accountId);
    const manager = this.spotifyManagers.get();
    const accessToken = await manager?.getAccessTokenForAccount(account?.id ?? undefined, true);
    if (!accessToken) {
      this.log.warn('spotify uri stream unavailable; missing access token', {
        spotifyUri,
        accountId: account?.id,
      });
      return null;
    }
    const startPosition =
      options.seekPositionMs && options.seekPositionMs > 0
        ? Math.max(0, Math.round(options.seekPositionMs))
        : undefined;
    const baseDeviceId =
      options.zoneId !== undefined
        ? this.deviceRegistry.getSpotifyDeviceId(options.zoneId)
        : undefined;
    const streamHandle = await getNativeLibrespotStream({
      uri: spotifyUri,
      accessToken,
      deviceName:
        baseDeviceId && isValidSpotifyDeviceId(baseDeviceId)
          ? baseDeviceId
          : stableSpotifyDeviceId(`lox-audioserver:spotify:stream:${options.zoneId ?? 'global'}`),
      bitrate: 320,
      startPositionMs: startPosition,
    });
    if (!streamHandle || !streamHandle.stream) {
      this.log.warn('spotify uri stream unavailable; native librespot stream not ready', {
        spotifyUri,
        accountId: account?.id,
      });
      return null;
    }
    const stop = (): void => {
      try {
        streamHandle.stop();
      } catch {
        /* ignore */
      }
    };
    const stream = streamHandle.stream;
    return {
      stream,
      playbackSource: {
        kind: 'pipe',
        path: 'librespot-native-stream',
        format: 's16le',
        sampleRate: streamHandle.sampleRate || audioOutputSettings.sampleRate,
        channels: streamHandle.channels || 2,
        realTime: false,
        stream,
      },
      stop,
    };
  }

  public markSessionActive(zoneId: number, metadata?: PlaybackMetadata | null): void {
    const instance = this.instances.get(zoneId);
    instance?.markSessionActive(metadata);
  }

  public async getPlaybackSourceForUri(
    zoneId: number,
    spotifyUri: string,
    seekPositionMs = 0,
    accountId?: string,
  ): Promise<PlaybackSource | null> {
    const instance = this.instances.get(zoneId);
    if (!instance) {
      this.log.warn('spotify instance missing for zone', { zoneId });
      return null;
    }
    if (accountId) {
      instance.setAccount(accountId);
    }
    return instance.getDirectPlaybackSource(spotifyUri, seekPositionMs);
  }

  private ensureDeviceId(zone: ZoneConfig, existing?: string): string {
    if (existing && isValidSpotifyDeviceId(existing)) {
      return existing;
    }
    const cfg: any = this.configPort.getConfig();
    const aud = cfg?.system?.audioserver ?? {};
    const serverSeed = (aud?.uuid || aud?.macId || 'lox-audioserver').toString();
    const generated = stableSpotifyDeviceId(`${serverSeed}:spotify:zone:${zone.id}`);
    void this.configPort.updateConfig((cfg) => {
      const target = cfg.zones.find((z) => z.id === zone.id);
      if (!target) {
        return;
      }
      if (!target.inputs) {
        target.inputs = {};
      }
      if (!target.inputs.spotify) {
        target.inputs.spotify = { enabled: true };
      }
      (target.inputs.spotify as any).deviceId = generated;
    }).catch((error) => {
      this.log.debug('failed to persist generated spotify device id', {
        zoneId: zone.id,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return generated;
  }

  private resolveAccount(accountId?: string): SpotifyAccountConfig | undefined {
    if (accountId && this.accountIndex.has(accountId)) {
      return this.accountIndex.get(accountId);
    }
    return Array.from(this.accountIndex.values())[0];
  }

  private queueStart(
    zoneId: number,
    instance: SpotifyConnectInstance,
    delayMs: number,
    reason: 'sync_existing' | 'sync_new' | 'restart_after_stop',
  ): void {
    if (!this.enabled) {
      return;
    }
    this.cancelQueuedStart(zoneId);
    const timer = setTimeout(() => {
      this.pendingStartTimers.delete(zoneId);
      if (this.instances.get(zoneId) !== instance) {
        return;
      }
      instance.start().catch((error) => {
        this.log.warn('failed to start spotify connect', {
          zoneId,
          reason,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }, Math.max(0, Math.round(delayMs)));
    this.pendingStartTimers.set(zoneId, timer);
    this.log.debug('spotify connect start queued', { zoneId, delayMs, reason });
  }

  private cancelQueuedStart(zoneId: number): void {
    const timer = this.pendingStartTimers.get(zoneId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.pendingStartTimers.delete(zoneId);
  }

  private clearQueuedStarts(): void {
    for (const timer of this.pendingStartTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingStartTimers.clear();
  }

  private computeStartupDelay(zoneId: number, connectOrder: number): number {
    // Spread startup attempts to avoid synchronized dealer websocket bursts.
    const orderMs = connectOrder * 5000;
    const zoneSpreadMs = (zoneId % 7) * 175;
    const jitterMs = Math.floor(Math.random() * 500);
    return orderMs + zoneSpreadMs + jitterMs;
  }
}

export async function pushLibrespotCredentials(
  spotifyService: SpotifyInputService,
  accountId: string,
  credentials: string | Record<string, unknown>,
): Promise<void> {
  await spotifyService.applyLibrespotCredentials(accountId, credentials);
}
