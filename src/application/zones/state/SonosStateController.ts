import { EventType, SonosClient, type SonosGroup, type SonosPlayer } from '@lox-audioserver/node-sonos';

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

// --- PATCH: reconnect configuration ---
const RECONNECT_INITIAL_DELAY_MS = 5_000;   // first retry after 5 s
const RECONNECT_MAX_DELAY_MS     = 60_000;  // cap retries at 60 s
const RECONNECT_BACKOFF_FACTOR   = 2;       // exponential back-off multiplier
// --------------------------------------

export class SonosStateController implements ZoneStateController {
  private readonly log = createLogger('Zones', 'StateController:Sonos');
  private readonly zone: ZoneConfig;
  private readonly onStatePatch: (zoneId: number, patch: Partial<LoxoneZoneState>) => void;
  private readonly host: string | null;

  private client: SonosClient | null = null;
  private startPromise: Promise<void> | null = null;
  private stopRequested = false;
  private unsubscribeEvent: (() => void) | null = null;
  private timeTicker: NodeJS.Timeout | null = null;

  // --- PATCH: reconnect state ---
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_INITIAL_DELAY_MS;
  // ------------------------------

  private lastCoverRaw: string | null = null;
  private coverRevision = 0;
  private lastTrackSignature = '';
  private lastLoggedSnapshotSignature = '';

  constructor(options: SonosControllerOptions) {
    this.zone = options.zone;
    this.onStatePatch = options.onStatePatch;
    this.host = resolveSonosHost(this.zone);
  }

  public async start(): Promise<void> {
    this.stopRequested = false;
    this.reconnectDelay = RECONNECT_INITIAL_DELAY_MS; // reset back-off on fresh start
    await this.connect();
  }

  // --- PATCH: extracted connect logic, called both on start and on reconnect ---
  private async connect(): Promise<void> {
    if (this.stopRequested) return;

    if (!this.host) {
      this.log.warn('state controller sonos enabled but zone output has no usable host/ip');
      return;
    }

    // Clean up any pre-existing client before (re-)connecting
    await this.destroyClient();

    this.client = new SonosClient(this.host, { logger: console });

    this.unsubscribeEvent = this.client.subscribe((event) => {
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
        // PATCH: schedule reconnect on unexpected disconnect
        this.scheduleReconnect();
      }
    });

    try {
      await this.client.connect();
      this.log.info('sonos state controller connected', {
        zoneId: this.zone.id,
        zoneName: this.zone.name,
        host: this.host,
      });

      // PATCH: reset back-off on successful connect
      this.reconnectDelay = RECONNECT_INITIAL_DELAY_MS;

      this.emitSnapshotPatch();
      this.startTicker();

      this.startPromise = this.client.start().catch((err) => {
        if (!this.stopRequested) {
          this.log.warn('sonos state stream stopped', {
            zoneId: this.zone.id,
            host: this.host,
            message: err instanceof Error ? err.message : String(err),
          });
          // PATCH: stream ended unexpectedly — reconnect
          this.scheduleReconnect();
        }
      });
    } catch (err) {
      this.log.warn('sonos state controller failed to start', {
        zoneId: this.zone.id,
        host: this.host,
        message: err instanceof Error ? err.message : String(err),
      });
      // PATCH: connect failed — schedule a retry instead of giving up
      this.scheduleReconnect();
    }
  }

  // --- PATCH: schedule a reconnect attempt with exponential back-off ---
  private scheduleReconnect(): void {
    if (this.stopRequested) return;
    if (this.reconnectTimer) return; // already scheduled

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

    // Exponential back-off, capped at max
    this.reconnectDelay = Math.min(
      this.reconnectDelay * RECONNECT_BACKOFF_FACTOR,
      RECONNECT_MAX_DELAY_MS,
    );
  }
  // -----------------------------------------------------------------------

  public async stop(): Promise<void> {
    this.stopRequested = true;
    this.stopTicker();

    // PATCH: cancel any pending reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    await this.destroyClient();

    if (this.startPromise) {
      await this.startPromise.catch(() => undefined);
      this.startPromise = null;
    }

    this.log.info('stopped sonos state controller', { zoneId: this.zone.id });
  }

  // --- PATCH: helper to cleanly tear down the current client ---
  private async destroyClient(): Promise<void> {
    if (this.unsubscribeEvent) {
      this.unsubscribeEvent();
      this.unsubscribeEvent = null;
    }

    const client = this.client;
    this.client = null;

    if (client) {
      try {
        await client.disconnect();
      } catch {
        // ignore disconnect failures
      }
    }
  }
  // --------------------------------------------------------------

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
      if (action === 'play') await group.play();
      else if (action === 'pause') await group.pause();
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

function resolveAudiotype(group: SonosGroup, mediaUrl: string, containerType: string): number {
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
