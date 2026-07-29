/**
 * The server's own public API (`/api/*`).
 *
 * Deliberately small and separate from the admin API: the admin API is the
 * back-end of our own UI (100+ routes, UI-shaped, free to change), while this is
 * a contract third parties are invited to build on. Commands go over plain
 * HTTP because integrators reach for curl and one-shot scripts; live state goes
 * over SSE because reading state should never require polling.
 *
 * Commands are translated onto the same zone command engine the Loxone adapter
 * drives (`ZoneManager.handleCommand`), so there is one implementation of
 * "pause zone 3" rather than one per protocol.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { ApiEventHub } from '@/adapters/http/api/apiEventHub';
import { toApiZoneState } from '@/adapters/http/api/zoneProjection';
import type { ApiOutput, ApiVolumeLimits, ApiZoneState } from '@/domain/zones/apiTypes';
import type { ZoneState } from '@/domain/zones/zoneState';
import { createLogger } from '@/shared/logging/logger';

export type ApiHandlerDeps = {
  eventHub: ApiEventHub;
  getAllZoneStates: () => ZoneState[];
  getZoneState: (zoneId: number) => ZoneState | null | undefined;
  handleCommand: (zoneId: number, command: string, payload?: string) => void;
  /** Which device a zone's output plays to, when its protocol identifies one. */
  getOutputDevice: (zoneId: number) => ApiOutput['device'] | undefined;
  /** What a zone's volume will accept: its cap, its power-on level and its step. */
  getVolumeLimits: (zoneId: number) => ApiVolumeLimits | undefined;
  /** Current equalizer bands for a zone, or null when the zone is unknown. */
  getEqualizerBands: (zoneId: number) => number[] | null;
  /**
   * Applies equalizer bands. Returns the applied bands, or null when the zone is
   * unknown or the bands are not ten valid values.
   *
   * Deliberately does not forward to an external equalizer provider: a provider that
   * pushed a change here would otherwise receive its own change straight back
   * (sonn-audio/core#251). Only app-originated writes are forwarded.
   */
  setEqualizerBands: (zoneId: number, bands: unknown) => Promise<number[] | null>;
  serverVersion: string;
  startedAt: number;
};

/**
 * Where this API lives. Versioned in the path from the start: additive changes are
 * safe without it, but a field that has to be renamed or removed cannot be, and
 * discovering that after integrators have shipped is too late to fix cheaply.
 */
export const API_ROOT = '/api/v1';

/**
 * The unversioned prefix this API briefly used during the 4.0 beta. Matched only so a
 * caller from that period gets told where things went, never served.
 */
const LEGACY_ROOT = '/api';

/** How long an idle SSE stream waits before emitting a comment to keep proxies from closing it. */
const SSE_KEEPALIVE_MS = 25_000;

export class ApiHandler {
  private readonly log = createLogger('Api');

  constructor(private readonly deps: ApiHandlerDeps) {}

  /**
   * True when this handler owns the path, so the gateway can delegate.
   *
   * Claims unversioned `/api/...` too, purely to answer it properly: without that it
   * would fall through to the static file handler and a caller written against the
   * beta would get an HTML page instead of an explanation.
   */
  public static owns(pathname: string): boolean {
    return (
      pathname === API_ROOT ||
      pathname.startsWith(`${API_ROOT}/`) ||
      pathname === LEGACY_ROOT ||
      pathname.startsWith(`${LEGACY_ROOT}/`)
    );
  }

  public async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const full = url.pathname.replace(/\/+$/, '') || API_ROOT;
    const method = (req.method ?? 'GET').toUpperCase();

    if (method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    // A request without the version is answered, not silently 404'd: say where the
    // API moved rather than leaving the caller guessing. Checked *after* ruling out the
    // versioned prefix, since `/api/v1/...` also starts with `/api/`.
    const versioned = full === API_ROOT || full.startsWith(`${API_ROOT}/`);
    if (!versioned && (full === LEGACY_ROOT || full.startsWith(`${LEGACY_ROOT}/`))) {
      const suffix = full.slice(LEGACY_ROOT.length);
      this.sendJson(res, 404, {
        error: 'api-version-required',
        message: `This API is versioned. Use ${API_ROOT}${suffix} instead of ${full}.`,
      });
      return;
    }

    // Everything below matches against the path *after* the version, so the version
    // lives in one place instead of in every comparison.
    const pathname = full === API_ROOT ? '' : full.slice(API_ROOT.length);

    if (pathname === '/health' && method === 'GET') {
      this.sendJson(res, 200, {
        status: 'ok',
        version: this.deps.serverVersion,
        uptimeSec: Math.round((Date.now() - this.deps.startedAt) / 1000),
      });
      return;
    }

    if (pathname === '/events' && method === 'GET') {
      this.streamEvents(req, res);
      return;
    }

    if (pathname === '/zones' && method === 'GET') {
      this.sendJson(res, 200, { zones: this.snapshot() });
      return;
    }

    const zoneMatch = /^\/zones\/(\d+)(?:\/([a-z]+))?$/.exec(pathname);
    if (zoneMatch) {
      const zoneId = Number(zoneMatch[1]);
      const action = zoneMatch[2];
      // The equalizer is configuration, not playback: it is readable and writable for
      // a configured zone whether or not that zone currently has live state, so it
      // does not go through the live-state lookup below.
      if (action === 'equalizer') {
        await this.handleEqualizer(req, res, method, zoneId);
        return;
      }
      await this.handleZoneRoute(req, res, method, zoneId, action);
      return;
    }

    this.sendJson(res, 404, { error: 'not-found' });
  }

