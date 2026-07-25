import type { IncomingMessage, ServerResponse } from 'node:http';
import http from 'node:http';
import { createLogger } from '@/shared/logging/logger';
import type { AirplayController } from '@/ports/InputsPort';
import type { PlaybackMetadata } from '@/ports/types/playback';
import type { PlaybackSource } from '@/ports/EngineTypes';
import { escapeXml } from '@/adapters/mediaserver/didl';
import {
  AVT_SCPD,
  CM_SCPD,
  RC_SCPD,
  RENDERER_PATHS,
  buildRendererDescription,
} from '@/adapters/inputs/dlna/rendererDescription';

type TransportState = 'STOPPED' | 'PLAYING' | 'PAUSED_PLAYBACK' | 'TRANSITIONING' | 'NO_MEDIA_PRESENT';

type GenaSubscription = {
  sid: string;
  callbackUrl: string;
  expiresAt: number;
  seq: number;
  service: 'AVTransport' | 'RenderingControl';
};

const AVT_NS = 'urn:schemas-upnp-org:service:AVTransport:1';
const RC_NS = 'urn:schemas-upnp-org:service:RenderingControl:1';
const CM_NS = 'urn:schemas-upnp-org:service:ConnectionManager:1';
// Advertised sink formats — the audio content types a control point may push at us.
const SINK_PROTOCOL_INFO = [
  'audio/mpeg', 'audio/x-mpeg', 'audio/mp4', 'audio/aac', 'audio/flac',
  'audio/x-flac', 'audio/wav', 'audio/L16', 'application/ogg',
].map((mime) => `http-get:*:${mime}:*`).join(',');

/**
 * A single per-zone UPnP MediaRenderer. It accepts SetAVTransportURI + Play from
 * any DLNA control point (BubbleUPnP, mconnect, Roon, etc.) and turns the pushed
 * URL into the zone's active playback via the shared input controller — the
 * inverse of the DLNA output. Because the engine plays URLs natively, no audio
 * decoding happens here: we hand the engine a `{ kind: 'url' }` source.
 *
 * The renderer holds a small transport model (state, current URI, duration,
 * position) that it reports back via GetTransportInfo/GetPositionInfo and pushes
 * to subscribers via GENA LastChange events, so the controlling app reflects
 * play/pause/stop and shows a timeline.
 */
export class DlnaRendererInstance {
  private readonly log = createLogger('Input', 'DlnaRenderer');

  private transportState: TransportState = 'NO_MEDIA_PRESENT';
  private currentUri = '';
  private currentUriMetaData = '';
  private nextUri = '';
  private nextUriMetaData = '';
  private durationSec = 0;
  private volume = 100;
  private muted = false;
  private startedAtMs = 0;
  private pausedElapsedSec = 0;

  private readonly subscriptions = new Map<string, GenaSubscription>();
  private renewTimer?: NodeJS.Timeout;

  constructor(
    private readonly zoneId: number,
    private zoneName: string,
    private readonly controller: AirplayController,
    private readonly baseUrl: () => string,
  ) {
    // Periodically drop expired subscriptions.
    this.renewTimer = setInterval(() => this.pruneSubscriptions(), 30_000);
    this.renewTimer.unref?.();
  }

  public setName(name: string): void {
    this.zoneName = name;
  }

  public friendlyName(): string {
    return this.zoneName;
  }

