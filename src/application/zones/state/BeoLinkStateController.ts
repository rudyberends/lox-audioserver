import ndjson from 'ndjson';
import { Readable } from 'node:stream';
import type { ZoneConfig } from '@/domain/config/types';
import type { LoxoneZoneState } from '@/domain/loxone/types';
import { AudioType } from '@/domain/loxone/enums';
import { createLogger } from '@/shared/logging/logger';
import type { ZoneStateController } from '@/application/zones/state/StateController';

type BeoLinkControllerOptions = {
  zone: ZoneConfig;
  onStatePatch: (zoneId: number, patch: Partial<LoxoneZoneState>) => void;
};

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;
const IDLE_TIMEOUT_MS = 90_000;
const IDLE_CHECK_INTERVAL_MS = 15_000;

/**
 * Minimal BeoLink external state ingestion.
 * Listens to the BeoNotify NDJSON stream and forwards play/pause/stop.
 */
export class BeoLinkStateController implements ZoneStateController {
  private readonly log = createLogger('Zones', 'StateController:BeoLink');
  private readonly zone: ZoneConfig;
  private readonly onStatePatch: (zoneId: number, patch: Partial<LoxoneZoneState>) => void;
  private readonly notifyUrl: string | null;
  private readonly coverBaseOrigin: string | null;
  private stream: Readable | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private idleWatchdogTimer: NodeJS.Timeout | null = null;
  private lastActivityAt = 0;
  private consecutiveFailures = 0;
  private stopped = false;
  private reconnecting = false;
  private lastCoverRaw: string | null = null;
  private lastCoverSignature: string | null = null;
  private coverRevision = 0;
  private lastTitle = '';
  private lastArtist = '';
  private lastAlbum = '';
  private lastFriendlySourceName = '';
  private lastKnownAudiotype: number | null = null;
  private lastKnownVolume: number | null = null;
  private lastKnownVolumeMax = 100;

  constructor(options: BeoLinkControllerOptions) {
    this.zone = options.zone;
    this.onStatePatch = options.onStatePatch;
    this.notifyUrl = resolveBeoLinkNotifyUrl(this.zone);
    this.coverBaseOrigin = resolveBaseOrigin(this.notifyUrl);
  }

  public async start(): Promise<void> {
    this.stopped = false;
    if (!this.notifyUrl) {
      this.log.warn('state controller beolink enabled but zone output has no usable host/ip');
      return;
    }
    this.log.info('starting beolink state stream', {
      zoneId: this.zone.id,
      zoneName: this.zone.name,
      url: this.notifyUrl,
    });
    await this.connect();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.stopIdleWatchdog();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownStream();
    this.log.info('stopped beolink state stream', { zoneId: this.zone.id });
  }

  public handleCommand(command: string, payload?: string): boolean {
    const intent = normalizeControlIntent(command, payload);
    if (!intent) {
      return false;
    }
    if (!this.coverBaseOrigin) {
      this.log.warn('beolink command ignored; missing base origin', {
        zoneId: this.zone.id,
        command,
        payload,
      });
      return true;
    }
    if (intent.kind === 'transport') {
      void this.sendControlCommand(intent.command);
      return true;
    }
    if (intent.kind === 'volume') {
      void this.sendVolumeCommand(command, intent.level, intent.isRelative);
      return true;
    }
    void this.sendActionCommand(command, intent.actionPath, intent.param);
    return true;
  }