  private async handleZoneRoute(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    zoneId: number,
    action: string | undefined,
  ): Promise<void> {
    const state = this.deps.getZoneState(zoneId);
    if (!state) {
      this.sendJson(res, 404, { error: 'zone-not-found' });
      return;
    }

    if (!action) {
      if (method !== 'GET') {
        this.sendJson(res, 405, { error: 'method-not-allowed' });
        return;
      }
      this.sendJson(res, 200, this.project(state));
      return;
    }

    // Actions that carry no body: the verb is the whole request.
    const simpleCommands: Record<string, string> = {
      play: 'play',
      pause: 'pause',
      stop: 'off',
      next: 'queueplus',
      previous: 'queueminus',
    };

    if (action in simpleCommands && method === 'POST') {
      this.deps.handleCommand(zoneId, simpleCommands[action]!);
      res.writeHead(204).end();
      return;
    }

    if (method !== 'PUT') {
      this.sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await this.readJsonBody(req);
    } catch {
      this.sendJson(res, 400, { error: 'invalid-json' });
      return;
    }

    switch (action) {
      case 'volume': {
        // Absolute `{volume}` or relative `{delta}` — every physical remote steps
        // relatively, and making the client read-then-write would race with itself.
        if (typeof body.delta === 'number' && Number.isFinite(body.delta)) {
          const delta = Math.round(body.delta);
          this.deps.handleCommand(zoneId, 'volume', delta >= 0 ? `+${delta}` : `${delta}`);
          res.writeHead(204).end();
          return;
        }
        // Clamped to the full range here; the zone's own cap (volumeLimits.max) is
        // applied by the command engine, so a write above it lands on the cap.
        const volume = this.clampInt(body.volume, 0, 100);
        if (volume === null) {
          this.sendJson(res, 400, { error: 'invalid-volume' });
          return;
        }
        this.deps.handleCommand(zoneId, 'volume', String(volume));
        res.writeHead(204).end();
        return;
      }
      case 'position': {
        const position = this.clampInt(body.position, 0, Number.MAX_SAFE_INTEGER);
        if (position === null) {
          this.sendJson(res, 400, { error: 'invalid-position' });
          return;
        }
        this.deps.handleCommand(zoneId, 'position', String(position));
        res.writeHead(204).end();
        return;
      }
      case 'power': {
        if (body.power !== 'on' && body.power !== 'off') {
          this.sendJson(res, 400, { error: 'invalid-power' });
          return;
        }
        this.deps.handleCommand(zoneId, body.power === 'on' ? 'on' : 'off');
        res.writeHead(204).end();
        return;
      }
      default:
        this.sendJson(res, 404, { error: 'not-found' });
        return;
    }
  }

  /**
   * Read and write a zone's 10-band equalizer.
   *
   * A GET/PUT pair rather than a command, because this is state a caller owns rather
   * than an action it triggers — an external provider reads what is set, and writes
   * back when its own UI changes. Bands are validated as ten values; anything else is
   * rejected rather than partially applied.
   */
  private async handleEqualizer(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    zoneId: number,
  ): Promise<void> {
    if (method === 'GET') {
      const bands = this.deps.getEqualizerBands(zoneId);
      if (!bands) {
        this.sendJson(res, 404, { error: 'zone-not-found' });
        return;
      }
      this.sendJson(res, 200, { zoneId, bands });
      return;
    }

    if (method !== 'PUT') {
      this.sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await this.readJsonBody(req);
    } catch {
      this.sendJson(res, 400, { error: 'invalid-json' });
      return;
    }

    const applied = await this.deps.setEqualizerBands(zoneId, body.bands);
    if (!applied) {
      // Either the zone is gone or the bands were not ten usable numbers; the caller
      // can tell which from the zone read, and conflating them keeps this simple.
      this.sendJson(res, 400, { error: 'invalid-equalizer-bands' });
      return;
    }
    this.sendJson(res, 200, { zoneId, bands: applied });
  }

  /**
   * SSE rather than a WebSocket: state is one-directional, so the socket buys
   * nothing, and `EventSource`/curl/Perl can all read this without a handshake
   * library. Each stream opens with a `server.ready` snapshot so a client can
   * render before the first state change arrives.
   */
  private streamEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const write = (payload: unknown): void => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    write({ type: 'server.ready', zones: this.snapshot() });

    const unsubscribe = this.deps.eventHub.subscribe((event) => write(event));
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), SSE_KEEPALIVE_MS);

    const close = (): void => {
      clearInterval(keepAlive);
      unsubscribe();
    };
    req.on('close', close);
    req.on('error', close);
    this.log.debug('events stream opened');
  }

  private project(state: ZoneState): ApiZoneState {
    return toApiZoneState(
      state,
      (zoneId) => this.deps.getOutputDevice(zoneId),
      this.deps.getVolumeLimits(state.id),
    );
  }

  private snapshot(): ApiZoneState[] {
    return this.deps.getAllZoneStates().map((state) => this.project(state));
  }

  private clampInt(value: unknown, min: number, max: number): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }
    return Math.min(max, Math.max(min, Math.round(value)));
  }

  private async readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      // Command bodies are a handful of fields; refuse anything that looks like
      // a stream so a bad client cannot grow the heap.
      if (size > 64 * 1024) {
        throw new Error('body-too-large');
      }
      chunks.push(buf);
    }
    if (size === 0) {
      return {};
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not-an-object');
    }
    return parsed as Record<string, unknown>;
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }
}
