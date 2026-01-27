import { setTimeout as delay } from 'node:timers/promises';
import { createLogger } from '@/shared/logging/logger';
import { safeReadText } from '@/shared/bestEffort';
import type { PlaybackSession } from '@/application/playback/audioManager';
import type { HttpPreferences, PreferredOutput, OutputConfigDefinition, ZoneOutput } from '@/ports/OutputsTypes';
import { decodeAudiopath } from '@/domain/loxone/audiopath';
import { resolveSessionCover, isHttpUrl } from '@/shared/coverArt';
import { buildBaseUrl, normalizeStreamUrl, resolveAbsoluteUrl } from '@/shared/streamUrl';
import { resolveDlnaEndpoints } from '@/adapters/outputs/dlna/dlnaDiscovery';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';

export interface DlnaOutputConfig {
  host?: string;
  controlUrl?: string;
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
  ],
};

export class DlnaOutput implements ZoneOutput {
  public readonly type = 'dlna';
  private readonly log = createLogger('Output', 'DLNA');
  private readonly controllers = new Set<AbortController>();
  private readonly commandTimeoutMs = 2500;
  private readonly host: string;
  private controlUrl?: string;
  private renderingControlUrl?: string;
  private discoveryPromise?: Promise<boolean>;

  constructor(
    private readonly zoneId: number,
    private readonly zoneName: string,
    config: DlnaOutputConfig,
    private readonly ports: OutputPorts,
  ) {
    this.host = typeof config.host === 'string' ? config.host.trim() : '';
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
    await this.sendPlaybackWithSoap(streamUri);
  }

  public async pause(session: PlaybackSession | null): Promise<void> {
    if (!session?.playbackSource) {
      return;
    }
    if (!(await this.ensureEndpoints())) {
      return;
    }
    await this.runCommand('Pause', this.buildPauseBody());
  }

  public async resume(session: PlaybackSession | null): Promise<void> {
    if (session) {
      await this.play(session);
      return;
    }
    if (!(await this.ensureEndpoints())) {
      return;
    }
    await this.runCommand('Play', this.buildPlayBody());
  }

