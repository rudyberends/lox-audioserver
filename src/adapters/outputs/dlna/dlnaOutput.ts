import { createLogger } from '@/shared/logging/logger';
import type { PlaybackSession } from '@/application/playback/audioManager';
import type { HttpPreferences, PreferredOutput, OutputConfigDefinition, ZoneOutput } from '@/ports/OutputsTypes';
import { decodeAudiopath } from '@/domain/loxone/audiopath';
import { isHttpUrl, resolveSessionCover } from '@/shared/coverArt';
import { buildBaseUrl, normalizeStreamUrl, resolveAbsoluteUrl } from '@/shared/streamUrl';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';
import {
  DlnaControlPoint,
  type DlnaTransportEvent,
  type DlnaRenderingEvent,
} from '@sonn-audio/node-upnp';

export interface DlnaOutputConfig {
  host?: string;
  controlUrl?: string;
  autoDiscover?: boolean | string;
  deviceName?: string;
}

export const DLNA_OUTPUT_DEFINITION: OutputConfigDefinition = {
  id: 'dlna',
  label: 'DLNA / UPnP AVTransport',
  description: 'Streams audio to a DLNA renderer by issuing AVTransport commands.',
  fields: [
    {
      id: 'host',
      label: 'Renderer IP or hostname',
      type: 'text',
      placeholder: '192.168.1.50',
      description:
        'Optional IP or hostname of the DLNA renderer. When provided, the control URLs are auto-discovered via SSDP.',
    },
    {
      id: 'controlUrl',
      label: 'AVTransport control URL',
      type: 'text',
      placeholder: 'http://192.168.1.50:12345/Control/AVTransport',
      description:
        'Optional manual AVTransport endpoint. Use this only when discovery is not working yet.',
    },
    {
      id: 'autoDiscover',
      label: 'Auto discover',
      type: 'text',
      placeholder: 'true',
      description:
        "When host isn't set, discover a DLNA renderer via SSDP (true/false). Defaults to true.",
    },
    {
      id: 'deviceName',
      label: 'Preferred device name',
      type: 'text',
      placeholder: 'Living Room',
      description:
        'Used to match a discovered renderer by its friendly name. If omitted, the zone name is used.',
    },
  ],
};

function isAutoDiscoverEnabled(value: boolean | string | undefined): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  // Default to true so a zone with neither host nor controlUrl still self-discovers.
  return true;
}

/**
 * DLNA push output — a thin app adapter over the module's {@link DlnaControlPoint},
 * which owns the whole UPnP control-point protocol (endpoint discovery, the
 * Stop→SetURI→Play sequence with its silent-timeout-as-accepted and 701-retry
 * quirks, command serialization, and GENA event subscription).
 *
 * What stays here is app glue the module deliberately leaves to the host: building
 * DIDL from a PlaybackSession, resolving the stream URI + cover art, the per-track
 * dedup, the volume anti-feedback guard, and routing GENA volume events into zone
 * state. Transport-state is intentionally NOT reflected back (see onRemoteTransport).
 */
export class DlnaOutput implements ZoneOutput {
  public readonly type = 'dlna';
  private readonly log = createLogger('Output', 'DLNA');
  private readonly cp: DlnaControlPoint;
  // Per-track identity of the stream currently pushed to the renderer. Rotates each track
  // (session.stream.id), so it dedups the intra-track play() storm without swallowing the
  // next track (whose normalized URL is identical).
  private currentStreamKey: string | null = null;
  // Last URI + metadata signature pushed via SetAVTransportURI, so a later
  // updateMetadata can detect a meaningful change (e.g. title/duration arriving
  // after the initial play) and refresh now-playing without restarting playback.
  private lastPushedUri: string | null = null;
  private lastMetadataSignature: string | null = null;
  // Anti-feedback guard for VOLUME: our own SetVolume must not bounce back as a spurious user
  // change. (Transport-state is not reflected back — see onRemoteTransport.)
  private lastOutboundVolume?: number;
  private lastOutboundVolumeAt = 0;
  private lastKnownVolume?: number;
  private lastKnownMuted?: boolean;
  private eventsSubscribed = false;

