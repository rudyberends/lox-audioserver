import http from 'node:http';
import { AddressInfo } from 'node:net';
import { createLogger } from '@/shared/logging/logger';

/**
 * DLNA/UPnP GENA event subscriber.
 *
 * UPnP renderers report their own state (transport play/pause/stop, current track, volume,
 * mute) by way of GENA eventing: we send a SUBSCRIBE to the service's eventSubURL with a
 * CALLBACK pointing at a small HTTP server we host, and the renderer then pushes NOTIFY
 * requests whenever state changes. This is how device-side actions (someone pressing pause on
 * the speaker, turning the volume knob) flow back into our zone state.
 *
 * One subscriber instance manages the callback HTTP server plus one subscription per service
 * (AVTransport + RenderingControl). Subscriptions are auto-renewed before they expire and
 * re-established on failure.
 */

export type DlnaEventKind = 'avtransport' | 'renderingcontrol';

export interface DlnaTransportEvent {
  /** Raw UPnP TransportState, e.g. PLAYING / PAUSED_PLAYBACK / STOPPED / TRANSITIONING. */
  transportState?: string;
  currentTrackUri?: string;
  /** Track duration in seconds, parsed from CurrentTrackDuration (HH:MM:SS). */
  durationSeconds?: number;
}

export interface DlnaRenderingEvent {
  /** Master volume 0..100 if present. */
  volume?: number;
  muted?: boolean;
}

export interface DlnaEventHandlers {
  onTransport?: (event: DlnaTransportEvent) => void;
  onRendering?: (event: DlnaRenderingEvent) => void;
}

interface ServiceSubscription {
  kind: DlnaEventKind;
  eventUrl: string;
  sid?: string;
  timeoutSec: number;
  renewTimer?: ReturnType<typeof setTimeout>;
  active: boolean;
  failures: number;
}

const log = createLogger('Output', 'DLNAEvents');

// Requested subscription lifetime. Renewed a little before expiry.
const SUBSCRIBE_TIMEOUT_SEC = 300;
const REQUEST_TIMEOUT_MS = 4000;

export class DlnaEventSubscriber {
  private server?: http.Server;
  private callbackBaseUrl?: string;
  private readonly subscriptions = new Map<DlnaEventKind, ServiceSubscription>();
  private readonly sidToKind = new Map<string, DlnaEventKind>();
  private disposed = false;

  constructor(
    private readonly zoneId: number,
    private readonly localHost: string,
    private readonly handlers: DlnaEventHandlers,
  ) {}

