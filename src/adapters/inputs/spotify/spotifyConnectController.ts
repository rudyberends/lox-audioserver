import { createLogger } from '@/shared/logging/logger';
import { safeReadText } from '@/shared/bestEffort';
import { decodeAudiopath } from '@/domain/loxone/audiopath';
import type { PlaybackSession } from '@/application/playback/audioManager';
import type { OutputConfigDefinition, ZoneOutput } from '@/ports/OutputsTypes';
import type {
  SpotifyServiceManager,
  SpotifyServiceManagerProvider,
} from '@/adapters/content/providers/spotifyServiceManager';
import type { SpotifyDeviceRegistry } from '@/adapters/outputs/spotify/deviceRegistry';
import type { QueueItem } from '@/application/zones/zoneManager';
import type { ConfigPort } from '@/ports/ConfigPort';

export const SPOTIFY_CONNECT_CONTROLLER_DEFINITION: OutputConfigDefinition = {
  id: 'spotify',
  label: 'Spotify Connect (input controller)',
  description: 'Controls Spotify Connect devices and resolves Spotify URIs to streams.',
  fields: [
    {
      id: 'deviceId',
      label: 'Device ID',
      type: 'text',
      placeholder: '2464e1f81e93e56ee1fa56e1ae086ae25a38e98d',
      description:
        'Optional Spotify Connect device ID to force targeting. Leave empty to match by name.',
    },
    {
      id: 'deviceName',
      label: 'Device name',
      type: 'text',
      placeholder: 'Living Room',
      description:
        'Optional Spotify Connect device name to target. Defaults to the zone name or publishName of the Spotify input.',
    },
  ],
};

type OutputState = {
  status?: 'playing' | 'paused' | 'stopped';
  position?: number;
  duration?: number;
  uri?: string;
};

type OutputHandlers = {
  onQueueUpdate: (zoneId: number, items: QueueItem[], currentIndex: number) => void;
  onOutputError: (zoneId: number, reason?: string) => void;
  onOutputState: (zoneId: number, state: OutputState) => void;
};

interface SpotifyConnectOutputConfig {
  deviceName?: string;
  deviceId?: string;
}

interface SpotifyPlayTarget {
  accountId: string | null;
  uri: string;
}

export class SpotifyConnectInputController implements ZoneOutput {
  // Acts as an input/controller, not an output sink for selection.
  public readonly type = 'spotify-input';

  private readonly log = createLogger('Input', 'SpotifyConnect');
  private readonly metaLog = createLogger('Input', 'SpotifyConnectMeta');
  private readonly deviceName: string;
  private readonly preferredDeviceId?: string;
  private readonly publishName: string;
  private readonly preferredAccountId?: string;
  private readonly configPort: ConfigPort;
  private readonly spotifyManagers: SpotifyServiceManagerProvider;
  private readonly deviceRegistry: SpotifyDeviceRegistry;
  private readonly outputHandlers: OutputHandlers;
  private spotify?: SpotifyServiceManager;
  private readonly pipeActivityWindowMs = 10 * 60 * 1000;
  private lastQueueKeys: string[] = [];
  private lastQueueUris: string[] = [];
  private lastQueueItemCache = new Map<string, QueueItem>();
  private lastSyncedQueueSignature: string | null = null;
  private lastAccountId: string | null = null;
  private lastActiveDeviceId: string | null = null;
  private lastActiveAccountId: string | null = null;
  private lastPipePlay: { uri: string; timestamp: number } | null = null;
  private lastPlayUri: string | null = null;
  private rateLimitUntil = 0;
  private lastValidationAt = 0;
  private validationTimer: NodeJS.Timeout | null = null;
  private pollingEnabled = false;
  private lastNoDeviceWarnAt = 0;
  private readonly invalidDevices = new Map<string, number>();
  private readonly noDeviceWarnIntervalMs = 5000;
  private lastActivationAt = 0;
  private readonly activationTtlMs = 30_000;
  private lastPlayAt = 0;
  private readonly playDebounceMs = 1500;
  private readonly validationIntervalMs = 5_000;
  private readonly pollShutdownGraceMs = 20_000;
  private readonly initialPollDelayMs = 1200;
  private readonly deviceWaitTimeoutMs = 12_000;
  private readonly deviceWaitStepMs = 300;

  private isPipeSession(session: PlaybackSession | null | undefined): boolean {
    return session?.playbackSource?.kind === 'pipe';
  }