  constructor(
    private readonly zoneId: number,
    private readonly zoneName: string,
    config: DlnaOutputConfig,
    private readonly ports: OutputPorts,
  ) {
    const host = typeof config.host === 'string' ? config.host.trim() : '';
    const autoDiscover = isAutoDiscoverEnabled(config.autoDiscover);
    // Fall back to the zone name so auto-discovery can match a renderer by friendly name.
    const deviceName =
      typeof config.deviceName === 'string' && config.deviceName.trim().length > 0
        ? config.deviceName.trim()
        : this.zoneName;
    const controlUrl =
      typeof config.controlUrl === 'string' && config.controlUrl.trim().length > 0
        ? config.controlUrl.trim()
        : undefined;
    this.cp = new DlnaControlPoint({
      host,
      controlUrl,
      autoDiscover,
      deviceName,
      commandTimeoutMs: 2500,
      logger: this.log,
    });
    if (controlUrl) {
      this.log.info('DLNA output configured with manual control URL', {
        zoneId: this.zoneId,
        zone: this.zoneName,
        controlUrl,
      });
    } else if (host) {
      this.log.info('DLNA output awaiting discovery', { zoneId: this.zoneId, zone: this.zoneName, host });
    } else if (autoDiscover) {
      this.log.info('DLNA output awaiting SSDP auto-discovery', {
        zoneId: this.zoneId,
        zone: this.zoneName,
        deviceName,
      });
    } else {
      this.log.warn('DLNA output has no host or control URL configured', {
        zoneId: this.zoneId,
        zone: this.zoneName,
      });
    }
  }

  public async play(session: PlaybackSession): Promise<void> {
    if (!session.playbackSource) {
      this.log.debug('DLNA output skipped', { zoneId: this.zoneId, source: session.source });
      return;
    }
    await this.ensureEvents();
    const uri = this.resolveStreamUri(session);
    if (!uri) {
      this.log.warn('no playable URI for session', { zoneId: this.zoneId });
      return;
    }
    const streamUri = this.normalizeDlnaStreamUri(uri);
    // Coalesce the burst of duplicate play() calls WITHIN one track, but always re-push on a
    // new track. The stream URL normalizes to a stable `current.mp3`, so it can't distinguish
    // tracks — but `session.stream.id` rotates per track while staying constant across a
    // track's ffmpeg re-spawn storm. Dedup on that id, not the URL, or track 2 gets swallowed.
    const streamKey = session.stream.id;
    if (streamKey && streamKey === this.currentStreamKey) {
      this.log.debug('DLNA play skipped; stream already active', { zoneId: this.zoneId, streamKey });
      return;
    }
    this.currentStreamKey = streamKey;
    const didl = this.buildDidlMetadata(streamUri, session);
    // Remember what we pushed so a later metadata update can decide whether to re-push (see
    // updateMetadata). The initial play() often fires before track metadata/duration has
    // resolved, so the first DIDL can be a title-less, duration-less audioBroadcast ("live").
    this.lastPushedUri = streamUri;
    this.lastMetadataSignature = this.metadataSignature(session);
    // NOTE: the old adapter had a `waitForStreamRequest` fallback on a hard SetURI fault before
    // Play. The module's setUri() drops that (it proceeds straight to Play, whose 701-retry is
    // the real readiness gate) — behavior change to watch on a renderer that hard-faults SetURI.
    await this.cp.setUri(streamUri, didl);
  }

  /**
   * Refresh the renderer's now-playing when track metadata arrives after the
   * initial play() — the common case being title/artist/duration resolving a
   * moment later, which flips the item from a duration-less `audioBroadcast`
   * ("live") to a `musicTrack` with a progress bar.
   *
   * Re-sends SetAVTransportURI ONLY (no Stop/Play) so playback isn't interrupted;
   * deduped on a metadata signature so an unchanged update is a no-op.
   */
  public async updateMetadata(session: PlaybackSession | null): Promise<void> {
    if (!session) {
      return;
    }
    const uri = this.lastPushedUri;
    if (!uri) {
      return;
    }
    const signature = this.metadataSignature(session);
    if (signature === this.lastMetadataSignature) {
      return;
    }
    this.lastMetadataSignature = signature;
    const didl = this.buildDidlMetadata(uri, session);
    await this.cp.updateMetadata(uri, didl);
  }