  public dispose(): void {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = undefined;
    }
    this.subscriptions.clear();
  }

  /** Called by the input service when the zone volume changes elsewhere. */
  public reflectVolume(volumePercent: number): void {
    this.volume = clampVolume(volumePercent);
  }

  // ── HTTP handling ───────────────────────────────────────────────────────────

  /** `sub` is the path AFTER `/dlna-renderer/:zoneId/`. */
  public async handle(req: IncomingMessage, res: ServerResponse, sub: string): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();

    if (method === 'GET' || method === 'HEAD') {
      if (sub === RENDERER_PATHS.device) {
        return this.sendXml(res, this.deviceXml());
      }
      if (sub === RENDERER_PATHS.avtScpd) {
        return this.sendXml(res, AVT_SCPD);
      }
      if (sub === RENDERER_PATHS.rcScpd) {
        return this.sendXml(res, RC_SCPD);
      }
      if (sub === RENDERER_PATHS.cmScpd) {
        return this.sendXml(res, CM_SCPD);
      }
      return this.notFound(res);
    }

    if (method === 'SUBSCRIBE' || method === 'UNSUBSCRIBE') {
      return this.handleGena(req, res, sub, method);
    }

    if (method === 'POST') {
      if (sub === RENDERER_PATHS.avtControl) {
        return this.handleAvtControl(req, res);
      }
      if (sub === RENDERER_PATHS.rcControl) {
        return this.handleRcControl(req, res);
      }
      if (sub === RENDERER_PATHS.cmControl) {
        return this.handleCmControl(req, res);
      }
      return this.notFound(res);
    }
    return this.notFound(res);
  }

  private deviceXml(): string {
    return buildRendererDescription({
      zoneId: this.zoneId,
      udn: this.udn(),
      friendlyName: this.friendlyName(),
      baseUrl: this.baseUrl(),
    });
  }

  public udn(): string {
    // Stable per-zone UDN so a controller keeps one renderer entry across restarts.
    return `uuid:sonn-renderer-${String(this.zoneId).padStart(4, '0')}-0000-0000-000000000000`;
  }

  // ── AVTransport SOAP ────────────────────────────────────────────────────────

  private async handleAvtControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const action = soapActionName(req.headers['soapaction']);
    const body = await readBody(req);
    try {
      switch (action) {
        case 'SetAVTransportURI':
          return this.actSetUri(res, body);
        case 'SetNextAVTransportURI':
          return this.actSetNextUri(res, body);
        case 'Play':
          return this.actPlay(res);
        case 'Pause':
          return this.actPause(res);
        case 'Stop':
          return this.actStop(res);
        case 'Seek':
          return this.actSeek(res, body);
        case 'GetTransportInfo':
          return this.actGetTransportInfo(res);
        case 'GetPositionInfo':
          return this.actGetPositionInfo(res);
        case 'GetMediaInfo':
          return this.actGetMediaInfo(res);
        case 'GetTransportSettings':
          return this.sendSoap(res, AVT_NS, 'GetTransportSettings', {
            PlayMode: 'NORMAL',
            RecQualityMode: 'NOT_IMPLEMENTED',
          });
        case 'GetDeviceCapabilities':
          return this.sendSoap(res, AVT_NS, 'GetDeviceCapabilities', {
            PlayMedia: 'NETWORK,HDD',
            RecMedia: 'NOT_IMPLEMENTED',
            RecQualityModes: 'NOT_IMPLEMENTED',
          });
        default:
          return this.sendFault(res, 'Unsupported action');
      }
    } catch (error) {
      this.log.warn('avt control failed', {
        zoneId: this.zoneId,
        action,
        message: error instanceof Error ? error.message : String(error),
      });
      return this.sendFault(res, 'Action failed');
    }
  }

  private actSetUri(res: ServerResponse, body: string): void {
    const uri = extractTag(body, 'CurrentURI') ?? '';
    const meta = extractTag(body, 'CurrentURIMetaData') ?? '';
    this.currentUri = uri;
    this.currentUriMetaData = meta;
    this.durationSec = parseDurationFromDidl(meta) ?? 0;
    this.pausedElapsedSec = 0;
    this.setState(uri ? 'STOPPED' : 'NO_MEDIA_PRESENT');
    this.log.info('renderer SetAVTransportURI', { zoneId: this.zoneId, uri });
    this.sendSoap(res, AVT_NS, 'SetAVTransportURI', {});
  }

  private actSetNextUri(res: ServerResponse, body: string): void {
    this.nextUri = extractTag(body, 'NextURI') ?? '';
    this.nextUriMetaData = extractTag(body, 'NextURIMetaData') ?? '';
    this.sendSoap(res, AVT_NS, 'SetNextAVTransportURI', {});
  }

  private actPlay(res: ServerResponse): void {
    if (!this.currentUri) {
      return this.sendFault(res, 'No media', 701);
    }
    if (this.transportState === 'PAUSED_PLAYBACK') {
      this.controller.resumePlayback(this.zoneId);
      this.startedAtMs = Date.now() - this.pausedElapsedSec * 1000;
      this.setState('PLAYING');
      return this.sendSoap(res, AVT_NS, 'Play', {});
    }
    // Fresh start: hand the pushed URL to the engine as the zone's source.
    const source: PlaybackSource = {
      kind: 'url',
      url: this.currentUri,
      realTime: true,
      restartOnFailure: false,
    };
    const metadata = this.buildMetadata();
    this.startedAtMs = Date.now();
    this.pausedElapsedSec = 0;
    this.controller.startPlayback(this.zoneId, 'dlna', source, metadata);
    if (metadata.coverurl) {
      // Cover already a URL in DIDL; nothing to upload. updateMetadata carries it.
      this.controller.updateMetadata(this.zoneId, metadata);
    }
    if (this.durationSec > 0) {
      this.controller.updateTiming(this.zoneId, 0, this.durationSec);
    }
    this.setState('PLAYING');
    this.log.info('renderer Play', { zoneId: this.zoneId, uri: this.currentUri });
    this.sendSoap(res, AVT_NS, 'Play', {});
  }

  private actPause(res: ServerResponse): void {
    this.controller.pausePlayback(this.zoneId);
    this.pausedElapsedSec = this.elapsedSec();
    this.setState('PAUSED_PLAYBACK');
    this.sendSoap(res, AVT_NS, 'Pause', {});
  }

  private actStop(res: ServerResponse): void {
    this.controller.stopPlayback(this.zoneId);
    this.pausedElapsedSec = 0;
    this.setState('STOPPED');
    this.sendSoap(res, AVT_NS, 'Stop', {});
  }

  private actSeek(res: ServerResponse, body: string): void {
    const unit = extractTag(body, 'Unit') ?? '';
    const target = extractTag(body, 'Target') ?? '';
    if (unit === 'REL_TIME') {
      const seconds = parseClock(target);
      if (seconds !== null && this.currentUri) {
        // Restart the URL source at the requested offset.
        const source: PlaybackSource = {
          kind: 'url',
          url: this.currentUri,
          startAtSec: seconds,
          realTime: true,
          restartOnFailure: false,
        };
        this.controller.startPlayback(this.zoneId, 'dlna', source, this.buildMetadata());
        this.startedAtMs = Date.now() - seconds * 1000;
        this.pausedElapsedSec = 0;
        this.setState('PLAYING');
      }
    }
    this.sendSoap(res, AVT_NS, 'Seek', {});
  }

  private actGetTransportInfo(res: ServerResponse): void {
    this.sendSoap(res, AVT_NS, 'GetTransportInfo', {
      CurrentTransportState: this.transportState,
      CurrentTransportStatus: 'OK',
      CurrentSpeed: '1',
    });
  }

  private actGetPositionInfo(res: ServerResponse): void {
    const rel = formatClock(this.elapsedSec());
    this.sendSoap(res, AVT_NS, 'GetPositionInfo', {
      Track: '1',
      TrackDuration: formatClock(this.durationSec),
      TrackMetaData: this.currentUriMetaData,
      TrackURI: this.currentUri,
      RelTime: rel,
      AbsTime: rel,
      RelCount: '2147483647',
      AbsCount: '2147483647',
    });
  }

  private actGetMediaInfo(res: ServerResponse): void {
    this.sendSoap(res, AVT_NS, 'GetMediaInfo', {
      NrTracks: this.currentUri ? '1' : '0',
      MediaDuration: formatClock(this.durationSec),
      CurrentURI: this.currentUri,
      CurrentURIMetaData: this.currentUriMetaData,
      NextURI: this.nextUri,
      NextURIMetaData: this.nextUriMetaData,
      PlayMedium: this.currentUri ? 'NETWORK' : 'NONE',
      RecordMedium: 'NOT_IMPLEMENTED',
      WriteStatus: 'NOT_IMPLEMENTED',
    });
  }

  // ── RenderingControl SOAP ───────────────────────────────────────────────────

  private async handleRcControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const action = soapActionName(req.headers['soapaction']);
    const body = await readBody(req);
    switch (action) {
      case 'GetVolume':
        return this.sendSoap(res, RC_NS, 'GetVolume', { CurrentVolume: String(this.volume) });
      case 'SetVolume': {
        const desired = Number(extractTag(body, 'DesiredVolume') ?? '');
        if (Number.isFinite(desired)) {
          this.volume = clampVolume(desired);
          this.controller.updateVolume(this.zoneId, this.volume);
        }
        return this.sendSoap(res, RC_NS, 'SetVolume', {});
      }
      case 'GetMute':
        return this.sendSoap(res, RC_NS, 'GetMute', { CurrentMute: this.muted ? '1' : '0' });
      case 'SetMute': {
        const desired = (extractTag(body, 'DesiredMute') ?? '').trim();
        this.muted = desired === '1' || desired.toLowerCase() === 'true';
        return this.sendSoap(res, RC_NS, 'SetMute', {});
      }
      default:
        return this.sendFault(res, 'Unsupported action');
    }
  }

  private async handleCmControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const action = soapActionName(req.headers['soapaction']);
    await readBody(req);
    if (action === 'GetProtocolInfo') {
      return this.sendSoap(res, CM_NS, 'GetProtocolInfo', {
        Source: '',
        Sink: SINK_PROTOCOL_INFO,
      });
    }
    return this.sendFault(res, 'Unsupported action');
  }

  // ── GENA eventing ───────────────────────────────────────────────────────────

  private async handleGena(
    req: IncomingMessage,
    res: ServerResponse,
    sub: string,
    method: string,
  ): Promise<void> {
    const service = sub === RENDERER_PATHS.avtEvent
      ? 'AVTransport'
      : sub === RENDERER_PATHS.rcEvent
        ? 'RenderingControl'
        : null;
    if (!service) {
      return this.notFound(res);
    }
    if (method === 'UNSUBSCRIBE') {
      const sid = String(req.headers['sid'] ?? '');
      this.subscriptions.delete(sid);
      res.writeHead(200);
      res.end();
      return;
    }
    // SUBSCRIBE
    const existingSid = String(req.headers['sid'] ?? '');
    const timeout = 1800;
    if (existingSid && this.subscriptions.has(existingSid)) {
      const s = this.subscriptions.get(existingSid)!;
      s.expiresAt = Date.now() + timeout * 1000;
      res.writeHead(200, { SID: existingSid, TIMEOUT: `Second-${timeout}` });
      res.end();
      return;
    }
    const callbackUrl = firstCallback(String(req.headers['callback'] ?? ''));
    const sid = `uuid:${this.udn().slice(5)}-${service}-${this.subscriptions.size + 1}`;
    if (callbackUrl) {
      this.subscriptions.set(sid, {
        sid,
        callbackUrl,
        expiresAt: Date.now() + timeout * 1000,
        seq: 0,
        service,
      });
    }
    res.writeHead(200, { SID: sid, TIMEOUT: `Second-${timeout}` });
    res.end();
    // Send the initial event (seq 0) with current state.
    if (callbackUrl) {
      this.notifySubscriber(this.subscriptions.get(sid)!);
    }
  }

  private setState(state: TransportState): void {
    if (this.transportState === state) {
      return;
    }
    this.transportState = state;
    this.emitAvtLastChange();
  }

  private emitAvtLastChange(): void {
    for (const s of this.subscriptions.values()) {
      if (s.service === 'AVTransport') {
        this.notifySubscriber(s);
      }
    }
  }

  private buildAvtLastChange(): string {
    const inner =
      `<TransportState val="${escapeXml(this.transportState)}"/>` +
      `<CurrentTrackURI val="${escapeXml(this.currentUri)}"/>` +
      `<CurrentTrackDuration val="${escapeXml(formatClock(this.durationSec))}"/>` +
      `<CurrentTrackMetaData val="${escapeXml(this.currentUriMetaData)}"/>` +
      `<AVTransportURI val="${escapeXml(this.currentUri)}"/>`;
    const event =
      `<Event xmlns="urn:schemas-upnp-org:metadata-1-0/AVT/"><InstanceID val="0">${inner}</InstanceID></Event>`;
    return event;
  }

  private buildRcLastChange(): string {
    const inner =
      `<Volume channel="Master" val="${this.volume}"/>` +
      `<Mute channel="Master" val="${this.muted ? 1 : 0}"/>`;
    return `<Event xmlns="urn:schemas-upnp-org:metadata-1-0/RCS/"><InstanceID val="0">${inner}</InstanceID></Event>`;
  }

  private notifySubscriber(sub: GenaSubscription): void {
    const lastChange = sub.service === 'AVTransport'
      ? this.buildAvtLastChange()
      : this.buildRcLastChange();
    const propertyset =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">' +
      `<e:property><LastChange>${escapeXml(lastChange)}</LastChange></e:property>` +
      '</e:propertyset>';
    let url: URL;
    try {
      url = new URL(sub.callbackUrl);
    } catch {
      return;
    }
    const seq = sub.seq;
    sub.seq += 1;
    const reqOptions: http.RequestOptions = {
      method: 'NOTIFY',
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        NT: 'upnp:event',
        NTS: 'upnp:propchange',
        SID: sub.sid,
        SEQ: String(seq),
        'Content-Length': Buffer.byteLength(propertyset),
      },
    };
    const clientReq = http.request(reqOptions, (r) => r.resume());
    clientReq.on('error', () => { /* subscriber gone; pruned on expiry */ });
    clientReq.end(propertyset);
  }

  private pruneSubscriptions(): void {
    const now = Date.now();
    for (const [sid, s] of this.subscriptions) {
      if (s.expiresAt <= now) {
        this.subscriptions.delete(sid);
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private elapsedSec(): number {
    if (this.transportState === 'PAUSED_PLAYBACK') {
      return this.pausedElapsedSec;
    }
    if (this.transportState !== 'PLAYING' || !this.startedAtMs) {
      return 0;
    }
    const e = Math.floor((Date.now() - this.startedAtMs) / 1000);
    return this.durationSec > 0 ? Math.min(e, this.durationSec) : e;
  }

  private buildMetadata(): PlaybackMetadata {
    const meta = this.currentUriMetaData;
    return {
      title: didlText(meta, 'dc:title') || 'DLNA',
      artist: didlText(meta, 'upnp:artist') || didlText(meta, 'dc:creator') || '',
      album: didlText(meta, 'upnp:album') || '',
      coverurl: didlText(meta, 'upnp:albumArtURI') || undefined,
      duration: this.durationSec || undefined,
      audiopath: `dlna-renderer://${this.zoneId}`,
    };
  }

  private sendXml(res: ServerResponse, xml: string): void {
    res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"', 'Cache-Control': 'no-cache' });
    res.end(xml);
  }

  private sendSoap(
    res: ServerResponse,
    ns: string,
    action: string,
    args: Record<string, string>,
  ): void {
    const body = Object.entries(args)
      .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
      .join('');
    const xml =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
      's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      '<s:Body>' +
      `<u:${action}Response xmlns:u="${ns}">${body}</u:${action}Response>` +
      '</s:Body></s:Envelope>';
    res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"', EXT: '' });
    res.end(xml);
  }

  private sendFault(res: ServerResponse, message: string, code = 401): void {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
      's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      '<s:Body><s:Fault><faultcode>s:Client</faultcode>' +
      '<faultstring>UPnPError</faultstring><detail>' +
      `<UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode>` +
      `<errorDescription>${escapeXml(message)}</errorDescription></UPnPError>` +
      '</detail></s:Fault></s:Body></s:Envelope>';
    res.writeHead(500, { 'Content-Type': 'text/xml; charset="utf-8"' });
    res.end(xml);
  }

  private notFound(res: ServerResponse): void {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not-found');
  }
}

// ── module helpers ────────────────────────────────────────────────────────────

function clampVolume(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

function soapActionName(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] ?? '' : header ?? '';
  const cleaned = raw.replace(/"/g, '').trim();
  const hash = cleaned.lastIndexOf('#');
  return hash >= 0 ? cleaned.slice(hash + 1) : cleaned;
}

function firstCallback(header: string): string {
  const m = /<([^>]+)>/.exec(header);
  return m?.[1] ?? header.trim();
}

async function readBody(req: IncomingMessage): Promise<string> {
  const MAX = 512 * 1024;
  const chunks: Buffer[] = [];
  let total = 0;
  return new Promise<string>((resolve) => {
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX) {
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/** Extract a (possibly namespaced) tag's inner text, SOAP-unescaped. */
function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'i');
  const m = re.exec(xml);
  if (!m) {
    return null;
  }
  return unescapeXml(m[1] ?? '');
}

/** Read a DIDL-Lite text field from a (SOAP-escaped) CurrentURIMetaData blob. */
function didlText(metaEscaped: string, tag: string): string {
  const didl = unescapeXml(metaEscaped);
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(didl);
  return m ? unescapeXml(m[1] ?? '').trim() : '';
}

function parseDurationFromDidl(metaEscaped: string): number | null {
  const didl = unescapeXml(metaEscaped);
  const m = /duration="([^"]+)"/i.exec(didl);
  if (!m?.[1]) {
    return null;
  }
  return parseClock(m[1]);
}

/** Parse H:MM:SS(.ms) into seconds. */
function parseClock(value: string): number | null {
  const t = value.trim();
  if (!t) {
    return null;
  }
  const parts = t.split(':').map((p) => parseFloat(p));
  if (parts.some((n) => !Number.isFinite(n))) {
    return null;
  }
  let sec = 0;
  for (const p of parts) {
    sec = sec * 60 + p;
  }
  return Math.round(sec);
}

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${h}:${pad(m)}:${pad(sec)}`;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}
