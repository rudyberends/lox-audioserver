import { setTimeout as delay } from 'node:timers/promises';
import { createLogger } from '@/shared/logging/logger';
import { safeReadText } from '@/shared/bestEffort';
import type { PlaybackSession } from '@/application/playback/audioManager';
import type { HttpPreferences, PreferredOutput, OutputConfigDefinition, ZoneOutput } from '@/ports/OutputsTypes';
import { decodeAudiopath } from '@/domain/loxone/audiopath';
import { isHttpUrl, resolveSessionCover } from '@/shared/coverArt';
import { buildBaseUrl, normalizeStreamUrl, resolveAbsoluteUrl } from '@/shared/streamUrl';
import { resolveDlnaEndpoints, discoverDlnaDevices } from '@/adapters/outputs/dlna/dlnaDiscovery';
import { DlnaEventSubscriber } from '@/adapters/outputs/dlna/dlnaEventSubscriber';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';

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

export class DlnaOutput implements ZoneOutput {
  public readonly type = 'dlna';
  private readonly log = createLogger('Output', 'DLNA');
  private readonly controllers = new Set<AbortController>();
  private readonly commandTimeoutMs = 2500;
  private host: string;
  private controlUrl?: string;
  private renderingControlUrl?: string;
  private discoveryPromise?: Promise<boolean>;
  private readonly autoDiscover: boolean;
  private readonly deviceName: string;
  // DLNA is a stateful push output: every play() sends a full Stop→SetURI→Play sequence to
  // physical hardware. The coordinator fires play() many times in a burst (e.g. Apple Music
  // buffer handoff re-spawns ffmpeg), so we serialize commands into a single chain and skip
  // a redundant re-send when the same URI is already playing — otherwise overlapping
  // sequences leave the renderer stuck TRANSITIONING and every Play faults with 701.
  private commandChain: Promise<void> = Promise.resolve();
  // Per-track identity of the stream currently pushed to the renderer. Rotates each track
  // (session.stream.id), so it dedups the intra-track play() storm without swallowing the
  // next track (whose normalized URL is identical).
  private currentStreamKey: string | null = null;
  // GENA event subscriber for device-side state (play/pause/stop/volume from the renderer).
  private eventSubscriber?: DlnaEventSubscriber;
  private avTransportEventUrl?: string;
  private renderingControlEventUrl?: string;
  private eventDiscoveryStarted = false;
  // Anti-feedback guard for VOLUME: our own SetVolume must not bounce back as a spurious user
  // change. (Transport-state is not reflected back — see handleRemoteTransport.)
  private lastOutboundVolume?: number;
  private lastOutboundVolumeAt = 0;
  private lastKnownVolume?: number;

