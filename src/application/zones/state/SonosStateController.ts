import {
  EventType,
  S1Client,
  SonosClient,
  detectGeneration,
  type S1SonosGroup,
  type SonosGroup,
} from '@lox-audioserver/node-sonos';

// Either backend exposes the same `player.group.*` shape that the snapshot
// builder consumes; the union here keeps the dispatcher type-safe without
// templating the whole controller.
type AnySonosGroup = SonosGroup | S1SonosGroup;
type AnySonosClient = SonosClient | S1Client;
import type { ZoneConfig } from '@/domain/config/types';
import type { LoxoneZoneState } from '@/domain/loxone/types';
import { AudioType } from '@/domain/loxone/enums';
import { createLogger } from '@/shared/logging/logger';
import type { ZoneStateController } from '@/application/zones/state/StateController';

type SonosControllerOptions = {
  zone: ZoneConfig;
  onStatePatch: (zoneId: number, patch: Partial<LoxoneZoneState>) => void;
};

const TIME_TICK_MS = 1000;
const RECONNECT_INITIAL_DELAY_MS = 5_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const RECONNECT_BACKOFF_FACTOR = 2;
// Cap how long the initial start may block the StateControllerManager loop.
// A speaker that accepts TCP but stalls during the TLS/WebSocket handshake (or
// the S1 UPnP probe) would otherwise hang start() indefinitely, blocking every
// later zone's controller from coming up. On timeout we drop to the reconnect
// schedule and return so the manager can move on.
const START_TIMEOUT_MS = 15_000;

export class SonosStateController implements ZoneStateController {
  private readonly log = createLogger('Zones', 'StateController:Sonos');
  private readonly zone: ZoneConfig;
  private readonly onStatePatch: (zoneId: number, patch: Partial<LoxoneZoneState>) => void;
  private readonly host: string | null;

  private client: AnySonosClient | null = null;
  private startPromise: Promise<void> | null = null;
  private stopRequested = false;
  private unsubscribeEvent: (() => void) | null = null;
  private timeTicker: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_INITIAL_DELAY_MS;
  private connectionGeneration = 0;
  private lastCoverRaw: string | null = null;
  private coverRevision = 0;
  private lastTrackSignature = '';
  private lastLoggedSnapshotSignature = '';
  private lastTrackMediaUrl: string | null = null;
  private lastTrackTitle: string | null = null;

  constructor(options: SonosControllerOptions) {
    this.zone = options.zone;
    this.onStatePatch = options.onStatePatch;
    this.host = resolveSonosHost(this.zone);
  }