  public async pause(session: PlaybackSession | null): Promise<void> {
    if (!session?.playbackSource) {
      return;
    }
    // Clear the dedup key so a resume/play of the SAME track re-issues transport commands
    // instead of being coalesced away (its stream.id is unchanged across pause→resume).
    this.currentStreamKey = null;
    await this.cp.pause();
  }

  public async resume(session: PlaybackSession | null): Promise<void> {
    if (session) {
      await this.play(session);
      return;
    }
    await this.cp.play();
  }

  public async stop(session: PlaybackSession | null): Promise<void> {
    if (!session?.playbackSource) {
      return;
    }
    this.currentStreamKey = null;
    await this.cp.stop();
  }

  public async setVolume(level: number): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Math.round(level)));
    // Record before sending so a GENA volume echo from this same change is suppressed.
    this.lastOutboundVolume = clamped;
    this.lastOutboundVolumeAt = Date.now();
    this.lastKnownVolume = clamped;
    if (await this.cp.setVolume(clamped)) {
      this.log.info('DLNA volume set', { zoneId: this.zoneId, volume: clamped });
    }
  }

  public dispose(): void {
    this.cp.dispose();
    this.log.debug('disposed', { zoneId: this.zoneId });
  }

  public getPreferredOutput(): PreferredOutput {
    // DLNA renderers often accept MP3/PCM; prefer MP3 to reduce bandwidth unless group/lead needs PCM.
    return { profile: 'mp3', sampleRate: 44100, channels: 2 };
  }

  public getHttpPreferences(): HttpPreferences {
    // Many DLNA renderers prefer explicit content-length; disable ICY.
    return { httpProfile: 'forced_content_length', icyEnabled: false };
  }

  /** Start the GENA event subscription once, so device-side volume flows into zone state. */
  private async ensureEvents(): Promise<void> {
    if (this.eventsSubscribed) {
      return;
    }
    this.eventsSubscribed = true;
    const localHost = this.ports.config.getSystemConfig().audioserver?.ip?.trim() || '127.0.0.1';
    try {
      await this.cp.subscribeEvents(
        {
          onTransport: (event) => this.onRemoteTransport(event),
          onRendering: (event) => this.onRemoteRendering(event),
        },
        localHost,
      );
    } catch (err) {
      this.log.debug('DLNA event subscription failed', {
        zoneId: this.zoneId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * A compact fingerprint of the now-playing-relevant metadata. Changes when the
   * title/artist/album/duration or the broadcast-vs-track distinction changes, so
   * updateMetadata re-pushes exactly when the renderer's display would differ.
   */
  private metadataSignature(session: PlaybackSession): string {
    const m = session.metadata;
    const duration = session.duration || m?.duration || 0;
    const isStream = m?.isRadio || m?.isAlert || !duration ? 1 : 0;
    return [m?.title ?? '', m?.artist ?? '', m?.album ?? '', duration, isStream].join('|');
  }

  private buildDidlMetadata(uri: string, session: PlaybackSession): string {
    const title = session.metadata?.title || this.zoneName;
    const artist = session.metadata?.artist || '';
    const album = session.metadata?.album || '';
    const cover = this.resolveCoverArt(session);
    // Radio/alerts are open-ended broadcasts; a track advertises its duration so the renderer
    // can show a progress bar. Alerts must stay duration-less (see Sonos notes) to avoid a clip.
    const duration =
      session.metadata?.isRadio || session.metadata?.isAlert
        ? ''
        : this.formatDlnaDuration(session.duration);
    const isStream = !duration;
    const mediaClass = isStream
      ? 'object.item.audioItem.audioBroadcast'
      : 'object.item.audioItem.musicTrack';
    const durationAttr = duration ? ` duration="${duration}"` : '';
    // DLNA.ORG_PN=MP3 names the profile in the 4th protocolInfo field. Strict sinks
    // (B&O) validate it and can refuse an item's now-playing metadata when no
    // recognized profile is present — the same fix applied to the MediaServer's
    // <res>. OP=00 stays consistent with the stream's Accept-Ranges: none.
    const protocolInfo =
      'http-get:*:audio/mpeg:DLNA.ORG_PN=MP3;DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=8D500000000000000000000000000000';
    const art = cover ? `<upnp:albumArtURI>${escapeXml(cover)}</upnp:albumArtURI>` : '';
    return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>${escapeXml(title)}</dc:title><dc:creator>${escapeXml(artist)}</dc:creator><upnp:artist>${escapeXml(artist)}</upnp:artist><upnp:album>${escapeXml(album)}</upnp:album>${art}<upnp:class>${mediaClass}</upnp:class><res${durationAttr} protocolInfo="${protocolInfo}">${escapeXml(uri)}</res></item></DIDL-Lite>`;
  }

  private resolveCoverArt(session: PlaybackSession): string {
    const coverSource = resolveSessionCover(session);
    if (!coverSource) {
      return '';
    }
    // Prefer a real, externally-fetchable cover URL; otherwise fall back to our /cover proxy
    // path made absolute so the renderer can fetch it. Mirrors the Sonos output's approach.
    if (isHttpUrl(coverSource)) {
      return coverSource;
    }
    return resolveAbsoluteUrl(this.buildBaseUrl(), session.stream.coverUrl) ?? coverSource;
  }

  private formatDlnaDuration(durationSeconds: number | undefined): string {
    const total = Math.max(0, Math.floor(Number(durationSeconds ?? 0)));
    if (!total) {
      return '';
    }
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  private resolveStreamUri(session: PlaybackSession): string | null {
    const streamUrl = session.stream.url;
    if (streamUrl) {
      const absolute = resolveAbsoluteUrl(this.buildBaseUrl(), streamUrl);
      if (absolute) {
        return absolute;
      }
    }
    const decoded = decodeAudiopath(session.source);
    if (isHttpUrl(decoded)) {
      return decoded;
    }
    return null;
  }

  private normalizeDlnaStreamUri(uri: string): string {
    return normalizeStreamUrl(uri, this.buildBaseUrl(), ['mp3']);
  }

  private buildBaseUrl(): string {
    const sys = this.ports.config.getSystemConfig();
    return buildBaseUrl({
      host: sys.audioserver.ip?.trim(),
      fallbackHost: '127.0.0.1',
    });
  }

  private onRemoteTransport(event: DlnaTransportEvent): void {
    // We subscribe to AVTransport so the renderer keeps sending RenderingControl (volume)
    // events on the same connection, and for future use, but we deliberately do NOT reflect
    // device-side play/pause back into zone state. For a push output feeding a non-resumable
    // source (line-in/AirPlay/radio), routing the device's transport state into the zone either
    // tears the engine down (pause pipeline) or fights the zone state machine — both observed to
    // break playback and disable volume. Device pause/resume still works audibly (the renderer
    // pauses its own read of our stream); only the UI play/pause indicator won't mirror it.
    this.log.debug('DLNA remote transport event (state reflection disabled)', {
      zoneId: this.zoneId,
      transportState: event.transportState,
    });
  }

  private onRemoteRendering(event: DlnaRenderingEvent): void {
    if (typeof event.volume === 'number' && Number.isFinite(event.volume)) {
      const vol = Math.min(100, Math.max(0, Math.round(event.volume)));
      const now = Date.now();
      const recentlySent = this.lastOutboundVolumeAt > 0 && now - this.lastOutboundVolumeAt < 1500;
      const outboundMatches =
        this.lastOutboundVolume != null && Math.abs(vol - this.lastOutboundVolume) <= 2;
      const suppressed = recentlySent && outboundMatches;
      this.log.debug('DLNA remote volume event', {
        zoneId: this.zoneId,
        vol,
        suppressed,
        unchanged: vol === this.lastKnownVolume,
      });
      if (!suppressed && vol !== this.lastKnownVolume) {
        this.lastKnownVolume = vol;
        this.ports.zoneManager.handleCommand(this.zoneId, 'volume_set', String(vol));
      }
    }
    if (typeof event.muted === 'boolean') {
      // Only act on an actual mute-state CHANGE. RenderingControl NOTIFYs (including the
      // periodic keep-alive/renew snapshots) always carry <Mute val="0"/>, so firing on every
      // event re-sent SetVolume every ~25s on an idle zone (issue #314, stiwy18). First event
      // just seeds lastKnownMuted without emitting.
      const first = this.lastKnownMuted === undefined;
      if (!first && event.muted !== this.lastKnownMuted) {
        this.ports.zoneManager.handleCommand(
          this.zoneId,
          'volume_set',
          event.muted ? '0' : String(this.lastKnownVolume ?? 0),
        );
      }
      this.lastKnownMuted = event.muted;
    }
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