  private async connect(): Promise<void> {
    if (this.stopped || !this.notifyUrl) return;
    try {
      const response = await fetch(this.notifyUrl);
      if (!response.ok) {
        throw new Error(`http ${response.status}`);
      }
      if (!response.body) {
        throw new Error('missing response body');
      }

      const parsed = Readable.fromWeb(
        response.body as unknown as globalThis.ReadableStream<Uint8Array>,
      ).pipe(ndjson.parse());
      this.stream = parsed;
      this.lastActivityAt = Date.now();
      this.startIdleWatchdog();
      this.consecutiveFailures = 0;
      this.log.info('beolink state stream active', { zoneId: this.zone.id, url: this.notifyUrl });

      parsed.on('data', (message: unknown) => {
        this.lastActivityAt = Date.now();
        const eventType = resolveNotificationType(message);
        const rangeMax = findVolumeRangeMaximum(message);
        if (typeof rangeMax === 'number' && Number.isFinite(rangeMax) && rangeMax > 0) {
          this.lastKnownVolumeMax = Math.round(rangeMax);
        }
        const patch = mapZonePatch(message, this.coverBaseOrigin);
        if (eventType === 'SOURCE' && typeof patch.audiotype !== 'number') {
          this.lastKnownAudiotype = null;
        } else if (typeof patch.audiotype === 'number') {
          this.lastKnownAudiotype = patch.audiotype;
        }
        if (typeof patch.volume === 'number' && Number.isFinite(patch.volume)) {
          this.lastKnownVolume = patch.volume;
        }
        if (eventType === 'NOW_PLAYING_ENDED' && this.shouldIgnoreEndedEvent()) {
          this.log.debug('beolink ended event ignored for external input', {
            zoneId: this.zone.id,
            audiotype: this.lastKnownAudiotype,
          });
          return;
        }
        if (typeof patch.sourceName === 'string' && patch.sourceName.trim().length > 0) {
          this.lastFriendlySourceName = patch.sourceName.trim();
        } else if (
          (eventType === 'PROGRESS_INFORMATION' || eventType === 'NOW_PLAYING_STORED_MUSIC') &&
          this.lastFriendlySourceName
        ) {
          patch.sourceName = this.lastFriendlySourceName;
        }
        this.applyExternalSourceLabelFallback(patch);
        this.applyCoverCacheBusting(patch, eventType);
        if (Object.keys(patch).length > 0) {
          this.log.debug('beolink state update', {
            zoneId: this.zone.id,
            mode: patch.mode,
            audiotype: patch.audiotype,
            sourceName: patch.sourceName,
            title: patch.title,
            artist: patch.artist,
            album: patch.album,
            hasCover: Boolean(patch.coverurl),
            hasAudiopath: Boolean(patch.audiopath),
            keys: Object.keys(patch),
          });
          this.onStatePatch(this.zone.id, patch);
        }
      });
      parsed.once('error', (err: unknown) => {
        if (this.stopped) return;
        if (isAbortLikeError(err)) return;
        this.log.warn('beolink stream error; reconnecting', {
          zoneId: this.zone.id,
          url: this.notifyUrl,
          message: err instanceof Error ? err.message : String(err),
        });
        void this.scheduleReconnect();
      });
      parsed.once('close', () => {
        if (this.stopped) return;
        this.log.warn('beolink stream closed; reconnecting', { zoneId: this.zone.id });
        void this.scheduleReconnect();
      });
    } catch (err) {
      if (this.stopped) return;
      if (isAbortLikeError(err)) return;
      this.log.warn('beolink connect failed; reconnecting', {
        zoneId: this.zone.id,
        url: this.notifyUrl,
        message: err instanceof Error ? err.message : String(err),
      });
      await this.scheduleReconnect();
    }
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;
    this.stopIdleWatchdog();
    this.consecutiveFailures += 1;
    const jitter = Math.floor(Math.random() * 250);
    const delay =
      Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * (2 ** Math.min(5, this.consecutiveFailures))) +
      jitter;