  constructor(
    private readonly zoneId: number,
    private readonly zoneName: string,
    config: DlnaOutputConfig,
    private readonly ports: OutputPorts,
  ) {
    this.host = typeof config.host === 'string' ? config.host.trim() : '';
    this.autoDiscover = isAutoDiscoverEnabled(config.autoDiscover);
    this.deviceName =
      typeof config.deviceName === 'string' && config.deviceName.trim().length > 0
        ? config.deviceName.trim()
        : this.zoneName;
    if (typeof config.controlUrl === 'string' && config.controlUrl.trim().length > 0) {
      this.controlUrl = config.controlUrl.trim();
      this.renderingControlUrl = this.deriveRenderingUrl(this.controlUrl);
      this.log.info('DLNA output configured with manual control URL', {
        zoneId: this.zoneId,
        zone: this.zoneName,
        controlUrl: this.controlUrl,
      });
    } else if (this.host) {
      this.log.info('DLNA output awaiting discovery', {
        zoneId: this.zoneId,
        zone: this.zoneName,
        host: this.host,
      });
    } else if (this.autoDiscover) {
      this.log.info('DLNA output awaiting SSDP auto-discovery', {
        zoneId: this.zoneId,
        zone: this.zoneName,
        deviceName: this.deviceName,
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
    if (!(await this.ensureEndpoints())) {
      return;
    }
    const uri = this.resolveStreamUri(session);
    if (!uri) {
      this.log.warn('no playable URI for session', { zoneId: this.zoneId });
      return;
    }
    const streamUri = this.normalizeDlnaStreamUri(uri, session);
    // Coalesce the burst of duplicate play() calls WITHIN one track, but always re-push on a
    // new track. The stream URL normalizes to a stable `current.mp3`, so it can't distinguish
    // tracks — but `session.stream.id` rotates per track while staying constant across a
    // track's ffmpeg re-spawn storm. Dedup on that id, not the URL, or track 2 gets swallowed.
    const streamKey = session.stream.id;
    if (streamKey && streamKey === this.currentStreamKey) {
      this.log.debug('DLNA play skipped; stream already active', {
        zoneId: this.zoneId,
        streamKey,
      });
      return;
    }
    this.currentStreamKey = streamKey;
    await this.enqueue(() => this.sendPlaybackWithSoap(streamUri, session));
  }

  /**
   * Run a SOAP command sequence strictly after any previous one for this output has settled,
   * so overlapping Stop/SetURI/Play sequences can never interleave on the renderer.
   */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.commandChain.then(task, task);
    // Keep the chain alive even if a task throws, but don't leak the rejection.
    this.commandChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  public async pause(session: PlaybackSession | null): Promise<void> {
    if (!session?.playbackSource) {
      return;
    }
    if (!(await this.ensureEndpoints())) {
      return;
    }
    // Clear the dedup key so a resume/play of the SAME track re-issues transport commands
    // instead of being coalesced away (its stream.id is unchanged across pause→resume).
    this.currentStreamKey = null;
    await this.enqueue(() => this.runCommand('Pause', this.buildPauseBody()));
  }

  public async resume(session: PlaybackSession | null): Promise<void> {
    if (session) {
      await this.play(session);
      return;
    }
    if (!(await this.ensureEndpoints())) {
      return;
    }
    await this.enqueue(() => this.runCommand('Play', this.buildPlayBody()));
  }

  public async stop(session: PlaybackSession | null): Promise<void> {
    if (!session?.playbackSource) {
      return;
    }
    if (!(await this.ensureEndpoints())) {
      return;
    }
    this.currentStreamKey = null;
    await this.enqueue(() => this.runCommand('Stop', this.buildStopBody()));
  }

  public async setVolume(level: number): Promise<void> {
    if (!(await this.ensureEndpoints())) {
      return;
    }
    const url = this.renderingControlUrl;
    if (!url) {
      this.log.debug('rendering control URL missing; skipping volume update', {
        zoneId: this.zoneId,
      });
      return;
    }
    const clamped = Math.max(0, Math.min(100, Math.round(level)));
    // Record before sending so a GENA volume echo from this same change is suppressed.
    this.lastOutboundVolume = clamped;
    this.lastOutboundVolumeAt = Date.now();
    this.lastKnownVolume = clamped;
    if (
      await this.invokeRenderingAction('SetVolume', this.buildSetVolumeBody(clamped), {
        optional: true,
      })
    ) {
      this.log.info('DLNA volume set', { zoneId: this.zoneId, volume: clamped });
    }
  }

  public dispose(): void {
    for (const controller of this.controllers) {
      controller.abort();
    }
    this.controllers.clear();
    this.eventSubscriber?.dispose();
    this.eventSubscriber = undefined;
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

  private async ensureEndpoints(): Promise<boolean> {
    if (this.controlUrl) {
      // Control URL is known (manual config or prior discovery), so playback works. But event
      // URLs may not be resolved yet — a manually-configured controlUrl skips discovery
      // entirely. Fetch the device description once in the background to enable GENA eventing
      // (bidirectional state) without blocking playback.
      if (
        this.host &&
        !this.avTransportEventUrl &&
        !this.renderingControlEventUrl &&
        !this.eventDiscoveryStarted
      ) {
        this.eventDiscoveryStarted = true;
        void this.resolveEventEndpoints();
      }
      return true;
    }
    if (this.discoveryPromise) {
      return this.discoveryPromise;
    }
    if (!this.host && !this.autoDiscover) {
      this.log.warn('DLNA command skipped; no host or control URL configured', {
        zoneId: this.zoneId,
      });
      return false;
    }
    this.discoveryPromise = this.resolveEndpoints().finally(() => {
      this.discoveryPromise = undefined;
    });
    return this.discoveryPromise;
  }

  private async resolveEndpoints(): Promise<boolean> {
    // Without an explicit host, browse the network and match a renderer by friendly name.
    if (!this.host && this.autoDiscover) {
      const resolvedHost = await this.autoResolveHost();
      if (!resolvedHost) {
        return false;
      }
      this.host = resolvedHost;
    }
    const info = await resolveDlnaEndpoints({ host: this.host });
    if (info) {
      this.applyDiscoveredEndpoints(info);
      return true;
    }
    this.log.warn('no DLNA endpoints discovered', { zoneId: this.zoneId, host: this.host });
    return false;
  }

  /**
   * Best-effort background fetch of the renderer's event (GENA) endpoints when only a control
   * URL was known. Does not affect playback; on success it starts the event subscription.
   */
  private async resolveEventEndpoints(): Promise<void> {
    try {
      const info = await resolveDlnaEndpoints({ host: this.host });
      if (info?.avTransportEventUrl || info?.renderingControlEventUrl) {
        if (info.avTransportEventUrl) {
          this.avTransportEventUrl = info.avTransportEventUrl;
        }
        if (info.renderingControlEventUrl) {
          this.renderingControlEventUrl = info.renderingControlEventUrl;
        }
        this.ensureEventSubscription();
      }
    } catch (err) {
      this.log.debug('DLNA event endpoint resolve failed', {
        zoneId: this.zoneId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async autoResolveHost(): Promise<string> {
    const devices = await discoverDlnaDevices({});
    if (!devices.length) {
      this.log.warn('DLNA auto-discovery found no renderers', {
        zoneId: this.zoneId,
        deviceName: this.deviceName,
      });
      return '';
    }
    const preferred = this.deviceName.toLowerCase();
    const match =
      devices.find((device) => (device.name ?? '').toLowerCase() === preferred) ??
      devices[0];
    if (!match?.host) {
      return '';
    }
    this.log.info('DLNA renderer auto-discovered', {
      zoneId: this.zoneId,
      host: match.host,
      name: match.name,
      matchedByName: (match.name ?? '').toLowerCase() === preferred,
    });
    return match.host;
  }

  private async sendPlaybackWithSoap(uri: string, session: PlaybackSession): Promise<void> {
    this.log.info('sending playback command', { zoneId: this.zoneId, uri });
    await this.runCommand('Stop', this.buildStopBody(), { optional: true });
    const didl = this.buildDidlMetadata(uri, session);

    // Many renderers (measured: B&O/QPlay) accept SetAVTransportURI but never send a SOAP
    // reply, so a long timeout just stalls us for the full window before Play — this was the
    // ~minute start delay. Use a short timeout and treat a timeout as "probably accepted":
    // the renderer has taken the URI, and the Play step below (with 701 retry) confirms it.
    // Single attempt: a renderer that replies does so in well under this window, and one that
    // stays silent won't reply to a retry either — retrying only stacks another stall. The
    // Play step's 701 retry is the real readiness check, so a slightly-too-short window here
    // is harmless: Play just retries until the renderer is out of TRANSITIONING.
    let timedOut = false;
    const didSetUri = await this.invokeActionWithRetry('SetAVTransportURI', this.buildSetUriBody(uri, didl), 1, {
      timeoutMs: 1500,
      timeoutOk: true,
      onTimeout: () => {
        timedOut = true;
      },
    });

    // Only fall back to waiting on a stream request when SetURI came back with a hard fault
    // (didSetUri false *without* a timeout). A silent timeout means the URI was likely set,
    // so we proceed straight to Play instead of burning another 12s+ here.
    if (!didSetUri && !timedOut) {
      this.log.warn('DLNA SetAVTransportURI faulted; waiting for stream request before Play', {
        zoneId: this.zoneId,
      });
      const seen = await this.ports.outputStreamEvents.waitForStreamRequest({
        zoneId: this.zoneId,
        host: this.host,
        timeoutMs: 12000,
      });
      if (!seen) {
        this.log.warn('DLNA stream request not observed; skipping Play', { zoneId: this.zoneId });
        return;
      }
    }

    await delay(200);
    // Retry Play while the renderer may still be TRANSITIONING (701). Renderers that replied
    // to SetURI are ready almost immediately; silent ones (timedOut) get a touch more slack.
    const playAttempts = 6;
    const playDelay = timedOut ? 600 : 300;
    if (
      !(await this.invokeActionWithRetry('Play', this.buildPlayBody(), playAttempts, {
        retryDelayMs: playDelay,
        retryFaultCodes: ['701'],
      }))
    ) {
      this.log.warn('DLNA Play did not succeed after retries', { zoneId: this.zoneId, uri });
      return;
    }
    this.log.info('DLNA playback started', { zoneId: this.zoneId, uri });
  }

  private async runCommand(action: string, body: string, options: InvokeOptions = {}): Promise<void> {
    await this.invokeAction(action, body, options);
  }

  private async invokeActionWithRetry(
    action: string,
    body: string,
    attempts: number,
    options: InvokeOptions = {},
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const success = await this.invokeAction(action, body, options);
      if (success) {
        return true;
      }
      if (attempt < attempts) {
        await delay(options.retryDelayMs ?? 150);
      }
    }
    return false;
  }

  private async invokeAction(
    action: string,
    body: string,
    options: InvokeOptions = {},
  ): Promise<boolean> {
    if (!this.controlUrl) {
      this.log.warn('AVTransport command skipped; endpoint unknown', {
        action,
        zoneId: this.zoneId,
      });
      return false;
    }
    return this.invokeServiceAction(this.controlUrl, 'AVTransport', action, body, options);
  }

  private async invokeRenderingAction(
    action: string,
    body: string,
    options: InvokeOptions = {},
  ): Promise<boolean> {
    if (!this.renderingControlUrl) {
      this.log.debug('RenderingControl command skipped; endpoint unknown', {
        action,
        zoneId: this.zoneId,
      });
      return false;
    }
    return this.invokeServiceAction(
      this.renderingControlUrl,
      'RenderingControl',
      action,
      body,
      options,
    );
  }

  private async invokeServiceAction(
    url: string,
    service: 'AVTransport' | 'RenderingControl',
    action: string,
    body: string,
    options: InvokeOptions = {},
  ): Promise<boolean> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.commandTimeoutMs);
    timeout.unref();
    try {
      this.log.debug('DLNA soap request', { action, service, zoneId: this.zoneId });
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPAction: `"urn:schemas-upnp-org:service:${service}:1#${action}"`,
        },
        body,
        signal: controller.signal,
      });

      const text = await safeReadText(response, '', {
        onError: 'debug',
        log: this.log,
        label: 'dlna output response read failed',
        context: { status: response.status },
      });
      if (!response.ok && response.status !== 500) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      }
      if (response.ok) {
        this.log.info('DLNA action succeeded', { action, service, zoneId: this.zoneId });
        return true;
      }
      const fault = text.slice(0, 2000);
      // Some renderers (notably B&O/QPlay) briefly sit in TRANSITIONING right after
      // SetAVTransportURI and reject Play with 701 "Transition not available". That's a
      // transient we want to *retry*, not soft-accept — soft-accepting reports success while
      // the renderer never actually started (this was the source of the long start delay).
      const errorCode = /<errorCode>\s*(\d+)\s*<\/errorCode>/i.exec(fault)?.[1];
      if (errorCode && options.retryFaultCodes?.includes(errorCode)) {
        this.log.debug('DLNA action returned retryable SOAP fault', {
          action,
          service,
          errorCode,
          zoneId: this.zoneId,
        });
        return false;
      }
      const logPayload = {
        action,
        status: response.status,
        service,
        zoneId: this.zoneId,
        body: fault,
      };
      this.log.warn('DLNA action returned SOAP fault', logPayload);
      if (options.softFaultOk) {
        return true;
      }
      return options.optional ?? false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isAbort = error instanceof Error && error.name === 'AbortError';
      if (isAbort && options.timeoutOk) {
        this.log.debug('DLNA request timed out; continuing', { action, service, zoneId: this.zoneId });
        options.onTimeout?.();
        return false;
      }
      if (options.optional) {
        this.log.debug('optional command failed', { action, service, message, zoneId: this.zoneId });
      } else {
        this.log.warn('command failed', { action, service, message, zoneId: this.zoneId });
      }
      return options.optional ?? false;
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
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
    const protocolInfo =
      'http-get:*:audio/mpeg:DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=8D500000000000000000000000000000';
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

  private buildSetUriBody(uri: string, didl: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
  s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
      <CurrentURI>${escapeXml(uri)}</CurrentURI>
      <CurrentURIMetaData>${escapeXml(didl)}</CurrentURIMetaData>
    </u:SetAVTransportURI>
  </s:Body>
</s:Envelope>`;
  }

  private buildPlayBody(): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
  s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
      <Speed>1</Speed>
    </u:Play>
  </s:Body>
</s:Envelope>`;
  }

  private buildPauseBody(): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
  s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Pause xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
    </u:Pause>
  </s:Body>
</s:Envelope>`;
  }

  private buildStopBody(): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
  s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
    </u:Stop>
  </s:Body>
</s:Envelope>`;
  }

  private buildSetVolumeBody(volume: number): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
  s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:SetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">
      <InstanceID>0</InstanceID>
      <Channel>Master</Channel>
      <DesiredVolume>${volume}</DesiredVolume>
    </u:SetVolume>
  </s:Body>
</s:Envelope>`;
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

  private normalizeDlnaStreamUri(uri: string, _session: PlaybackSession): string {
    return normalizeStreamUrl(uri, this.buildBaseUrl(), ['mp3']);
  }

  private buildBaseUrl(): string {
    const sys = this.ports.config.getSystemConfig();
    return buildBaseUrl({
      host: sys.audioserver.ip?.trim(),
      fallbackHost: '127.0.0.1',
    });
  }

  private deriveRenderingUrl(avTransportUrl: string): string | undefined {
    try {
      const parsed = new URL(avTransportUrl);
      if (parsed.pathname.toLowerCase().includes('avtransport')) {
        parsed.pathname = parsed.pathname.replace(/AVTransport/gi, 'RenderingControl');
      } else {
        parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/RenderingControl/Control`;
      }
      return parsed.toString();
    } catch {
      return undefined;
    }
  }

  private applyDiscoveredEndpoints(info: {
    controlUrl?: string;
    renderingControlUrl?: string;
    avTransportEventUrl?: string;
    renderingControlEventUrl?: string;
  }): void {
    if (info.controlUrl) {
      this.controlUrl = info.controlUrl;
    }
    if (info.renderingControlUrl) {
      this.renderingControlUrl = info.renderingControlUrl;
    } else if (this.controlUrl && !this.renderingControlUrl) {
      this.renderingControlUrl = this.deriveRenderingUrl(this.controlUrl);
    }
    if (info.avTransportEventUrl) {
      this.avTransportEventUrl = info.avTransportEventUrl;
    }
    if (info.renderingControlEventUrl) {
      this.renderingControlEventUrl = info.renderingControlEventUrl;
    }
    this.log.info('DLNA discovery completed', {
      zoneId: this.zoneId,
      host: this.host,
      controlUrl: this.controlUrl,
    });
    this.ensureEventSubscription();
  }

  /**
   * Start (or refresh) GENA event subscriptions so device-side actions (play/pause/stop on the
   * renderer, volume knob) flow back into zone state. Only runs when the renderer advertised
   * event endpoints; manual controlUrl-only configs won't have them.
   */
  private ensureEventSubscription(): void {
    if (!this.avTransportEventUrl && !this.renderingControlEventUrl) {
      return;
    }
    const localHost = this.ports.config.getSystemConfig().audioserver?.ip?.trim() || '127.0.0.1';
    if (!this.eventSubscriber) {
      this.eventSubscriber = new DlnaEventSubscriber(this.zoneId, localHost, {
        onTransport: (event) => this.handleRemoteTransport(event),
        onRendering: (event) => this.handleRemoteRendering(event),
      });
    }
    void this.eventSubscriber.start({
      avTransportEventUrl: this.avTransportEventUrl,
      renderingControlEventUrl: this.renderingControlEventUrl,
    });
  }

  private handleRemoteTransport(event: {
    transportState?: string;
    currentTrackUri?: string;
    durationSeconds?: number;
  }): void {
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
      mapped: mapTransportState(event.transportState) ?? '(ignored)',
    });
  }

  private handleRemoteRendering(event: { volume?: number; muted?: boolean }): void {
    if (typeof event.volume === 'number' && Number.isFinite(event.volume)) {
      const vol = Math.min(100, Math.max(0, Math.round(event.volume)));
      const now = Date.now();
      const recentlySent =
        this.lastOutboundVolumeAt > 0 && now - this.lastOutboundVolumeAt < 1500;
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
      this.ports.zoneManager.handleCommand(
        this.zoneId,
        'volume_set',
        event.muted ? '0' : String(this.lastKnownVolume ?? 0),
      );
    }
  }
}

function mapTransportState(state: string | undefined): 'playing' | 'paused' | 'stopped' | undefined {
  if (!state) {
    return undefined;
  }
  const s = state.toUpperCase();
  if (s === 'PLAYING') {
    return 'playing';
  }
  if (s === 'PAUSED_PLAYBACK' || s === 'PAUSED') {
    return 'paused';
  }
  if (s === 'STOPPED' || s === 'NO_MEDIA_PRESENT') {
    return 'stopped';
  }
  // TRANSITIONING and others: not a settled state, ignore.
  return undefined;
}

interface InvokeOptions {
  optional?: boolean;
  retryDelayMs?: number;
  timeoutMs?: number;
  timeoutOk?: boolean;
  softFaultOk?: boolean;
  onTimeout?: () => void;
  // SOAP errorCodes that should be treated as a transient failure (retry) rather than a
  // hard fault or a soft-accept. E.g. 701 "Transition not available" on Play.
  retryFaultCodes?: string[];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