  public async stop(session: PlaybackSession | null): Promise<void> {
    if (!session?.playbackSource) {
      return;
    }
    if (!(await this.ensureEndpoints())) {
      return;
    }
    await this.runCommand('Stop', this.buildStopBody());
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
      return true;
    }
    if (this.discoveryPromise) {
      return this.discoveryPromise;
    }
    if (!this.host) {
      this.log.warn('DLNA command skipped; no host or control URL configured', {
        zoneId: this.zoneId,
      });
      return false;
    }
    this.discoveryPromise = resolveDlnaEndpoints({ host: this.host })
      .then((info) => {
        if (info) {
          this.applyDiscoveredEndpoints(info);
          return true;
        }
        this.log.warn('no DLNA endpoints discovered', { zoneId: this.zoneId, host: this.host });
        return false;
      })
      .finally(() => {
        this.discoveryPromise = undefined;
      });
    return this.discoveryPromise;
  }

  private async sendPlaybackWithSoap(uri: string): Promise<void> {
    this.log.info('sending playback command', { zoneId: this.zoneId, uri });
    await this.runCommand('Stop', this.buildStopBody(), { optional: true });
    let timedOut = false;
    const setResult = await this.invokeActionWithRetry(
      'SetAVTransportURI',
      this.buildSetUriBody(uri, ''),
      1,
      {
        retryDelayMs: 1000,
        timeoutMs: 30000,
        timeoutOk: true,
        softFaultOk: true,
        onTimeout: () => {
          timedOut = true;
        },
      },
    );
    let didSetUri = setResult;
    if (!didSetUri) {
      this.log.warn('DLNA SetAVTransportURI failed; retrying without metadata', { zoneId: this.zoneId });
      didSetUri = await this.invokeActionWithRetry(
        'SetAVTransportURI',
        this.buildSetUriBody(uri, ''),
        1,
        {
          retryDelayMs: 500,
          timeoutMs: 15000,
          timeoutOk: true,
          softFaultOk: true,
          onTimeout: () => {
            timedOut = true;
          },
        },
      );
    }
    if (!didSetUri) {
        if (timedOut) {
          this.log.warn('DLNA SetAVTransportURI timed out; waiting for stream request before Play', {
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
      this.log.warn('DLNA SetAVTransportURI failed; attempting Play anyway', { zoneId: this.zoneId });
      await delay(5000);
    }
    await delay(250);
    const playAttempts = didSetUri ? 2 : 6;
    const playDelay = didSetUri ? 150 : 2000;
    if (
      !(await this.invokeActionWithRetry('Play', this.buildPlayBody(), playAttempts, {
        retryDelayMs: playDelay,
        softFaultOk: true,
      }))
    ) {
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

  private buildDidlMetadata(uri: string, session: PlaybackSession): string {
    const cover = this.resolveCoverArt(session);
    const title = session.metadata?.title || this.zoneName;
    const album = session.metadata?.album || '';
    const artist = session.metadata?.artist || '';
    const duration = this.formatDlnaDuration(session.duration);
    const isStream = !duration;
    const protocolInfo = this.buildProtocolInfo(uri, isStream);
    const mediaClass = isStream
      ? 'object.item.audioItem.audioBroadcast'
      : 'object.item.audioItem.musicTrack';
    const durationAttr = duration ? ` duration="${duration}"` : '';
    return `<?xml version="1.0"?>
<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"
           xmlns:dc="http://purl.org/dc/elements/1.1/"
           xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
  <item id="0" parentID="0" restricted="1">
    <dc:title>${escapeXmlMetadata(title)}</dc:title>
    <dc:creator>${escapeXmlMetadata(artist)}</dc:creator>
    <upnp:artist>${escapeXmlMetadata(artist)}</upnp:artist>
    <upnp:album>${escapeXmlMetadata(album)}</upnp:album>
    <upnp:albumArtURI>${escapeXmlMetadata(cover)}</upnp:albumArtURI>
    <upnp:class>${mediaClass}</upnp:class>
    <res${durationAttr} protocolInfo="${protocolInfo}">${escapeXmlMetadata(uri)}</res>
  </item>
</DIDL-Lite>`;
  }

  private resolveCoverArt(session: PlaybackSession): string {
    const coverSource = resolveSessionCover(session);
    if (!coverSource) {
      return '';
    }
    const proxied = resolveAbsoluteUrl(this.buildBaseUrl(), session.stream.coverUrl);
    return proxied ?? coverSource;
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

  private normalizeDlnaStreamUri(uri: string, session: PlaybackSession): string {
    return normalizeStreamUrl(uri, this.buildBaseUrl(), ['mp3']);
  }

  private buildBaseUrl(): string {
    const sys = this.ports.config.getSystemConfig();
    return buildBaseUrl({
      host: sys.audioserver.ip?.trim(),
      fallbackHost: '127.0.0.1',
    });
  }

  private buildProtocolInfo(uri: string, isStream: boolean): string {
    const mime = this.resolveMimeType(uri);
    const flags = isStream
      ? 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000'
      : 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01500000000000000000000000000000';
    return `http-get:*:${mime}:${flags}`;
  }

  private resolveMimeType(uri: string): string {
    const ext = uri.split('?')[0]?.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'wav':
        return 'audio/wav';
      case 'flac':
        return 'audio/flac';
      case 'aac':
        return 'audio/aac';
      case 'm4a':
      case 'mp4':
        return 'audio/mp4';
      case 'mp3':
      case 'mpeg':
      default:
        return 'audio/mpeg';
    }
  }

  private formatDlnaDuration(durationSeconds: number): string {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return '';
    }
    const total = Math.floor(durationSeconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(
      seconds,
    ).padStart(2, '0')}`;
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

  private applyDiscoveredEndpoints(info: { controlUrl?: string; renderingControlUrl?: string }): void {
    if (info.controlUrl) {
      this.controlUrl = info.controlUrl;
    }
    if (info.renderingControlUrl) {
      this.renderingControlUrl = info.renderingControlUrl;
    } else if (this.controlUrl && !this.renderingControlUrl) {
      this.renderingControlUrl = this.deriveRenderingUrl(this.controlUrl);
    }
    this.log.info('DLNA discovery completed', {
      zoneId: this.zoneId,
      host: this.host,
      controlUrl: this.controlUrl,
    });
  }
}

interface InvokeOptions {
  optional?: boolean;
  retryDelayMs?: number;
  timeoutMs?: number;
  timeoutOk?: boolean;
  softFaultOk?: boolean;
  onTimeout?: () => void;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeXmlInner(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlMetadata(value: string): string {
  const escaped = escapeXmlInner(value);
  let result = '';
  for (const char of escaped) {
    const code = char.codePointAt(0);
    if (code && code > 127) {
      result += `&#${code};`;
    } else {
      result += char;
    }
  }
  return result;
}