    this.teardownStream();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.log.info('beolink reconnect scheduled', {
      zoneId: this.zone.id,
      url: this.notifyUrl,
      delayMs: Math.round(delay),
      attempt: this.consecutiveFailures,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnecting = false;
      void this.connect();
    }, delay);
  }

  private teardownStream(): void {
    if (!this.stream) {
      return;
    }
    const stream = this.stream;
    this.stream = null;
    // Suppress expected error events that can be emitted while shutting down.
    stream.once('error', () => undefined);
    stream.removeAllListeners('data');
    stream.removeAllListeners('close');
    stream.destroy();
    stream.removeAllListeners();
  }

  private startIdleWatchdog(): void {
    this.stopIdleWatchdog();
    this.idleWatchdogTimer = setInterval(() => {
      if (this.stopped || this.reconnecting) {
        return;
      }
      const idleMs = Date.now() - this.lastActivityAt;
      if (idleMs < IDLE_TIMEOUT_MS) {
        return;
      }
      this.log.warn('beolink stream idle timeout; reconnecting', {
        zoneId: this.zone.id,
        idleMs,
        timeoutMs: IDLE_TIMEOUT_MS,
      });
      void this.scheduleReconnect();
    }, IDLE_CHECK_INTERVAL_MS);
  }

  private stopIdleWatchdog(): void {
    if (this.idleWatchdogTimer) {
      clearInterval(this.idleWatchdogTimer);
      this.idleWatchdogTimer = null;
    }
  }

  private async sendControlCommand(command: NormalizedControlCommand): Promise<void> {
    const spec = CONTROL_ENDPOINTS[command];
    if (!spec || !this.coverBaseOrigin) {
      return;
    }
    await this.sendSingleRequest(command, spec, undefined);
  }

  private async sendActionCommand(
    command: string,
    actionPath: string,
    param?: string,
  ): Promise<void> {
    if (!this.coverBaseOrigin) {
      return;
    }
    const request = resolveActionRequest(actionPath, param);
    await this.sendSingleRequest(command, request, {
      actionPath,
      hasParam: typeof param === 'string' && param.trim().length > 0,
    });
  }

  private async sendVolumeCommand(
    command: string,
    level: number,
    isRelative: boolean,
  ): Promise<void> {
    const resolved = await this.resolveVolumeLevel(level, isRelative);
    if (resolved == null) {
      this.log.warn('beolink volume command skipped; unable to resolve current volume', {
        zoneId: this.zone.id,
        command,
        requested: level,
        isRelative,
      });
      return;
    }
    const request: ControlRequest = {
      method: 'PUT',
      path: '/BeoZone/Zone/Sound/Volume/Speaker/Level',
      body: JSON.stringify({ level: resolved }),
      contentType: 'application/json',
    };
    const ok = await this.sendSingleRequest(command, request, {
      resolvedLevel: resolved,
      isRelative,
    });
    if (ok) {
      this.lastKnownVolume = resolved;
    }
  }

  private async resolveVolumeLevel(level: number, isRelative: boolean): Promise<number | null> {
    if (!isRelative) {
      return clamp(Math.round(level), 0, this.lastKnownVolumeMax);
    }
    let base = this.lastKnownVolume;
    if (base == null) {
      base = await this.fetchCurrentVolumeLevel();
    }
    if (base == null) {
      return null;
    }
    return clamp(Math.round(base + level), 0, this.lastKnownVolumeMax);
  }

  private async fetchCurrentVolumeLevel(): Promise<number | null> {
    if (!this.coverBaseOrigin) {
      return null;
    }
    const url = `${this.coverBaseOrigin}/BeoZone/Zone/Sound/Volume/Speaker/Level`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        return null;
      }
      const payload = await response.json().catch(() => null);
      const record = asRecord(payload);
      const level = record ? findNumberValue(record, ['level']) : null;
      if (typeof level !== 'number' || !Number.isFinite(level)) {
        return null;
      }
      const range = asRecord(record?.range);
      const max = range ? findNumberValue(range, ['maximum', 'max']) : null;
      if (typeof max === 'number' && Number.isFinite(max) && max > 0) {
        this.lastKnownVolumeMax = Math.round(max);
      }
      const normalized = clamp(Math.round(level), 0, this.lastKnownVolumeMax);
      this.lastKnownVolume = normalized;
      return normalized;
    } catch {
      return null;
    }
  }

  private async sendSingleRequest(
    command: string,
    request: ControlRequest,
    extra?: Record<string, unknown>,
  ): Promise<boolean> {
    if (!this.coverBaseOrigin) return false;
    const url = `${this.coverBaseOrigin}${request.path}`;
    try {
      const response = await fetch(url, {
        method: request.method,
        headers: request.contentType ? { 'Content-Type': request.contentType } : undefined,
        body: request.body,
      });
      if (response.ok) {
        this.log.info('beolink command sent', {
          zoneId: this.zone.id,
          command,
          method: request.method,
          url,
          status: response.status,
          ...(extra ?? {}),
        });
        return true;
      }
      this.log.warn('beolink command failed', {
        zoneId: this.zone.id,
        command,
        method: request.method,
        url,
        status: response.status,
        ...(extra ?? {}),
      });
      return false;
    } catch (err) {
      this.log.warn('beolink command request error', {
        zoneId: this.zone.id,
        command,
        method: request.method,
        url,
        message: err instanceof Error ? err.message : String(err),
        ...(extra ?? {}),
      });
      return false;
    }
  }

  private applyCoverCacheBusting(
    patch: Partial<LoxoneZoneState>,
    eventType: string,
  ): void {
    if (eventType === 'NOW_PLAYING_ENDED') {
      this.lastTitle = '';
      this.lastArtist = '';
      this.lastAlbum = '';
      this.lastCoverSignature = null;
      return;
    }

    const hasIncomingCover = typeof patch.coverurl === 'string' && patch.coverurl.trim().length > 0;
    const metadataChanged = this.captureMetadata(patch);
    const canTriggerBump = eventType === 'NOW_PLAYING_STORED_MUSIC';
    const albumKey = (typeof patch.album === 'string' ? patch.album.trim() : '') || this.lastAlbum || 'unknown';

    const incomingRaw = hasIncomingCover ? stripCacheBust(String(patch.coverurl)) : null;
    if (incomingRaw) {
      const rawChanged = !this.lastCoverRaw || this.lastCoverRaw !== incomingRaw;
      if (rawChanged) {
        this.lastCoverRaw = incomingRaw;
      }
      if (rawChanged || (metadataChanged && canTriggerBump)) {
        this.coverRevision += 1;
      }
      patch.coverurl = withCacheBust(incomingRaw, this.coverRevision, albumKey);
      return;
    }

    if (metadataChanged && canTriggerBump && this.lastCoverRaw) {
      this.coverRevision += 1;
      patch.coverurl = withCacheBust(this.lastCoverRaw, this.coverRevision, albumKey);
    }
  }

  private captureMetadata(patch: Partial<LoxoneZoneState>): boolean {
    let changed = false;
    if (typeof patch.title === 'string') {
      const next = patch.title.trim();
      if (next !== this.lastTitle) {
        this.lastTitle = next;
        changed = true;
      }
    }
    if (typeof patch.artist === 'string') {
      const next = patch.artist.trim();
      if (next !== this.lastArtist) {
        this.lastArtist = next;
        changed = true;
      }
    }
    if (typeof patch.album === 'string') {
      const next = patch.album.trim();
      if (next !== this.lastAlbum) {
        this.lastAlbum = next;
        changed = true;
      }
    }
    const signature = buildTrackSignatureFromParts(this.lastTitle, this.lastArtist, this.lastAlbum);
    if (signature && signature !== this.lastCoverSignature) {
      this.lastCoverSignature = signature;
      changed = true;
    }
    return changed;
  }

  private applyExternalSourceLabelFallback(patch: Partial<LoxoneZoneState>): void {
    const sourceName = typeof patch.sourceName === 'string' ? patch.sourceName.trim() : '';
    if (!sourceName) {
      return;
    }
    const audiotype = patch.audiotype;
    const isExternalInput = audiotype === AudioType.LineIn || audiotype === AudioType.Bluetooth;
    if (!isExternalInput) {
      return;
    }
    const hasTitle = typeof patch.title === 'string' && patch.title.trim().length > 0;
    const hasArtist = typeof patch.artist === 'string' && patch.artist.trim().length > 0;
    const hasAlbum = typeof patch.album === 'string' && patch.album.trim().length > 0;
    const hasMetadata = hasTitle || hasArtist || hasAlbum;
    if (hasMetadata) {
      return;
    }
    if (!hasTitle) {
      patch.title = sourceName;
    }
    patch.station = '';
  }

  private shouldIgnoreEndedEvent(): boolean {
    return (
      this.lastKnownAudiotype === AudioType.LineIn ||
      this.lastKnownAudiotype === AudioType.Bluetooth
    );
  }
}