  public async start(): Promise<void> {
    this.stopRequested = false;
    this.reconnectDelay = RECONNECT_INITIAL_DELAY_MS;
    let timeoutHandle: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('timeout'), START_TIMEOUT_MS);
      timeoutHandle.unref?.();
    });
    try {
      const result = await Promise.race([
        this.connect().then(() => 'done' as const),
        timeoutPromise,
      ]);
      if (result === 'timeout') {
        this.log.warn('sonos state controller start timed out; scheduling reconnect', {
          zoneId: this.zone.id,
          host: this.host,
          timeoutMs: START_TIMEOUT_MS,
        });
        // Tear down whatever half-initialised client we may have so the next
        // attempt starts clean. We do not await — destroy can itself hang on a
        // pathological speaker, and we are already past the budget.
        void this.destroyClient();
        this.scheduleReconnect();
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private async connect(): Promise<void> {
    if (this.stopRequested) {
      return;
    }

    if (!this.host) {
      this.log.warn('state controller sonos enabled but zone output has no usable host/ip');
      return;
    }

    await this.destroyClient();
    const generation = ++this.connectionGeneration;

    // Probe S2 vs S1 firmware before instantiating the backend client. Sonos
    // S2 speakers expose the modern WebSocket API on TLS:1443; S1 speakers do
    // not, and need the legacy UPnP/SOAP path. `unknown` is treated as S2 so
    // we don't change behaviour for healthy S2 fleets that happen to be slow
    // to respond — the existing failure paths still log and reconnect.
    const generationKind = await detectGeneration(this.host).catch(() => 'unknown' as const);
    if (this.connectionGeneration !== generation || this.stopRequested) {
      return;
    }
    const client: AnySonosClient =
      generationKind === 'S1'
        ? new S1Client(this.host, { logger: console })
        : new SonosClient(this.host, { logger: console });
    this.log.info('sonos state controller backend selected', {
      zoneId: this.zone.id,
      host: this.host,
      generation: generationKind,
    });

    this.client = client;

    this.unsubscribeEvent = client.subscribe((event) => {
      if (this.connectionGeneration !== generation || this.client !== client) {
        return;
      }
      if (
        event.eventType === EventType.CONNECTED ||
        event.eventType === EventType.GROUP_UPDATED ||
        event.eventType === EventType.GROUP_ADDED ||
        event.eventType === EventType.PLAYER_UPDATED
      ) {
        this.emitSnapshotPatch();
      }

      if (event.eventType === EventType.DISCONNECTED) {
        this.log.warn('sonos websocket disconnected', { zoneId: this.zone.id, host: this.host });
        this.scheduleReconnect();
      }
    });

    try {
      await client.connect();
      this.log.info('sonos state controller connected', {
        zoneId: this.zone.id,
        zoneName: this.zone.name,
        host: this.host,
      });

      this.reconnectDelay = RECONNECT_INITIAL_DELAY_MS;

      this.emitSnapshotPatch();
      this.startTicker();

      this.startPromise = client.start().catch((err) => {
        if (!this.stopRequested && this.connectionGeneration === generation && this.client === client) {
          this.log.warn('sonos state stream stopped', {
            zoneId: this.zone.id,
            host: this.host,
            message: err instanceof Error ? err.message : String(err),
          });
          this.scheduleReconnect();
        }
      });
    } catch (err) {
      if (this.connectionGeneration !== generation || this.client !== client) {
        return;
      }
      this.log.warn('sonos state controller failed to start', {
        zoneId: this.zone.id,
        host: this.host,
        message: err instanceof Error ? err.message : String(err),
      });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopRequested || this.reconnectTimer) {
      return;
    }

    this.log.info('sonos reconnect scheduled', {
      zoneId: this.zone.id,
      host: this.host,
      delayMs: this.reconnectDelay,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopRequested) {
        void this.connect();
      }
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(
      this.reconnectDelay * RECONNECT_BACKOFF_FACTOR,
      RECONNECT_MAX_DELAY_MS,
    );
  }

  public async stop(): Promise<void> {
    this.stopRequested = true;
    this.stopTicker();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    await this.destroyClient();

    this.log.info('stopped sonos state controller', { zoneId: this.zone.id });
  }

  private async destroyClient(): Promise<void> {
    this.connectionGeneration += 1;
    if (this.unsubscribeEvent) {
      this.unsubscribeEvent();
      this.unsubscribeEvent = null;
    }

    const client = this.client;
    const startPromise = this.startPromise;
    this.client = null;
    this.startPromise = null;

    if (client) {
      try {
        await client.disconnect();
      } catch {
        // ignore disconnect failures
      }
    }
    if (startPromise) {
      await startPromise.catch(() => undefined);
    }
  }

  public handleCommand(command: string): boolean {
    const action = normalizeCommand(command);
    if (!action) {
      return false;
    }
    void this.dispatchCommand(action);
    return true;
  }

  private startTicker(): void {
    if (this.timeTicker) {
      clearInterval(this.timeTicker);
    }
    this.timeTicker = setInterval(() => {
      this.emitTimeTick();
    }, TIME_TICK_MS);
  }

  private stopTicker(): void {
    if (this.timeTicker) {
      clearInterval(this.timeTicker);
      this.timeTicker = null;
    }
  }

  private emitTimeTick(): void {
    const group = this.client?.player?.group;
    if (!group) {
      return;
    }
    const mode = mapPlaybackState(group.playbackState);
    if (mode !== 'play') {
      return;
    }
    const time = Math.max(0, Math.floor(group.positionSeconds));
    this.onStatePatch(this.zone.id, { time });
  }

  private emitSnapshotPatch(): void {
    const patch = this.buildSnapshotPatch();
    if (!patch || Object.keys(patch).length === 0) {
      return;
    }

    const snapshotSignature = [
      String(patch.mode ?? ''),
      String(patch.audiotype ?? ''),
      String(patch.sourceName ?? ''),
      String(patch.title ?? ''),
      String(patch.artist ?? ''),
      String(patch.album ?? ''),
      String(patch.station ?? ''),
    ].join('|');

    if (snapshotSignature !== this.lastLoggedSnapshotSignature) {
      this.lastLoggedSnapshotSignature = snapshotSignature;
      this.log.debug('sonos state update', {
        zoneId: this.zone.id,
        mode: patch.mode,
        audiotype: patch.audiotype,
        sourceName: patch.sourceName,
        title: patch.title,
        artist: patch.artist,
        album: patch.album,
        hasCover: Boolean(patch.coverurl),
        keys: Object.keys(patch),
      });
    }

    this.onStatePatch(this.zone.id, patch);
  }

  private buildSnapshotPatch(): Partial<LoxoneZoneState> | null {
    const player = this.client?.player;
    const group = player?.group;

    if (!player || !group) {
      return null;
    }

    const metadata = group.playbackMetadataStatus;
    const track = metadata?.currentItem?.track;
    const container = metadata?.container;

    const trackMediaUrl = cleanString(track?.mediaUrl);
    if (trackMediaUrl) {
      this.lastTrackMediaUrl = trackMediaUrl;
      this.lastTrackTitle = cleanString(track?.name) || cleanString(container?.name) || null;
    }

    const mode = mapPlaybackState(group.playbackState);
    const audiotype = resolveAudiotype(group, track?.mediaUrl ?? '', container?.type ?? '');
    const sourceName = resolveSourceName(audiotype, container?.name ?? '', group.name, this.zone.name);
    const title = cleanString(track?.name) || cleanString(container?.name) || sourceName;
    const artist = cleanString(track?.artist?.name) || cleanString(metadata?.streamInfo) || '';
    const album = cleanString(track?.album?.name) || '';

    const trackDurationSec =
      typeof track?.durationMillis === 'number' && Number.isFinite(track.durationMillis)
        ? Math.max(0, Math.round(track.durationMillis / 1000))
        : null;

    const time = Math.max(0, Math.floor(group.positionSeconds));

    const rawCover =
      normalizeCoverUrl(firstImage(track?.images), this.host) ||
      normalizeCoverUrl(firstImage(container?.images), this.host);

    const signature = `${title}|${artist}|${album}`;

    let coverurl = '';
    if (rawCover) {
      const coverChanged = this.lastCoverRaw !== rawCover;
      const trackChanged = this.lastTrackSignature !== signature;

      if (coverChanged || trackChanged) {
        this.coverRevision += 1;
        this.lastCoverRaw = rawCover;
      }

      coverurl = withCacheBust(rawCover, this.coverRevision);
    }

    this.lastTrackSignature = signature;

    const patch: Partial<LoxoneZoneState> = {
      audiopath: '',
      mode,
      power: 'on',
      clientState: 'on',
      audiotype,
      sourceName,
      title,
      artist,
      album,
      time,
    };

    if (typeof trackDurationSec === 'number') {
      patch.duration = trackDurationSec;
    }

    if (coverurl) {
      patch.coverurl = coverurl;
    }

    if ((audiotype === AudioType.LineIn || audiotype === AudioType.Bluetooth) && !artist && !album) {
      patch.station = '';
      patch.title = sourceName;
    }

    return patch;
  }

  private async dispatchCommand(action: 'play' | 'pause' | 'stop' | 'next' | 'previous'): Promise<void> {
    const group = this.client?.player?.group;
    if (!group) {
      this.log.warn('sonos command ignored; no active group', { zoneId: this.zone.id, action });
      return;
    }

    try {
      if (action === 'play') {
        await this.dispatchPlay(group);
      } else if (action === 'pause') await group.pause();
      else if (action === 'stop') await group.stop();
      else if (action === 'next') await group.skipToNextTrack();
      else await group.skipToPreviousTrack();

      this.log.info('sonos command sent', { zoneId: this.zone.id, action });
    } catch (err) {
      this.log.warn('sonos command failed', {
        zoneId: this.zone.id,
        action,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // For Sonos S2 a bare group.play() relies on the device's internal queue,
  // which decays after idle (radio stream sessions expire, container becomes
  // stale). The device then flips to PLAYING for ~200ms and drops back to
  // STOPPED. Re-issuing playStreamUrl with the cached media URL forces Sonos
  // to reload the source instead. Falls back to group.play() when paused
  // (resume should keep position) or when we have no cached URL / no
  // playStreamUrl (e.g. S1).
  private async dispatchPlay(group: AnySonosGroup): Promise<void> {
    const isPaused = String(group.playbackState ?? '').toUpperCase().includes('PAUSED');
    const canReload =
      !isPaused &&
      this.lastTrackMediaUrl != null &&
      'playStreamUrl' in group &&
      typeof (group as SonosGroup).playStreamUrl === 'function';
    if (canReload) {
      const container = {
        _objectType: 'container' as const,
        name: this.lastTrackTitle ?? this.zone.name,
        type: 'trackList',
      };
      await (group as SonosGroup).playStreamUrl(this.lastTrackMediaUrl!, container);
      return;
    }
    await group.play();
  }
}

function normalizeCommand(command: string): 'play' | 'pause' | 'stop' | 'next' | 'previous' | null {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'play' || normalized === 'resume') return 'play';
  if (normalized === 'pause') return 'pause';
  if (normalized === 'stop') return 'stop';
  if (normalized === 'next' || normalized === 'queueplus' || normalized === 'skip') return 'next';
  if (normalized === 'previous' || normalized === 'prev' || normalized === 'queueminus') return 'previous';
  return null;
}

function resolveSonosHost(zone: ZoneConfig): string | null {
  const output = resolvePrimaryOutput(zone);
  const controlUrl = output ? pickString(output.controlUrl) : null;
  const candidate =
    (output ? pickString(output.host) : null) ??
    (output ? pickString(output.ip) : null) ??
    (output ? pickString(output.address) : null) ??
    extractHostname(controlUrl);
  return candidate || null;
}

function resolvePrimaryOutput(zone: ZoneConfig): Record<string, unknown> | null {
  if (zone.output && typeof zone.output === 'object') {
    return zone.output as Record<string, unknown>;
  }
  if (Array.isArray(zone.transports) && zone.transports.length > 0) {
    const first = zone.transports[0];
    if (first && typeof first === 'object') {
      return first as Record<string, unknown>;
    }
  }
  return null;
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

function mapPlaybackState(state: string | null | undefined): LoxoneZoneState['mode'] {
  const token = String(state ?? '').toUpperCase();
  if (token.includes('PAUSED')) return 'pause';
  if (token.includes('PLAYING') || token.includes('BUFFERING')) return 'play';
  return 'stop';
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstImage(images: Array<{ url?: string }> | undefined): string {
  if (!Array.isArray(images)) return '';
  for (const image of images) {
    const url = typeof image?.url === 'string' ? image.url.trim() : '';
    if (url) return url;
  }
  return '';
}

function resolveAudiotype(group: AnySonosGroup, mediaUrl: string, containerType: string): number {
  const media = mediaUrl.toLowerCase();
  const type = containerType.toLowerCase();
  const service = String(group.activeService ?? '').toLowerCase();

  if (type.includes('linein') || media.startsWith('x-rincon-stream:') || media.startsWith('x-sonos-htastream:')) {
    return AudioType.LineIn;
  }
  if (type.includes('airplay')) {
    return AudioType.AirPlay;
  }
  if (media.startsWith('x-sonos-spotify:') || media.includes('spotify') || service === '9') {
    return AudioType.Spotify;
  }
  if (type.includes('station') || media.startsWith('x-rincon-mp3radio:') || media.startsWith('x-sonosapi-radio:')) {
    return AudioType.Radio;
  }
  return AudioType.File;
}

function resolveSourceName(
  audiotype: number,
  containerName: string,
  groupName: string,
  fallbackZoneName: string,
): string {
  if (audiotype === AudioType.Spotify) return 'Spotify';
  if (audiotype === AudioType.AirPlay) return 'AirPlay';
  if (audiotype === AudioType.LineIn) return containerName || 'Line In';
  return containerName || groupName || fallbackZoneName || 'Sonos';
}

function normalizeCoverUrl(value: string, host: string | null): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (!host) return null;
  if (trimmed.startsWith('/')) {
    return `http://${host}:1400${trimmed}`;
  }
  return `http://${host}:1400/${trimmed}`;
}

function withCacheBust(url: string, revision: number): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('cb', String(revision));
    return parsed.toString();
  } catch {
    const join = url.includes('?') ? '&' : '?';
    return `${url}${join}cb=${revision}`;
  }
}