  /**
   * Start (or restart) subscriptions for the given service event URLs. Safe to call again with
   * updated URLs after a re-discovery; it renews what's unchanged and (re)subscribes the rest.
   */
  public async start(urls: {
    avTransportEventUrl?: string;
    renderingControlEventUrl?: string;
  }): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.ensureServer();
    if (!this.callbackBaseUrl) {
      return;
    }
    const targets: Array<{ kind: DlnaEventKind; url?: string }> = [
      { kind: 'avtransport', url: urls.avTransportEventUrl },
      { kind: 'renderingcontrol', url: urls.renderingControlEventUrl },
    ];
    for (const { kind, url } of targets) {
      if (!url) {
        continue;
      }
      const existing = this.subscriptions.get(kind);
      // A subscription for this exact service already exists — leave it alone. It's either
      // active or mid-retry with its own timer; recreating it here would orphan that timer and
      // spawn a parallel subscribe loop (compounding failures). Only replace when the URL changed.
      if (existing && existing.eventUrl === url) {
        continue;
      }
      if (existing?.renewTimer) {
        clearTimeout(existing.renewTimer);
      }
      const sub: ServiceSubscription = {
        kind,
        eventUrl: url,
        timeoutSec: SUBSCRIBE_TIMEOUT_SEC,
        active: false,
        failures: 0,
      };
      this.subscriptions.set(kind, sub);
      await this.subscribe(sub);
    }
  }

  public dispose(): void {
    this.disposed = true;
    for (const sub of this.subscriptions.values()) {
      if (sub.renewTimer) {
        clearTimeout(sub.renewTimer);
      }
      void this.unsubscribe(sub);
    }
    this.subscriptions.clear();
    this.sidToKind.clear();
    if (this.server) {
      this.server.close();
      this.server = undefined;
    }
  }

  private async ensureServer(): Promise<void> {
    if (this.server) {
      return;
    }
    const server = http.createServer((req, res) => this.handleNotify(req, res));
    server.on('error', (err) => {
      log.warn('DLNA event callback server error', {
        zoneId: this.zoneId,
        message: err instanceof Error ? err.message : String(err),
      });
    });
    await new Promise<void>((resolve) => {
      // Bind to all interfaces on an ephemeral port; advertise the LAN host so the renderer
      // can reach us. Port 0 lets the OS pick a free port.
      server.listen(0, '0.0.0.0', () => resolve());
    });
    const address = server.address() as AddressInfo | null;
    if (!address || typeof address.port !== 'number') {
      server.close();
      log.warn('DLNA event callback server failed to bind', { zoneId: this.zoneId });
      return;
    }
    this.server = server;
    this.callbackBaseUrl = `http://${this.localHost}:${address.port}`;
    log.debug('DLNA event callback server listening', {
      zoneId: this.zoneId,
      callback: this.callbackBaseUrl,
    });
  }

  private handleNotify(req: http.IncomingMessage, res: http.ServerResponse): void {
    if ((req.method ?? '').toUpperCase() !== 'NOTIFY') {
      res.writeHead(405);
      res.end();
      return;
    }
    const sid = (req.headers.sid as string | undefined)?.trim();
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      // Guard against a runaway body.
      if (chunks.reduce((n, b) => n + b.length, 0) < 256 * 1024) {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      // GENA requires a 200 with no body; ack promptly regardless of parse outcome.
      res.writeHead(200);
      res.end();
      const body = Buffer.concat(chunks).toString('utf8');
      const kind = sid ? this.sidToKind.get(sid) : undefined;
      log.debug('DLNA NOTIFY received', {
        zoneId: this.zoneId,
        sid,
        kind: kind ?? '(unmapped)',
        bytes: body.length,
      });
      try {
        this.dispatchNotify(kind, body);
      } catch (err) {
        log.debug('DLNA NOTIFY parse failed', {
          zoneId: this.zoneId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
    req.on('error', () => {
      if (!res.writableEnded) {
        res.writeHead(200);
        res.end();
      }
    });
  }

  private dispatchNotify(kind: DlnaEventKind | undefined, body: string): void {
    const lastChange = extractLastChange(body);
    if (!lastChange) {
      return;
    }
    // If we couldn't map the SID (e.g. renewed), infer the service from the payload contents.
    const resolvedKind =
      kind ??
      (/TransportState|CurrentTrackURI/i.test(lastChange) ? 'avtransport' : 'renderingcontrol');
    if (resolvedKind === 'avtransport') {
      const event = parseTransportLastChange(lastChange);
      if (event && (event.transportState || event.currentTrackUri || event.durationSeconds != null)) {
        this.handlers.onTransport?.(event);
      }
    } else {
      const event = parseRenderingLastChange(lastChange);
      if (event && (event.volume != null || event.muted != null)) {
        this.handlers.onRendering?.(event);
      }
    }
  }

  private async subscribe(sub: ServiceSubscription): Promise<void> {
    if (this.disposed || !this.callbackBaseUrl) {
      return;
    }
    try {
      const { sid, timeoutSec } = await this.sendSubscribe(sub.eventUrl, sub.sid);
      if (sub.sid && sub.sid !== sid) {
        this.sidToKind.delete(sub.sid);
      }
      sub.sid = sid;
      sub.timeoutSec = timeoutSec;
      sub.active = true;
      sub.failures = 0;
      if (sid) {
        this.sidToKind.set(sid, sub.kind);
      }
      this.scheduleRenew(sub);
      log.debug('DLNA subscribed', { zoneId: this.zoneId, kind: sub.kind, sid, timeoutSec });
    } catch (err) {
      sub.active = false;
      sub.failures += 1;
      // A failed renew (esp. 412 Precondition Failed) means the renderer no longer knows our
      // SID. Drop it so the retry is a FRESH subscribe (CALLBACK, no SID) — otherwise we keep
      // re-sending the stale SID and get 412 forever.
      if (sub.sid) {
        this.sidToKind.delete(sub.sid);
        sub.sid = undefined;
      }
      const backoffMs = Math.min(30_000, 2000 * sub.failures);
      log.debug('DLNA subscribe failed; will retry', {
        zoneId: this.zoneId,
        kind: sub.kind,
        failures: sub.failures,
        backoffMs,
        message: err instanceof Error ? err.message : String(err),
      });
      if (sub.renewTimer) {
        clearTimeout(sub.renewTimer);
      }
      sub.renewTimer = setTimeout(() => {
        void this.subscribe(sub);
      }, backoffMs);
      sub.renewTimer.unref?.();
    }
  }

  private scheduleRenew(sub: ServiceSubscription): void {
    if (sub.renewTimer) {
      clearTimeout(sub.renewTimer);
    }
    // Renew at ~half the granted lifetime (min 30s) so we never lapse.
    const renewMs = Math.max(30_000, (sub.timeoutSec * 1000) / 2);
    sub.renewTimer = setTimeout(() => {
      // Some renderers (B&O) reject SID-based renews with 412. Renewing as a fresh subscribe
      // (drop the SID → send CALLBACK again) is universally accepted; UNSUBSCRIBE the old SID
      // first so we don't leak subscriptions on the device.
      const staleSid = sub.sid;
      if (staleSid) {
        this.sidToKind.delete(staleSid);
        sub.sid = undefined;
        void this.sendGenaRequest('UNSUBSCRIBE', sub.eventUrl, { SID: staleSid }).catch(() => {});
      }
      void this.subscribe(sub);
    }, renewMs);
    sub.renewTimer.unref?.();
  }

  private sendSubscribe(
    eventUrl: string,
    existingSid?: string,
  ): Promise<{ sid?: string; timeoutSec: number }> {
    const callback = `<${this.callbackBaseUrl}/notify>`;
    const headers: Record<string, string> = existingSid
      ? { SID: existingSid, TIMEOUT: `Second-${SUBSCRIBE_TIMEOUT_SEC}` }
      : { CALLBACK: callback, NT: 'upnp:event', TIMEOUT: `Second-${SUBSCRIBE_TIMEOUT_SEC}` };
    return this.sendGenaRequest('SUBSCRIBE', eventUrl, headers).then((res) => {
      const sid = (res.headers['sid'] as string | undefined)?.trim() || existingSid;
      const timeoutSec = parseTimeoutHeader(res.headers['timeout'] as string | undefined);
      return { sid, timeoutSec };
    });
  }

  private async unsubscribe(sub: ServiceSubscription): Promise<void> {
    if (!sub.sid) {
      return;
    }
    try {
      await this.sendGenaRequest('UNSUBSCRIBE', sub.eventUrl, { SID: sub.sid });
    } catch {
      /* best-effort */
    }
  }

  private sendGenaRequest(
    method: 'SUBSCRIBE' | 'UNSUBSCRIBE',
    eventUrl: string,
    headers: Record<string, string>,
  ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(eventUrl);
      } catch {
        reject(new Error('invalid event url'));
        return;
      }
      const req = http.request(
        {
          method,
          hostname: url.hostname,
          port: url.port || 80,
          path: `${url.pathname}${url.search}`,
          headers,
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          res.resume(); // drain
          if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) {
            resolve({ statusCode: res.statusCode ?? 200, headers: res.headers });
          } else {
            reject(new Error(`GENA ${method} HTTP ${res.statusCode}`));
          }
        },
      );
      req.on('timeout', () => req.destroy(new Error('GENA request timeout')));
      req.on('error', reject);
      req.end();
    });
  }
}