type NormalizedControlCommand = 'play' | 'pause' | 'stop' | 'next' | 'previous';
type ControlIntent =
  | { kind: 'transport'; command: NormalizedControlCommand }
  | { kind: 'volume'; level: number; isRelative: boolean }
  | { kind: 'action'; actionPath: string; param?: string };
type ControlRequest = {
  method: 'POST' | 'PUT';
  path: string;
  body?: string;
  contentType?: string;
};

const ACTION_COMMAND_MAP: Record<string, string> = {
  groupjoin: 'Device/OneWayJoin',
  groupjoinmany: 'Device/OneWayJoin',
  groupleave: 'Device/OneWayLeave',
  groupleavemany: 'Device/OneWayLeave',
  repeat: 'List/Repeat',
  shuffle: 'List/Shuffle',
};

const CONTROL_ENDPOINTS: Record<NormalizedControlCommand, ControlRequest> = {
  play: { method: 'POST', path: '/BeoZone/Zone/Stream/Play' },
  pause: { method: 'POST', path: '/BeoZone/Zone/Stream/Pause' },
  stop: { method: 'POST', path: '/BeoZone/Zone/Stream/Stop' },
  next: { method: 'POST', path: '/BeoZone/Zone/Stream/Forward' },
  previous: { method: 'POST', path: '/BeoZone/Zone/Stream/Backward' },
};

function normalizeControlCommand(command: string): NormalizedControlCommand | null {
  const normalized = command.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === 'play' || normalized === 'resume') {
    return 'play';
  }
  if (normalized === 'pause') {
    return 'pause';
  }
  if (normalized === 'stop') {
    return 'stop';
  }
  if (normalized === 'next' || normalized === 'queueplus' || normalized === 'skip') {
    return 'next';
  }
  if (normalized === 'previous' || normalized === 'prev' || normalized === 'queueminus') {
    return 'previous';
  }
  return null;
}