  private async waitForDeviceId(
    accountId: string,
    token: string,
    timeoutMs = 5000,
    allowOverride = true,
  ): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    let deviceId = await this.resolveDeviceId(accountId, token, allowOverride);
    while (!deviceId && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.deviceWaitStepMs));
      deviceId = await this.resolveDeviceId(accountId, token, allowOverride);
    }
    if (deviceId) {
      this.log.debug('spotify device id resolved', { zoneId: this.zoneId, deviceId });
    } else {
      this.log.warn('spotify device id unavailable after wait', { zoneId: this.zoneId });
    }
    return deviceId;
  }

  constructor(
    private readonly zoneId: number,
    private readonly zoneName: string,
    config: SpotifyConnectOutputConfig,
    configPort: ConfigPort,
    spotifyManagers: SpotifyServiceManagerProvider,
    deviceRegistry: SpotifyDeviceRegistry,
    outputHandlers: OutputHandlers,
  ) {
    this.deviceName = (config.deviceName || zoneName).trim();
    this.preferredDeviceId = config.deviceId?.trim() || undefined;
    this.publishName = this.deviceName || this.zoneName || 'lox-spotify';
    this.preferredAccountId = undefined;
    this.configPort = configPort;
    this.spotifyManagers = spotifyManagers;
    this.deviceRegistry = deviceRegistry;
    this.outputHandlers = outputHandlers;
    // Pre-seed with a static device id when provided so Connect calls do not wait for librespot to emit it.
    if (this.preferredDeviceId) {
      this.deviceRegistry.setSpotifyDeviceId(this.zoneId, this.preferredDeviceId);
    }
  }

  public async play(session: PlaybackSession): Promise<void> {
    const target = this.extractTarget(session);
    const targetUri = target?.uri ?? null;
    if (this.isPipeSession(session)) {
      this.log.debug('pipe playback detected; skipping spotify connect play', {
        zoneId: this.zoneId,
        uri: targetUri,
      });
      return;
    }
    const now = Date.now();
    const suppressOutputError = this.isPipeSession(session);
    const uri = targetUri;
    this.log.info('spotify play entry', {
      zoneId: this.zoneId,
      uri,
      source: session.source,
      audiopath: session.metadata?.audiopath,
      playbackSource: session.playbackSource?.kind,
      suppressOutputError,
    });
    const sourceLabel = session.source?.toLowerCase?.() ?? '';
    const audiopath = session.metadata?.audiopath?.toLowerCase?.() ?? '';
    const isAirplay = sourceLabel === 'airplay' || sourceLabel.startsWith('airplay://') || audiopath.startsWith('airplay://');
    if (!target && (suppressOutputError || isAirplay)) {
      // Another input (e.g. AirPlay pipe) is active; quiet down Connect.
      this.stopPolling();
      return;
    }
    if (now - this.lastPlayAt < this.playDebounceMs && uri && this.lastPlayUri === uri) {
      this.log.debug('spotify play debounced (same uri recently handled)', {
        zoneId: this.zoneId,
        uri,
      });
      return;
    }
    this.lastPlayAt = now;
    if (uri) {
      this.lastPlayUri = uri;
    }
    this.log.debug('spotify play requested', {
      zoneId: this.zoneId,
      source: session.source,
      audiopath: session.metadata?.audiopath,
      playbackSource: session.playbackSource?.kind,
    });
    if (!target) {
      this.log.warn('spotify play skipped; no valid spotify uri', { zoneId: this.zoneId });
      if (!suppressOutputError) {
        this.outputHandlers.onOutputError(this.zoneId, 'uri');
      }
      return;
    }
    this.log.debug('spotify play target parsed', {
      zoneId: this.zoneId,
      uri: target.uri,
      accountId: target.accountId ?? this.preferredAccountId ?? 'auto',
      suppressOutputError,
    });
    if (suppressOutputError) {
      // Still send a Connect play to the embedded librespot so it fetches the stream.
      const now = Date.now();
      if (this.lastPipePlay && this.lastPipePlay.uri === target.uri && now - this.lastPipePlay.timestamp < 2000) {
        this.log.debug('spotify pipe play deduped', { zoneId: this.zoneId, uri: target.uri });
      }
      this.lastPipePlay = { uri: target.uri, timestamp: now };
    }
    const useOverride = true;
    const auth = await this.resolveAuth(target.accountId);
    if (!auth) {
      this.log.warn('spotify play skipped; missing account/token (login via Spotify needed)', {
        zoneId: this.zoneId,
      });
      if (!suppressOutputError) {
        this.outputHandlers.onOutputError(this.zoneId, 'auth');
      }
      return;
    }
    let deviceId = this.preferredDeviceId ?? this.deviceRegistry.getSpotifyDeviceId(this.zoneId);
    if (deviceId) {
      this.log.debug('spotify device id using preferred/cached', { zoneId: this.zoneId, deviceId });
    }
    if (!deviceId) {
      deviceId = await this.waitForDeviceId(auth.accountId, auth.token, this.deviceWaitTimeoutMs, useOverride);
    }
    if (!deviceId) {
      deviceId = await this.lookupDeviceByName(auth.token);
      if (deviceId) {
        this.deviceRegistry.setSpotifyDeviceId(this.zoneId, deviceId);
        await this.persistDeviceId(deviceId);
      }
    }
    if (!deviceId) {
      this.log.warn('spotify connect play aborted; no device id available (librespot not ready)', {
        zoneId: this.zoneId,
      });
      if (!suppressOutputError) {
        this.outputHandlers.onOutputError(this.zoneId, 'device');
      }
      return;
    }
    const normalizedTarget = this.normalizeUri(target.uri);
    const contextUri = this.normalizeUri(session.metadata?.station ?? '');
    const contextPlay =
      contextUri &&
      this.isContextUri(contextUri) &&
      !contextUri.toLowerCase().startsWith('spotify:artist:')
        ? {
            context_uri: contextUri,
            offset: session.metadata?.stationIndex !== undefined
              ? { position: Number(session.metadata?.stationIndex) || 0 }
              : { uri: normalizedTarget },
          }
        : null;

    let body = contextPlay ?? this.buildPlayPayload(target.uri);

    // If no context, but we have an explicit queue, send it with an offset.
    if (!contextPlay && Array.isArray((session.metadata as any)?.queue) && (session.metadata as any).queue.length > 1) {
      const rawQueue = (session.metadata as any).queue as string[];
      const queueIndex = Number((session.metadata as any).queueIndex ?? 0) || 0;
      const uris = rawQueue.map((u) => this.normalizeUri(u)).filter(Boolean);
      if (uris.length > 1) {
        body = { uris, offset: { position: Math.min(queueIndex, uris.length - 1) } };
      }
    }

    if (!contextPlay) {
      const targetId = normalizedTarget.split(':').pop()?.trim();
      let queueIndex = this.lastQueueKeys.findIndex(
        (key) => key === targetId || key === normalizedTarget || key === target.uri,
      );
      if (queueIndex < 0) {
        queueIndex = this.lastQueueUris.findIndex(
          (uri) => uri === normalizedTarget || uri === target.uri,
        );
      }
      if (queueIndex >= 0 && this.lastQueueKeys.length > 0) {
        const uris =
          this.lastQueueUris.length === this.lastQueueKeys.length
            ? this.lastQueueUris
            : this.lastQueueKeys
                .map((key) => this.lastQueueItemCache.get(key)?.audiopath)
                .filter((uri): uri is string => Boolean(uri));
        if (uris.length === this.lastQueueKeys.length && uris.length > 0) {
          body = { uris, offset: { position: queueIndex } };
        }
      }
    }
    const activated = await this.ensureActiveDevice(
      auth.accountId,
      auth.token,
      deviceId,
      useOverride,
      suppressOutputError,
    );
    if (!activated) {
      this.log.warn('spotify transfer failed', { zoneId: this.zoneId, deviceId });
      if (!suppressOutputError) {
        this.outputHandlers.onOutputError(this.zoneId, 'device');
      }
      this.stopPolling();
      return;
    }
    this.lastActivationAt = Date.now();
    deviceId = activated;
    const ok = await this.transferAndPlay(auth.token, deviceId, body, suppressOutputError);
    if (!ok) {
      if (!suppressOutputError) {
        this.outputHandlers.onOutputError(this.zoneId, 'device');
      }
      this.stopPolling();
      return;
    }
    // For embedded pipe playback (librespot feeding us directly), skip Spotify polling/validation.
    if (suppressOutputError) {
      this.stopPolling();
      this.log.debug('spotify polling skipped for pipe session', { zoneId: this.zoneId });
      return;
    }

    this.pollingEnabled = true;
    this.log.debug('spotify polling enabled after play', { zoneId: this.zoneId, deviceId });
    // Kick off validation/poll loop after a short delay to avoid reverting to stale metadata.
    setTimeout(() => {
      if (!this.pollingEnabled) return;
      void this.validatePlayback(auth.token, auth.accountId, target.uri, true, true);
      this.scheduleValidation(auth.token, auth.accountId, target.uri, true);
    }, this.initialPollDelayMs);
    this.outputHandlers.onOutputState(this.zoneId, {
      status: 'playing',
      position: 0,
      duration: session.metadata?.duration,
      uri: target.uri,
    });
    this.publishLocalQueueState(target.uri, session);
    this.lastAccountId = auth.accountId;
    setTimeout(() => {
      void this.syncQueue(auth.token, auth.accountId, true);
    }, 3000);
    this.log.info('Spotify Connect playback requested', {
      zoneId: this.zoneId,
      zone: this.zoneName,
      uri: target.uri,
      deviceId: deviceId ?? 'unspecified',
      accountId: auth.accountId,
    });
  }

  public async pause(session: PlaybackSession | null): Promise<void> {
    if (!this.isSpotifySession(session)) {
      return;
    }
    if (this.isPipeSession(session)) {
      this.log.debug('pipe playback detected; skipping spotify connect pause', {
        zoneId: this.zoneId,
      });
      return;
    }
    const suppressOutputError = false;
    const auth = await this.resolveAuth(this.extractTarget(session || undefined)?.accountId);
    if (!auth) {
      this.log.warn('spotify pause skipped; missing account/token (login via Spotify needed)', {
        zoneId: this.zoneId,
      });
      return;
    }
    this.lastAccountId = auth.accountId;
    const deviceId =
      (await this.ensureActiveDevice(auth.accountId, auth.token, undefined, true, suppressOutputError)) ||
      (await this.lookupDeviceByName(auth.token));
    if (!deviceId) {
      this.log.warn('spotify pause skipped; no active device available', { zoneId: this.zoneId });
      return;
    }
    const res = await this.apiRequest(
      'PUT',
      this.buildEndpoint('/pause', deviceId),
      auth.token,
      undefined,
      deviceId,
      true,
      suppressOutputError,
    );
    if (res !== null) {
      this.outputHandlers.onOutputState(this.zoneId, { status: 'paused' });
      void this.validatePlayback(auth.token, auth.accountId, this.lastPlayUri ?? '', suppressOutputError, true);
    }
    // Allow poller to continue briefly to pick up external state; then stop to avoid keepalive loops.
    setTimeout(() => this.stopPolling(), this.pollShutdownGraceMs);
  }

  public async resume(session: PlaybackSession | null): Promise<void> {
    if (session && this.isSpotifySession(session)) {
      if (this.isPipeSession(session)) {
        this.log.debug('pipe playback detected; skipping spotify connect resume', {
          zoneId: this.zoneId,
        });
        return;
      }
      await this.play(session);
      return;
    }
    const suppressOutputError = false;
    const auth = await this.resolveAuth();
    if (!auth) {
      this.log.warn('spotify resume skipped; missing account/token (login via Spotify needed)', {
        zoneId: this.zoneId,
      });
      return;
    }
    const deviceId = await this.ensureActiveDevice(
      auth.accountId,
      auth.token,
      undefined,
      true,
      suppressOutputError,
    );
    if (!deviceId) {
      this.log.warn('spotify resume skipped; no active device available', { zoneId: this.zoneId });
      return;
    }
    const ok = await this.transferAndPlay(auth.token, deviceId, {}, suppressOutputError);
    if (ok) {
      if (!this.isPipeSession(session)) {
        this.pollingEnabled = true;
        this.log.debug('spotify polling enabled after resume', { zoneId: this.zoneId, deviceId });
        const uri = this.lastPlayUri ?? '';
        setTimeout(() => {
          if (!this.pollingEnabled) return;
          void this.validatePlayback(auth.token, auth.accountId, uri, true, true);
          this.scheduleValidation(auth.token, auth.accountId, uri, true);
        }, this.initialPollDelayMs);
      } else {
        this.stopPolling();
        this.log.debug('spotify polling skipped for pipe session (resume)', { zoneId: this.zoneId });
      }
      this.outputHandlers.onOutputState(this.zoneId, { status: 'playing' });
    }
  }

  public async stop(session: PlaybackSession | null): Promise<void> {
    // Do not issue Spotify pauses on output-wide stop (often error-driven); just stop local polling.
    if (session === null) {
      // Immediate stop when called without context (e.g. source switch).
      this.stopPolling();
      return;
    }
    if (this.isPipeSession(session)) {
      this.stopPolling();
      this.log.debug('pipe playback detected; skipping spotify connect stop', { zoneId: this.zoneId });
      return;
    }
    if (this.isPipeSession(session)) {
      this.stopPolling();
      this.log.debug('spotify polling stopped immediately for pipe session', { zoneId: this.zoneId });
    } else {
      setTimeout(() => this.stopPolling(), this.pollShutdownGraceMs);
    }
  }

  public async setVolume(level: number): Promise<void> {
    if (this.lastPipePlay && Date.now() - this.lastPipePlay.timestamp < this.pipeActivityWindowMs) {
      return;
    }
    const auth = await this.resolveAuth();
    if (!auth) {
      this.log.warn('spotify volume skipped; missing account/token (login via Spotify needed)', {
        zoneId: this.zoneId,
      });
      return;
    }
    const deviceId = await this.ensureActiveDevice(auth.accountId, auth.token);
    if (!deviceId) {
      this.log.warn('spotify volume skipped; no device id available', { zoneId: this.zoneId });
      return;
    }
    // Preserve fine control at low levels while still giving a small lift to embedded librespot.
    const normalized = Math.min(1, Math.max(0, level / 100));
    const mapped = Math.pow(normalized, 0.8) * 100;
    const clamped = Math.round(Math.max(0, Math.min(100, mapped)));
    await this.apiRequest(
      'PUT',
      this.buildEndpoint(`/volume?volume_percent=${clamped}`, deviceId),
      auth.token,
      undefined,
      deviceId,
    );
  }

  public async setPosition(seconds: number): Promise<void> {
    // Loxone position events fire automatically; avoid issuing Spotify /seek from these to prevent unintended pauses.
    return;
  }

  public dispose(): void {
    this.stopPolling();
  }

  public async stepQueue(delta: number): Promise<void> {
    const auth = await this.resolveAuth();
    if (!auth) {
      this.log.warn('spotify queue step skipped; missing account/token (login via Spotify needed)', {
        zoneId: this.zoneId,
      });
      return;
    }
    const deviceId = await this.ensureActiveDevice(auth.accountId, auth.token, undefined, true, true);
    const endpoint = delta >= 0 ? '/next' : '/previous';
    await this.apiRequest(
      'POST',
      this.buildEndpoint(endpoint, deviceId),
      auth.token,
      undefined,
      deviceId,
    );
    setTimeout(() => {
      void this.syncQueue(auth.token, undefined, true);
    }, 5000);
  }

  private isSpotifySession(session: PlaybackSession | null | undefined): boolean {
    if (!session) {
      return true;
    }
    const sourceDecoded = decodeAudiopath(session.source || '') || session.source || '';
    const metaDecoded = decodeAudiopath(session.metadata?.audiopath || '') || session.metadata?.audiopath || '';
    const check = (value: string) => {
      const lower = value.toLowerCase();
      return lower === 'spotify' || lower.includes('spotify:') || lower.startsWith('spotify@');
    };
    return check(sourceDecoded) || check(metaDecoded);
  }

  private publishLocalQueueState(uri: string, session: PlaybackSession): void {
    const normalized = this.normalizeUri(uri);
    const item: QueueItem = {
      album: session.metadata?.album ?? '',
      artist: session.metadata?.artist ?? '',
      audiopath: normalized,
      audiotype: 5,
      coverurl: session.metadata?.coverurl ?? '',
      duration: session.metadata?.duration ?? 0,
      qindex: 0,
      station: session.metadata?.station ?? '',
      title: session.metadata?.title || this.zoneName,
      unique_id: normalized,
      user: this.lastAccountId || 'spotify',
    };
    this.outputHandlers.onQueueUpdate(this.zoneId, [item], 0);
  }

  private clearValidationTimer(): void {
    if (this.validationTimer) {
      clearTimeout(this.validationTimer);
      this.validationTimer = null;
    }
  }

  private stopPolling(): void {
    if (this.pollingEnabled) {
      this.log.debug('spotify polling disabled', { zoneId: this.zoneId });
    }
    this.pollingEnabled = false;
    this.clearValidationTimer();
  }

  private scheduleValidation(token: string, accountId: string, targetUri: string, suppressOutputError = false): void {
    if (!this.pollingEnabled) {
      this.log.debug('spotify scheduleValidation skipped; polling disabled', { zoneId: this.zoneId });
      return;
    }
    this.clearValidationTimer();
    this.validationTimer = setTimeout(() => {
      this.validationTimer = null;
      void this.validatePlayback(token, accountId, targetUri, suppressOutputError, false);
    }, this.validationIntervalMs);
    this.log.debug('spotify scheduleValidation set', {
      zoneId: this.zoneId,
      inMs: this.validationIntervalMs,
    });
  }

  private async validatePlayback(
    token: string,
    accountId: string,
    targetUri: string,
    suppressOutputError = false,
    force = false,
  ): Promise<void> {
    if (!this.pollingEnabled && !force) {
      return;
    }
    const now = Date.now();
    if (!force && now - this.lastValidationAt < this.validationIntervalMs) {
      return;
    }
    this.lastValidationAt = now;
    this.log.debug('spotify validatePlayback poll', {
      zoneId: this.zoneId,
      force,
      suppressOutputError,
    });
    const snapshot = await this.apiRequest<any>(
      'GET',
      '',
      token,
      undefined,
      undefined,
      {} as any,
      suppressOutputError,
    );
    if (!snapshot) {
      this.log.debug('spotify poll returned empty snapshot', { zoneId: this.zoneId });
      this.scheduleValidation(token, accountId, targetUri, suppressOutputError);
      return;
    }
    const item = snapshot.item;
    const uri = typeof item?.uri === 'string' ? item.uri : null;
    if (!uri) {
      this.log.debug('spotify poll missing item/uri', { zoneId: this.zoneId });
      this.scheduleValidation(token, accountId, targetUri, suppressOutputError);
      return;
    }
    const mapped =
      this.mapTrackToQueueItem(item) ||
      this.mapApiItemToQueueItem(item, item.type === 'episode' ? 'episode' : 'track');
    if (mapped) {
      this.log.debug('spotify poll snapshot', {
        zoneId: this.zoneId,
        uri,
        playing: snapshot.is_playing,
        progress_ms: snapshot.progress_ms,
      });
      this.outputHandlers.onQueueUpdate(this.zoneId, [mapped], 0);
      const position =
        typeof snapshot.progress_ms === 'number' ? Math.max(0, Math.round(snapshot.progress_ms / 1000)) : undefined;
      const duration =
        typeof mapped.duration === 'number' && mapped.duration > 0 ? mapped.duration : undefined;
      this.outputHandlers.onOutputState(this.zoneId, {
        status: snapshot.is_playing ? 'playing' : 'paused',
        position,
        duration,
        uri,
      });
    }
    // Refresh queue periodically as well (low frequency).
    void this.syncQueue(token, accountId, suppressOutputError);
    // keep lightweight periodic updates running
    this.scheduleValidation(token, accountId, targetUri, suppressOutputError);
  }

  private async resolveAuth(accountHint?: string | null): Promise<{
    accountId: string;
    token: string;
  } | null> {
    // First attempt with cached shared manager; on failure refresh once and retry.
    let manager = this.spotify ?? this.spotifyManagers.get();
    this.spotify = manager;
    let accountId = this.pickAccountId(accountHint, manager);
    if (!accountId) {
      manager = this.spotifyManagers.reload();
      this.spotify = manager;
      accountId = this.pickAccountId(accountHint, manager);
      if (!accountId) {
        return null;
      }
    }
    let token = await manager.getAccessTokenForAccount(accountId);
    if (!token) {
      manager = this.spotifyManagers.reload();
      this.spotify = manager;
      token = await manager.getAccessTokenForAccount(accountId);
    }
    if (!token) {
      return null;
    }
    this.spotify = manager;
    return { accountId, token };
  }

  private pickAccountId(
    accountHint: string | null | undefined,
    manager: SpotifyServiceManager,
  ): string | null {
    const candidates = [
      this.preferredAccountId,
      accountHint,
      manager.getDefaultAccountId(),
    ].filter(Boolean) as string[];
    for (const candidate of candidates) {
      if (manager.hasAccount(candidate)) {
        return candidate;
      }
    }
    this.log.warn('no matching spotify account found for output', {
      zoneId: this.zoneId,
      hint: accountHint,
      preferredAccountId: this.preferredAccountId,
    });
    return null;
  }

  private extractTarget(session: PlaybackSession | null | undefined): SpotifyPlayTarget | null {
    if (!session) {
      return null;
    }
    const audiopath = session.metadata?.audiopath?.toLowerCase?.() ?? '';
    // Ignore AirPlay/pipe-only sessions so Connect does not try to commandeer them.
    if (audiopath.startsWith('airplay://') || session.source?.toLowerCase?.() === 'airplay') {
      return null;
    }
    if (session.playbackSource?.kind === 'pipe' && !audiopath) {
      return null;
    }
    const kind = session.playbackSource?.kind?.toLowerCase();
    if (kind && (kind.includes('airplay') || kind.includes('raop') || kind.includes('line'))) {
      return null;
    }
    if (session.source?.toLowerCase?.().startsWith('airplay://')) {
      return null;
    }
    const metadataUri = session.metadata?.audiopath ?? null;
    const candidates = [
      metadataUri,
      session.source,
      session.metadata?.trackId ? `spotify:track:${session.metadata.trackId}` : null,
    ];
    for (const candidate of candidates) {
      const parsed = this.parseSpotifyDescriptor(candidate);
      if (parsed) {
        return parsed;
      }
    }
    return null;
  }

  private parseSpotifyDescriptor(value?: string | null): SpotifyPlayTarget | null {
    if (!value) {
      return null;
    }
    const cleaned = decodeAudiopath(value);
    const segments = cleaned.split('/').filter(Boolean);
    for (const segment of segments) {
      const parsed = this.parseSegment(segment);
      if (parsed) {
        return parsed;
      }
    }
    return this.parseSegment(cleaned);
  }

  private parseSegment(segment: string): SpotifyPlayTarget | null {
    const trimmed = segment.trim();
    if (!trimmed) {
      return null;
    }
    const spotifyAtIndex = trimmed.indexOf('spotify@');
    if (spotifyAtIndex >= 0) {
      const tail = trimmed.slice(spotifyAtIndex);
      const stop = tail.indexOf('/') >= 0 ? tail.slice(0, tail.indexOf('/')) : tail;
      const parts = stop.split(':').filter(Boolean);
      const accountRaw = parts.shift();
      const accountId = accountRaw?.replace(/^spotify@/i, '') ?? null;
      const uriRest = parts.join(':');
      const normalized = this.normalizeUri(uriRest);
      if (accountId && this.isSupportedUri(normalized)) {
        return { accountId, uri: normalized };
      }
    }
    const spotifyIndex = trimmed.indexOf('spotify:');
    if (spotifyIndex >= 0) {
      const tail = trimmed.slice(spotifyIndex);
      const normalized = this.normalizeUri(tail.replace(/^spotify:\/\//i, 'spotify:'));
      if (this.isSupportedUri(normalized)) {
        return { accountId: null, uri: normalized };
      }
    }
    return null;
  }

  private normalizeUri(uri: string): string {
    if (!uri) {
      return uri;
    }
    const cleaned = uri.replace('spotify://', 'spotify:');
    // Handle spotify@user:... → spotify:...
    if (cleaned.startsWith('spotify@')) {
      const withoutPrefix = cleaned.replace(/^spotify@/i, 'spotify:');
      const parts = withoutPrefix.split(':').filter(Boolean);
      const knownTypes = new Set(['track', 'album', 'playlist', 'episode', 'show', 'artist']);
      const typeIndex = parts.findIndex((part) => knownTypes.has(part.toLowerCase()));
      if (typeIndex >= 0) {
        return `spotify:${parts.slice(typeIndex).join(':')}`;
      }
      return `spotify:${parts.slice(1).join(':')}`;
    }
    if (!cleaned.toLowerCase().startsWith('spotify:')) {
      return `spotify:${cleaned}`;
    }
    return cleaned;
  }

  private buildPlayPayload(uri: string): Record<string, unknown> {
    const normalized = this.normalizeUri(uri);
    if (this.isContextUri(normalized)) {
      return { context_uri: normalized };
    }
    return { uris: [normalized] };
  }

  private isContextUri(uri: string): boolean {
    const normalized = this.normalizeUri(uri);
    return (
      normalized.startsWith('spotify:album:') ||
      normalized.startsWith('spotify:playlist:') ||
      normalized.startsWith('spotify:artist:')
    );
  }

  private isSupportedUri(uri: string): boolean {
    // Accept base IDs and full URIs to avoid over-strict filtering.
    const normalized = this.normalizeUri(uri);
    return /^spotify:(track|album|playlist|artist|show|episode):[A-Za-z0-9]/i.test(normalized);
  }

  private parseUriToId(uri: string): { type: 'track' | 'episode'; id: string } | null {
    const normalized = this.normalizeUri(uri);
    const match = normalized.match(/^spotify:(track|episode):([A-Za-z0-9]+)/i);
    if (match?.[1] && match[2]) {
      const type = match[1].toLowerCase() as 'track' | 'episode';
      return { type, id: match[2] };
    }
    return null;
  }

  private async fetchAndPublishMetadata(
    token: string,
    uri: string,
    suppressOutputError = false,
  ): Promise<void> {
    /* deprecated: replaced by validatePlayback */
  }

  private async fetchPlaybackSnapshot(
    token: string,
    suppressOutputError = false,
  ): Promise<void> {
    /* deprecated: replaced by validatePlayback */
  }

  private mapApiItemToQueueItem(
    item: any,
    type: 'track' | 'episode',
  ): QueueItem | null {
    if (!item) return null;
    const title = item.name || '';
    const artist =
      type === 'track'
        ? Array.isArray(item.artists)
          ? item.artists.map((a: any) => a?.name).filter(Boolean).join(', ')
          : ''
        : item.show?.publisher || '';
    const album = type === 'track' ? item.album?.name || '' : item.show?.name || '';
    const coverurl =
      (type === 'track'
        ? item.album?.images?.[0]?.url
        : item.images?.[0]?.url) || '';
    const duration =
      typeof item.duration_ms === 'number'
        ? Math.max(1, Math.round(item.duration_ms / 1000))
        : undefined;
    const uriNormalized: string = item.uri || '';
    const id: string = item.id || uriNormalized;
    if (!uriNormalized) return null;
    return {
      album,
      artist,
      audiopath: uriNormalized,
      audiotype: 5,
      coverurl,
      duration: duration ?? 0,
      qindex: 0,
      station: '',
      title: title || this.zoneName,
      unique_id: id || uriNormalized,
      user: this.lastAccountId || 'spotify',
    };
  }

  private buildEndpoint(base: string, deviceId: string | null): string {
    if (!deviceId) {
      return base;
    }
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}device_id=${encodeURIComponent(deviceId)}`;
  }

  private async ensureActiveDevice(
    accountId: string,
    token: string,
    deviceIdOverride?: string | null,
    allowOverride = true,
    suppressOutputError = false,
  ): Promise<string | null> {
    const nowTs = Date.now();
    // If we recently activated a device and have it cached, skip lookups.
    if (this.lastActiveDeviceId && nowTs - this.lastActivationAt < this.activationTtlMs) {
      return this.lastActiveDeviceId;
    }
    // Prune expired invalid devices
    for (const [id, until] of this.invalidDevices.entries()) {
      if (until <= nowTs) {
        this.invalidDevices.delete(id);
      }
    }
    const orderedCandidates: string[] = [];
    const push = (id?: string | null) => {
      if (id && !orderedCandidates.includes(id)) {
        orderedCandidates.push(id);
      }
    };
    push(deviceIdOverride || null);
    if (allowOverride) {
      push(this.preferredDeviceId);
    }
    if (this.lastActiveDeviceId && this.lastActiveAccountId === accountId) {
      push(this.lastActiveDeviceId);
    }
    push(this.deviceRegistry.getSpotifyDeviceId(this.zoneId));

    const devices = await this.apiRequest<{
      devices: Array<{ id: string; name?: string; type?: string; is_active?: boolean }>;
    }>('GET', '/devices', token, undefined, undefined, undefined, suppressOutputError);

    const list = devices?.devices ?? [];
    const desiredNames = [this.deviceName, this.publishName].filter(Boolean) as string[];
    this.rankDevicesByName(list, desiredNames).forEach((device) => push(device.id));

    for (const candidate of orderedCandidates) {
      if (!candidate || this.invalidDevices.has(candidate)) {
        continue;
      }
      const device = list.find((d) => d.id === candidate);
      if (device?.is_active) {
        this.lastActiveDeviceId = candidate;
        this.lastActiveAccountId = accountId;
        return candidate;
      }

      const transferOk = await this.apiRequest<boolean>(
        'PUT',
        '',
        token,
        // MA-style “claim” of the target device before issuing /play
        { device_ids: [candidate], play: false },
        candidate,
        true,
        suppressOutputError,
      );

      if (transferOk !== null) {
        this.lastActiveDeviceId = candidate;
        this.lastActiveAccountId = accountId;
        return candidate;
      }

      // Device failed; clear learned cache if it is the learned id (but keep explicit overrides).
      if (
        candidate &&
        candidate === this.deviceRegistry.getSpotifyDeviceId(this.zoneId) &&
        candidate !== this.preferredDeviceId
      ) {
        await this.clearPersistedDeviceId(candidate);
      }
      if (candidate) {
        this.invalidDevices.set(candidate, Date.now() + 60_000);
      }
    }

    this.lastActiveDeviceId = null;
    const warnTs = Date.now();
    if (!suppressOutputError && warnTs - this.lastNoDeviceWarnAt > this.noDeviceWarnIntervalMs) {
      this.log.warn('no active spotify device available for zone; login/select device in Spotify app', {
        zoneId: this.zoneId,
      });
      this.lastNoDeviceWarnAt = warnTs;
    }
    return null;
  }

  private async resolveDeviceId(
    accountId: string,
    token: string,
    allowOverride = true,
  ): Promise<string | undefined> {
    // Only use explicit override or the librespot-learned device id.
    if (allowOverride && this.preferredDeviceId) {
      this.log.debug('spotify device id resolved from override', {
        zoneId: this.zoneId,
        deviceId: this.preferredDeviceId,
      });
      return this.preferredDeviceId;
    }
    const learnedId = this.deviceRegistry.getSpotifyDeviceId(this.zoneId);
    if (learnedId) {
      this.log.debug('spotify device id resolved from librespot registration', {
        zoneId: this.zoneId,
        deviceId: learnedId,
      });
      return learnedId;
    }
    // Fallback: query active devices and match by configured name.
    const devices = await this.apiRequest<{
      devices: Array<{ id: string; name?: string; type?: string; is_active?: boolean }>;
    }>(
      'GET',
      '/devices',
      token,
    );
    if (devices?.devices?.length) {
      const matches = this.rankDevicesByName(devices.devices, [this.deviceName, this.publishName]);
      const match = matches[0];
      if (match?.id) {
        this.deviceRegistry.setSpotifyDeviceId(this.zoneId, match.id);
        await this.persistDeviceId(match.id);
        this.log.debug('spotify device id resolved from /devices', {
          zoneId: this.zoneId,
          deviceId: match.id,
          name: match.name,
        });
        return match.id;
      }
    }
    return undefined;
  }

  private async persistDeviceId(deviceId: string): Promise<void> {
    try {
      await this.configPort.updateConfig((config) => {
        const zone = config.zones.find((z) => z.id === this.zoneId);
        if (!zone) return;
        if (!zone.inputs) zone.inputs = {};
        if (!zone.inputs.spotify) {
          zone.inputs.spotify = { enabled: true, deviceId };
          return;
        }
        zone.inputs.spotify.deviceId = deviceId;
      });
      this.log.debug('spotify device id persisted to config', { zoneId: this.zoneId, deviceId });
    } catch {
      // Best-effort; ignore failures.
    }
  }

  private async clearPersistedDeviceId(deviceId: string): Promise<void> {
    this.deviceRegistry.clearSpotifyDeviceId(this.zoneId);
    try {
      await this.configPort.updateConfig((config) => {
        const zone = config.zones.find((z) => z.id === this.zoneId);
        if (!zone?.inputs?.spotify) return;
        if (zone.inputs.spotify.deviceId === deviceId) {
          delete zone.inputs.spotify.deviceId;
        }
      });
      this.log.warn('spotify device id cleared due to API 404', { zoneId: this.zoneId, deviceId });
    } catch {
      /* ignore */
    }
  }

  private async syncQueue(token: string, accountId?: string, suppressOutputError = true): Promise<void> {
    if (accountId) {
      this.lastAccountId = accountId;
    }
    const queue = await this.apiRequest<{ currently_playing?: any; queue?: any[] }>(
      'GET',
      '/queue',
      token,
      undefined,
      undefined,
      undefined,
      suppressOutputError,
    );
    if (!queue) {
      return;
    }
    const mappedCurrent =
      queue.currently_playing?.type === 'track' ? this.mapTrackToQueueItem(queue.currently_playing) : null;
    const mappedQueue: QueueItem[] = [];
    for (const entry of queue.queue ?? []) {
      if (entry?.type !== 'track') continue;
      const mapped = this.mapTrackToQueueItem(entry);
      if (mapped) mappedQueue.push(mapped);
    }

    const items: QueueItem[] = [];
    const keys: string[] = [];
    let idx = 0;
    const normalized = (uri: string | undefined) => (uri ? this.normalizeUri(uri) : '');

    // Avoid duplicating current track if Spotify already returns it at head of queue.
    const queueHeadMatchesCurrent =
      mappedCurrent && mappedQueue.length > 0
        ? normalized(mappedCurrent.audiopath) === normalized(mappedQueue[0].audiopath)
        : false;

    const sourceItems = queueHeadMatchesCurrent ? mappedQueue : [mappedCurrent, ...mappedQueue].filter(Boolean);

    for (const item of sourceItems) {
      if (!item) continue;
      const unique = `${item.unique_id || item.audiopath || 'item'}_${idx}`;
      items.push({ ...item, unique_id: unique, qindex: idx });
      keys.push(unique);
      idx += 1;
    }
    const uniquePaths = Array.from(new Set(items.map((i) => this.normalizeUri(i.audiopath))));
    if (items.length > 1 && uniquePaths.length === 1) {
      items.length = 1;
      keys.length = 1;
    }

    const signature = `${items.length}:${items.map((i) => this.normalizeUri(i.audiopath)).join('|')}`;
    if (signature === this.lastSyncedQueueSignature) {
      return;
    }
    this.lastSyncedQueueSignature = signature;
    this.lastQueueKeys = keys;
    this.lastQueueUris = items.map((i) => i.audiopath);
    this.lastQueueItemCache.clear();
    items.forEach((item) => this.lastQueueItemCache.set(item.unique_id, item));
    this.outputHandlers.onQueueUpdate(this.zoneId, items, 0);
  }

  private mapTrackToQueueItem(track: any): QueueItem | null {
    if (!track || track.type !== 'track') {
      return null;
    }
    const title = track.name ?? '';
    const artist = Array.isArray(track.artists)
      ? track.artists.map((a: any) => a?.name).filter(Boolean).join(', ')
      : '';
    const album = track.album?.name ?? '';
    const coverurl = track.album?.images?.[0]?.url ?? '';
    const duration =
      typeof track.duration_ms === 'number' ? Math.max(1, Math.round(track.duration_ms / 1000)) : 120;
    const uri: string = track.uri || (track.id ? `spotify:track:${track.id}` : '');
    if (!uri) {
      return null;
    }
    return {
      album,
      artist,
      audiopath: uri,
      audiotype: 5,
      coverurl,
      duration,
      qindex: 0,
      station: '',
      title: title || this.zoneName,
      unique_id: track.id || uri,
      user: this.lastAccountId || 'spotify',
    };
  }


  private isDeviceIdCandidate(value: string): boolean {
    const trimmed = value.trim();
    return /^[0-9a-f]{32,64}$/i.test(trimmed);
  }

  private async apiRequest<T>(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    endpoint: string,
    token: string,
    body?: unknown,
    currentDeviceId?: string | null,
    succeedOnNoContent?: T,
    suppressOutputError = false,
  ): Promise<T | null> {
    if (Date.now() < this.rateLimitUntil) {
      this.log.debug('spotify api request skipped due to recent rate limit', { zoneId: this.zoneId, endpoint });
      return null;
    }
    const url = `https://api.spotify.com/v1/me/player${endpoint}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    const hasBody = body !== undefined;
    if (hasBody) {
      headers['Content-Type'] = 'application/json';
    }

    const maxAttempts = 3;
    let delayMs = 500;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await fetch(url, {
          method,
          headers,
          body: hasBody ? JSON.stringify(body) : undefined,
        });
        if (!response.ok && response.status !== 204) {
          const text = await safeReadText(response, '', {
            onError: 'debug',
            log: this.log,
            label: 'spotify connect device transfer read failed',
            context: { status: response.status },
          });
        if (response.status === 429 && attempt < maxAttempts) {
          const retryAfter =
            Number(response.headers.get('retry-after') ?? '0') * 1000 || delayMs;
          this.rateLimitUntil = Date.now() + Math.max(retryAfter, 1000);
          await new Promise((resolve) => setTimeout(resolve, retryAfter));
          delayMs *= 2;
          continue;
        }
        if (response.status === 429) {
          this.rateLimitUntil = Date.now() + 2000;
        }
        if (response.status === 404 && currentDeviceId) {
          this.invalidDevices.set(currentDeviceId, Date.now() + 60_000);
          this.rateLimitUntil = Date.now() + 500;
        }
        const logFn = suppressOutputError ? this.log.debug.bind(this.log) : this.log.warn.bind(this.log);
        logFn('spotify api request failed', {
          zoneId: this.zoneId,
          status: response.status,
          body: text.slice(0, 300),
          });
          if (response.status === 404 || response.status === 410) {
            if (!suppressOutputError) {
              this.outputHandlers.onOutputError(this.zoneId, 'device');
              const preferred = currentDeviceId && this.preferredDeviceId === currentDeviceId;
              if (!preferred && currentDeviceId) {
                await this.clearPersistedDeviceId(currentDeviceId);
              }
            }
          }
          return null;
        }
        if (response.status === 204) {
          return succeedOnNoContent ?? null;
        }
        const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
        const text = await safeReadText(response, '', {
          onError: 'debug',
          log: this.log,
          label: 'spotify connect status read failed',
          context: { status: response.status },
        });
        if (!text.trim()) {
          return succeedOnNoContent ?? null;
        }
        if (contentType.includes('json')) {
          try {
            return JSON.parse(text) as T;
          } catch {
            /* fall through */
          }
        }
        this.log.debug('spotify api non-json response', {
          zoneId: this.zoneId,
          endpoint,
          preview: text.slice(0, 120),
        });
        return succeedOnNoContent ?? (true as unknown as T);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          delayMs *= 2;
          continue;
        }
        this.log.warn('spotify api request error', { zoneId: this.zoneId, message });
        if (!suppressOutputError) {
          this.outputHandlers.onOutputError(this.zoneId, 'error');
        }
        return null;
      }
    }
    return null;
  }

  private async lookupDeviceByName(token: string): Promise<string | undefined> {
    const names = [this.publishName, this.deviceName].filter(Boolean) as string[];
    const result = await this.apiRequest<any>('GET', '/devices', token);
    const devices: any[] = Array.isArray(result?.devices) ? result.devices : [];
    const match = this.rankDevicesByName(devices, names)[0];
    if (match?.id) {
      this.log.debug('spotify device id resolved by name', { zoneId: this.zoneId, name: match.name });
      return match.id as string;
    }
    this.log.debug('spotify device not found by name', { zoneId: this.zoneId, names });
    return undefined;
  }

  private rankDevicesByName(
    devices: Array<{ id: string; name?: string; type?: string }>,
    desiredNames: string[],
  ): Array<{ id: string; name?: string; type?: string; score: number }> {
    const normalizedDesired = desiredNames
      .map((name) => this.normalizeDeviceName(name))
      .filter(Boolean);
    const scored = devices
      .map((device) => {
        const normalized = device.name ? this.normalizeDeviceName(device.name) : '';
        const score = normalizedDesired.reduce((best, desired) => {
          if (!normalized || !desired) return best;
          if (normalized === desired) return Math.max(best, 3);
          if (normalized.startsWith(desired) || normalized.endsWith(desired)) return Math.max(best, 2);
          if (normalized.includes(desired) || desired.includes(normalized)) return Math.max(best, 1);
          return best;
        }, 0);
        return { ...device, score };
      })
      .filter((device) => device.score > 0);
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aIsComputer = a.type?.toLowerCase() === 'computer';
      const bIsComputer = b.type?.toLowerCase() === 'computer';
      if (aIsComputer !== bIsComputer) return aIsComputer ? -1 : 1;
      return (a.name || '').localeCompare(b.name || '');
    });
    return scored;
  }

  private normalizeDeviceName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private async transferAndPlay(
    token: string,
    deviceId: string,
    body: Record<string, unknown>,
    suppressOutputError = false,
  ): Promise<boolean> {
    // Claim/activate device, then play.
    const claimed = await this.apiRequest<boolean>(
      'PUT',
      '',
      token,
      { device_ids: [deviceId], play: false },
      deviceId,
      true,
      suppressOutputError,
    );
    if (claimed === null) {
      this.log.warn('spotify device claim failed before play', { zoneId: this.zoneId, deviceId });
      return false;
    }
    await this.waitForActiveDevice(token, deviceId, 1500, suppressOutputError);
    const endpointWithDevice = this.buildEndpoint('/play', deviceId);
    let res = await this.apiRequest(
      'PUT',
      endpointWithDevice,
      token,
      body,
      deviceId,
      true,
      suppressOutputError,
    );
    if (res === null) {
      // Retry once after a short backoff to handle transient 404s while the device activates.
      await new Promise((resolve) => setTimeout(resolve, 400));
      await this.waitForActiveDevice(token, deviceId, 1500, suppressOutputError);
      res = await this.apiRequest('PUT', endpointWithDevice, token, body, deviceId, true, suppressOutputError);
    }
    return res !== null;
  }

  private async waitForActiveDevice(
    token: string,
    deviceId: string,
    timeoutMs = 2000,
    suppressOutputError = false,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const devices = await this.apiRequest<{
        devices: Array<{ id: string; is_active?: boolean }>;
      }>('GET', '/devices', token, undefined, undefined, undefined, suppressOutputError);
      const active = devices?.devices?.some((device) => device.id === deviceId && device.is_active);
      if (active) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  }
}