function parseTimeoutHeader(value: string | undefined): number {
  if (!value) {
    return SUBSCRIBE_TIMEOUT_SEC;
  }
  const match = /Second-(\d+)/i.exec(value);
  if (match?.[1]) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }
  return SUBSCRIBE_TIMEOUT_SEC;
}

/**
 * GENA property-set bodies wrap the meaningful state in a `LastChange` property whose value is
 * an XML-escaped document. Pull that inner document out (unescaped).
 */
function extractLastChange(body: string): string | null {
  const match = /<LastChange>([\s\S]*?)<\/LastChange>/i.exec(body);
  if (!match?.[1]) {
    return null;
  }
  return unescapeXml(match[1].trim());
}

function parseTransportLastChange(xml: string): DlnaTransportEvent | null {
  const transportState = attrVal(xml, 'TransportState');
  const currentTrackUri = attrVal(xml, 'CurrentTrackURI');
  const durationStr = attrVal(xml, 'CurrentTrackDuration');
  const durationSeconds = durationStr ? parseUpnpDuration(durationStr) : undefined;
  return {
    transportState: transportState || undefined,
    currentTrackUri: currentTrackUri || undefined,
    durationSeconds: durationSeconds != null && durationSeconds > 0 ? durationSeconds : undefined,
  };
}

function parseRenderingLastChange(xml: string): DlnaRenderingEvent | null {
  // Prefer the Master channel; fall back to any channel present.
  const volume = channelAttrVal(xml, 'Volume');
  const mute = channelAttrVal(xml, 'Mute');
  const event: DlnaRenderingEvent = {};
  if (volume != null) {
    const n = Number(volume);
    if (Number.isFinite(n)) {
      event.volume = Math.min(100, Math.max(0, Math.round(n)));
    }
  }
  if (mute != null) {
    event.muted = mute === '1' || mute.toLowerCase() === 'true';
  }
  return event;
}

/** Read `<Tag val="X"/>` (the AVTransport LastChange event style). */
function attrVal(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}\\b[^>]*\\bval="([^"]*)"`, 'i');
  return re.exec(xml)?.[1];
}

/**
 * RenderingControl events carry per-channel entries like `<Volume channel="Master" val="35"/>`.
 * Prefer Master; otherwise take the first match.
 */
function channelAttrVal(xml: string, tag: string): string | undefined {
  const master = new RegExp(
    `<${tag}\\b[^>]*channel="Master"[^>]*\\bval="([^"]*)"|<${tag}\\b[^>]*\\bval="([^"]*)"[^>]*channel="Master"`,
    'i',
  ).exec(xml);
  if (master) {
    return master[1] ?? master[2];
  }
  const any = new RegExp(`<${tag}\\b[^>]*\\bval="([^"]*)"`, 'i').exec(xml);
  return any?.[1];
}

/** UPnP durations are H+:MM:SS[.fraction]. Returns whole seconds. */
function parseUpnpDuration(value: string): number | undefined {
  const m = /(\d+):(\d{1,2}):(\d{1,2})/.exec(value.trim());
  if (!m) {
    return undefined;
  }
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  if (![h, min, sec].every(Number.isFinite)) {
    return undefined;
  }
  return h * 3600 + min * 60 + sec;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