function normalizeControlIntent(command: string, payload?: string): ControlIntent | null {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return null;

  const transport = normalizeControlCommand(normalized);
  if (transport) {
    return { kind: 'transport', command: transport };
  }
  if (normalized === 'volume') {
    const parsed = Number(payload);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    const raw = typeof payload === 'string' ? payload.trim() : '';
    return { kind: 'volume', level: parsed, isRelative: raw.startsWith('+') || raw.startsWith('-') };
  }
  const actionPath = ACTION_COMMAND_MAP[normalized];
  if (actionPath) {
    const param = typeof payload === 'string' ? payload.trim() : '';
    return { kind: 'action', actionPath, param: param || undefined };
  }
  return null;
}

function resolveActionRequest(actionPath: string, param?: string): ControlRequest {
  const basePath = `/BeoZone/Zone/${actionPath}`;
  const normalizedParam = typeof param === 'string' ? param.trim() : '';
  if (!normalizedParam) {
    return { method: 'POST', path: basePath };
  }
  const encodedParam = encodeURIComponent(normalizedParam);
  return { method: 'POST', path: `${basePath}/${encodedParam}` };
}

function isAbortLikeError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === 'AbortError';
  }
  if (err instanceof Error) {
    return err.name === 'AbortError';
  }
  if (typeof err === 'object' && err !== null) {
    const name = (err as { name?: unknown }).name;
    return name === 'AbortError';
  }
  return false;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveBeoLinkNotifyUrl(zone: ZoneConfig): string | null {
  const output = ((zone.output ?? null) as Record<string, unknown> | null) ?? null;
  const outputControlUrl = output ? pickString(output.controlUrl) : null;
  const candidate =
    (output ? pickString(output.host) : null) ??
    (output ? pickString(output.ip) : null) ??
    (output ? pickString(output.address) : null) ??
    extractHostname(outputControlUrl);
  if (!candidate) {
    return null;
  }
  if (/^https?:\/\//i.test(candidate)) {
    return candidate;
  }
  return `http://${candidate}:8080/BeoNotify/Notifications`;
}

