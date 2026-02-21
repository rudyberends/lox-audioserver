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
  private abortController: AbortController | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch (err) {
        this.log.debug('beolink abort during stop failed', {
          zoneId: this.zone.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      this.abortController = null;
    }
    if (this.stream) {
      this.stream.removeAllListeners();
      this.stream.destroy();
      this.stream = null;
    }
    this.log.info('stopped beolink state stream', { zoneId: this.zone.id });
  }

  public handleCommand(command: string): boolean {
    const intent = normalizeControlIntent(command);
    if (!intent) {
      return false;
    }
    if (!this.coverBaseOrigin) {
      this.log.warn('beolink command ignored; missing base origin', {
        zoneId: this.zone.id,
        command,
      });
      return true;
    }
    void this.sendControlCommand(intent.command);
    return true;
  }

  private async connect(): Promise<void> {
    if (this.stopped || !this.notifyUrl) return;
    try {
      this.abortController = new AbortController();
      const response = await fetch(this.notifyUrl, {
        signal: this.abortController.signal,
      });
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
      this.consecutiveFailures = 0;
      this.log.info('beolink state stream active', { zoneId: this.zone.id, url: this.notifyUrl });

      parsed.on('data', (message: unknown) => {
        const eventType = resolveNotificationType(message);
        const patch = mapZonePatch(message, this.coverBaseOrigin);
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
    this.consecutiveFailures += 1;
    const jitter = Math.floor(Math.random() * 250);
    const delay =
      Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * (2 ** Math.min(5, this.consecutiveFailures))) +
      jitter;

    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch (err) {
        this.log.debug('beolink abort during reconnect failed', {
          zoneId: this.zone.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      this.abortController = null;
    }
    if (this.stream) {
      this.stream.removeAllListeners();
      this.stream.destroy();
      this.stream = null;
    }
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

  private async sendControlCommand(command: NormalizedControlCommand): Promise<void> {
    const spec = CONTROL_ENDPOINTS[command];
    if (!spec || !this.coverBaseOrigin) {
      return;
    }
    await this.sendSingleRequest(command, spec, undefined);
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
}

type NormalizedControlCommand = 'play' | 'pause' | 'stop' | 'next' | 'previous';
type ControlIntent = { command: NormalizedControlCommand };
type ControlRequest = {
  method: 'POST' | 'PUT';
  path: string;
  body?: string;
  contentType?: string;
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

function normalizeControlIntent(command: string): ControlIntent | null {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return null;

  const transport = normalizeControlCommand(normalized);
  if (transport) {
    return { command: transport };
  }
  return null;
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