function pickString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function extractHostname(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function resolveBaseOrigin(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function resolveNotificationType(message: unknown): string {
  const root = asRecord(message);
  if (!root) return '';
  const notification = asRecord(root.notification);
  return pickString(notification?.type) ?? pickString(root.type) ?? '';
}

function findVolumeRangeMaximum(message: unknown): number | null {
  const root = asRecord(message);
  if (!root) return null;
  const notification = asRecord(root.notification);
  const data = asRecord(notification?.data ?? root.data ?? root);
  const speaker = asRecord(data?.speaker);
  const range = asRecord(speaker?.range);
  const maximum = range ? findNumberValue(range, ['maximum', 'max']) : null;
  if (typeof maximum !== 'number' || !Number.isFinite(maximum) || maximum <= 0) {
    return null;
  }
  return maximum;
}

function mapZonePatch(message: unknown, coverBaseOrigin: string | null): Partial<LoxoneZoneState> {
  const root = asRecord(message);
  if (!root) return {};
  const notification = asRecord(root.notification);
  const type = pickString(notification?.type) ?? pickString(root.type) ?? '';
  const data = (notification?.data ?? root.data ?? root) as unknown;
  const payload = asRecord(data) ?? {};
  const patch: Partial<LoxoneZoneState> = {};

  if (type === 'SOURCE') {
    // External BeoLink source should detach any prior local queue audiopath.
    patch.audiopath = '';
    const sourceContext = resolvePrimarySourceContext(payload);
    const sourceName =
      sourceContext.friendlyName ??
      findNestedSourceName(payload) ??
      findStringValue(payload, ['primary']);
    if (sourceName) patch.sourceName = sourceName;
    if (sourceName && shouldProjectSourceLabel(sourceContext)) {
      patch.title = sourceName;
      patch.station = '';
    }
    const sourceAudiotype = resolveSourceAudiotype(sourceContext, payload);
    if (typeof sourceAudiotype === 'number') {
      patch.audiotype = sourceAudiotype;
      if (sourceAudiotype === AudioType.AirPlay) {
        // Mark external AirPlay explicitly so downstream logic treats this as an AirPlay input state.
        patch.audiopath = 'airplay://external';
      }
    }
    const mode = mapToken(findStringValue(payload, ['state']) ?? '');
    if (mode) {
      patch.mode = mode;
      patch.power = 'on';
      patch.clientState = 'on';
    }
    return patch;
  }

  if (type === 'NOW_PLAYING_STORED_MUSIC') {
    const title = findStringValue(payload, ['name', 'title', 'tracktitle']);
    if (title) patch.title = title;
    const artist = findStringValue(payload, ['artist', 'artistname']);
    if (artist) patch.artist = artist;
    const album = findStringValue(payload, ['album', 'albumname']);
    if (album) patch.album = album;
    const sourceName = findStringValue(payload, ['source', 'sourceName']);
    if (sourceName) patch.sourceName = sourceName;
    const station = findStringValue(payload, ['station', 'stationname']);
    if (station) patch.station = station;
    const coverurl = findCoverUrl(payload, coverBaseOrigin);
    if (coverurl) patch.coverurl = coverurl;
    const duration = findNumberValue(payload, ['duration', 'totalDuration']);
    if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) {
      patch.duration = duration;
    }
    const queueItemId = findStringValue(payload, ['playQueueItemId']);
    const queueAudiotype = resolveQueueAudiotype(queueItemId);
    if (typeof queueAudiotype === 'number') {
      patch.audiotype = queueAudiotype;
      if (queueAudiotype === AudioType.AirPlay) {
        patch.audiopath = 'airplay://external';
      }
    }
    return patch;
  }

  if (type === 'PROGRESS_INFORMATION') {
    const mode = mapToken(findStringValue(payload, ['state']) ?? '');
    if (mode) {
      patch.mode = mode;
      patch.power = 'on';
      patch.clientState = 'on';
    }
    const queueItemId = findStringValue(payload, ['playQueueItemId']);
    const queueAudiotype = resolveQueueAudiotype(queueItemId);
    if (typeof queueAudiotype === 'number') {
      patch.audiotype = queueAudiotype;
      if (queueAudiotype === AudioType.AirPlay) {
        patch.audiopath = 'airplay://external';
      }
    }
    const duration = findNumberValue(payload, ['totalDuration', 'duration', 'length']);
    if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) {
      patch.duration = duration;
    }
    const time = findNumberValue(payload, ['position', 'elapsed', 'time', 'progress']);
    if (typeof time === 'number' && Number.isFinite(time) && time >= 0) {
      patch.time = time;
    }
    return patch;
  }

  if (type === 'NOW_PLAYING_ENDED') {
    patch.mode = 'stop';
    patch.power = 'on';
    patch.clientState = 'on';
    return patch;
  }

  if (type === 'VOLUME') {
    const speaker = asRecord(payload.speaker);
    const level = speaker ? findNumberValue(speaker, ['level']) : null;
    if (typeof level === 'number' && Number.isFinite(level) && level >= 0) {
      patch.volume = level;
    }
    return patch;
  }

  return {};
}

function findCoverUrl(payload: unknown, baseOrigin: string | null): string | null {
  const trackImage = pickImageUrlFromArray(findArrayByKey(payload, ['trackimage']));
  const normalizedTrackImage = normalizeCoverUrl(trackImage, baseOrigin);
  if (normalizedTrackImage) {
    return normalizedTrackImage;
  }

  const albumImage = pickImageUrlFromArray(findArrayByKey(payload, ['albumimage']));
  const normalizedAlbumImage = normalizeCoverUrl(albumImage, baseOrigin);
  if (normalizedAlbumImage) {
    return normalizedAlbumImage;
  }

  const artistImage = pickImageUrlFromArray(findArrayByKey(payload, ['artistimage']));
  const normalizedArtistImage = normalizeCoverUrl(artistImage, baseOrigin);
  if (normalizedArtistImage) {
    return normalizedArtistImage;
  }

  const direct = findStringValue(payload, [
    'coverurl',
    'cover',
    'imageurl',
    'arturl',
    'albumarturl',
    'thumbnailurl',
    'pictureurl',
  ]);
  const normalizedDirect = normalizeCoverUrl(direct, baseOrigin);
  if (normalizedDirect) {
    return normalizedDirect;
  }

  const fromArtworkObject = findStringFromKnownObject(payload, [
    'cover',
    'image',
    'art',
    'artwork',
    'albumart',
    'thumbnail',
    'picture',
  ]);
  const normalizedKnown = normalizeCoverUrl(fromArtworkObject, baseOrigin);
  if (normalizedKnown) {
    return normalizedKnown;
  }

  const discovered = discoverCandidateImageUrls(payload);
  for (const candidate of discovered) {
    const normalized = normalizeCoverUrl(candidate, baseOrigin);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function mapToken(token: string): LoxoneZoneState['mode'] | null {
  const normalized = token.trim().toUpperCase();
  if (!normalized) return null;

  if (
    normalized.includes('PAUSE') ||
    normalized === 'PAUSED' ||
    normalized === 'PAUSE'
  ) {
    return 'pause';
  }
  if (
    normalized.includes('STOP') ||
    normalized.includes('IDLE') ||
    normalized.includes('STANDBY') ||
    normalized === 'OFF'
  ) {
    return 'stop';
  }
  if (
    normalized.includes('PLAY') ||
    normalized.includes('START') ||
    normalized.includes('BUFFERING')
  ) {
    return 'play';
  }
  return null;
}

function findNestedSourceName(value: unknown): string | null {
  const sourceRecord = findRecordByKey(value, ['source']);
  if (!sourceRecord) return null;
  return (
    pickString(sourceRecord.name) ??
    pickString(sourceRecord.friendlyName) ??
    pickString(sourceRecord.label) ??
    pickString(sourceRecord.id)
  );
}

function resolvePrimarySourceContext(payload: Record<string, unknown>): {
  friendlyName: string | null;
  sourceType: string | null;
  category: string | null;
} {
  const primaryExperience = asRecord(payload.primaryExperience);
  const source = asRecord(primaryExperience?.source);
  const sourceTypeRecord = asRecord(source?.sourceType);
  return {
    friendlyName:
      pickString(source?.friendlyName) ??
      pickString(source?.name) ??
      pickString(source?.id) ??
      null,
    sourceType: pickString(sourceTypeRecord?.type) ?? null,
    category: pickString(source?.category) ?? null,
  };
}

function shouldProjectSourceLabel(context: {
  sourceType: string | null;
  category: string | null;
}): boolean {
  const sourceType = (context.sourceType ?? '').toUpperCase();
  const category = (context.category ?? '').toUpperCase();
  if (sourceType === 'AIRPLAY') return false;
  if (category === 'MUSIC') return false;
  return true;
}

function isAirPlayContext(
  context: { sourceType: string | null },
  payload: Record<string, unknown>,
): boolean {
  if ((context.sourceType ?? '').toUpperCase() === 'AIRPLAY') {
    return true;
  }
  const primary = findStringValue(payload, ['primary']) ?? '';
  return primary.toLowerCase().startsWith('airplay:');
}

function resolveSourceAudiotype(
  context: { sourceType: string | null },
  payload: Record<string, unknown>,
): number | null {
  if (isAirPlayContext(context, payload)) {
    return AudioType.AirPlay;
  }
  const sourceType = (context.sourceType ?? '').toUpperCase();
  if (sourceType === 'BLUETOOTH') {
    return AudioType.Bluetooth;
  }
  // HDMI/AUX/optical/analog style external inputs map best to line-in semantics in Loxone.
  if (
    sourceType === 'HDMI' ||
    sourceType === 'AUX' ||
    sourceType === 'ANALOG' ||
    sourceType === 'LINEIN' ||
    sourceType === 'LINE_IN' ||
    sourceType === 'OPTICAL' ||
    sourceType === 'SPDIF' ||
    sourceType === 'COAX'
  ) {
    return AudioType.LineIn;
  }
  return null;
}

function resolveQueueAudiotype(playQueueItemId: string | null): number | null {
  const id = (playQueueItemId ?? '').trim().toLowerCase();
  if (!id) return null;
  if (id === 'airplay') return AudioType.AirPlay;
  if (id === 'aux' || id.startsWith('hdmi')) return AudioType.LineIn;
  if (id === 'bluetooth' || id === 'bt') return AudioType.Bluetooth;
  return null;
}

function findStringFromKnownObject(value: unknown, keys: string[]): string | null {
  const record = findRecordByKey(value, keys);
  if (!record) return null;
  return (
    pickString(record.url) ??
    pickString(record.uri) ??
    pickString(record.src) ??
    pickString(record.path) ??
    pickString(record.href)
  );
}

function findArrayByKey(value: unknown, keys: string[], depth = 0): unknown[] | null {
  if (depth > 6 || value == null) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findArrayByKey(entry, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = asRecord(value);
  if (!record) return null;
  const keySet = new Set(keys.map((key) => key.toLowerCase()));
  for (const [key, child] of Object.entries(record)) {
    if (keySet.has(key.toLowerCase()) && Array.isArray(child)) {
      return child;
    }
    const found = findArrayByKey(child, keys, depth + 1);
    if (found) return found;
  }
  return null;
}

function pickImageUrlFromArray(items: unknown[] | null): string | null {
  if (!items || items.length === 0) return null;
  for (const item of items) {
    const record = asRecord(item);
    if (!record) continue;
    const candidate =
      pickString(record.url) ??
      pickString(record.uri) ??
      pickString(record.src) ??
      pickString(record.href);
    if (candidate) return candidate;
  }
  return null;
}

function discoverCandidateImageUrls(value: unknown, depth = 0, keyHint = ''): string[] {
  if (depth > 6 || value == null) return [];
  if (typeof value === 'string') {
    if (isLikelyImageReference(value, keyHint)) {
      return [value];
    }
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => discoverCandidateImageUrls(entry, depth + 1, keyHint));
  }
  const record = asRecord(value);
  if (!record) return [];
  const candidates: string[] = [];
  for (const [key, child] of Object.entries(record)) {
    const nextHint = `${keyHint}.${key}`.toLowerCase();
    candidates.push(...discoverCandidateImageUrls(child, depth + 1, nextHint));
  }
  return candidates;
}

function isLikelyImageReference(raw: string, keyHint: string): boolean {
  const value = raw.trim().toLowerCase();
  if (!value) return false;
  if (value.startsWith('data:image/')) return true;
  if (/\.(jpg|jpeg|png|webp|gif|bmp|avif)(\?|$)/i.test(value)) return true;
  if (/(cover|albumart|artwork|thumbnail|image|picture|icon)/i.test(keyHint)) return true;
  if (/(cover|albumart|artwork|thumbnail|image|picture|icon)/i.test(value)) return true;
  return false;
}

function normalizeCoverUrl(raw: string | null, baseOrigin: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^data:image\//i.test(trimmed)) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('//')) return `http:${trimmed}`;
  if (trimmed.startsWith('/')) {
    return baseOrigin ? `${baseOrigin}${trimmed}` : null;
  }
  return null;
}

function buildTrackSignatureFromParts(title: string, artist: string, album: string): string | null {
  if (!title && !artist && !album) {
    return null;
  }
  return `${title}|||${artist}|||${album}`;
}

function stripCacheBust(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  try {
    const parsed = new URL(trimmed);
    parsed.searchParams.delete('cb');
    parsed.searchParams.delete('album');
    return parsed.toString();
  } catch {
    const [base] = trimmed.split('#', 1);
    const [path, query] = base.split('?', 2);
    if (!query) return trimmed;
    const kept = query
      .split('&')
      .filter((part) => part && !part.startsWith('cb=') && !part.startsWith('album='));
    return kept.length > 0 ? `${path}?${kept.join('&')}` : path;
  }
}

function withCacheBust(url: string, revision: number, albumTitle: string): string {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('cb', String(revision));
    parsed.searchParams.set('album', albumTitle || 'unknown');
    return parsed.toString();
  } catch {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}cb=${revision}&album=${encodeURIComponent(albumTitle || 'unknown')}`;
  }
}

function findRecordByKey(
  value: unknown,
  keys: string[],
  depth = 0,
): Record<string, unknown> | null {
  if (depth > 5 || value == null) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findRecordByKey(entry, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = asRecord(value);
  if (!record) return null;
  const keySet = new Set(keys.map((key) => key.toLowerCase()));
  for (const [key, child] of Object.entries(record)) {
    if (keySet.has(key.toLowerCase())) {
      const candidate = asRecord(child);
      if (candidate) return candidate;
    }
    const nested = findRecordByKey(child, keys, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function findStringValue(value: unknown, keys: string[], depth = 0): string | null {
  if (depth > 5 || value == null) return null;
  if (typeof value === 'string') return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findStringValue(entry, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = asRecord(value);
  if (!record) return null;
  const keySet = new Set(keys.map((key) => key.toLowerCase()));
  for (const [key, child] of Object.entries(record)) {
    if (keySet.has(key.toLowerCase())) {
      const candidate = pickString(child);
      if (candidate) return candidate;
    }
    const nested = findStringValue(child, keys, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function findNumberValue(value: unknown, keys: string[], depth = 0): number | null {
  if (depth > 5 || value == null) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findNumberValue(entry, keys, depth + 1);
      if (typeof found === 'number') return found;
    }
    return null;
  }
  const record = asRecord(value);
  if (!record) return null;
  const keySet = new Set(keys.map((key) => key.toLowerCase()));
  for (const [key, child] of Object.entries(record)) {
    if (keySet.has(key.toLowerCase())) {
      if (typeof child === 'number' && Number.isFinite(child)) return child;
      if (typeof child === 'string' && child.trim()) {
        const parsed = Number(child);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    const nested = findNumberValue(child, keys, depth + 1);
    if (typeof nested === 'number') return nested;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
