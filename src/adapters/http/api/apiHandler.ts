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
import { createHash } from 'node:crypto';
import type { ApiEventHub } from '@/adapters/http/api/apiEventHub';
import { toApiZoneState } from '@/adapters/http/api/zoneProjection';
import type {
  ApiAlertKind,
  ApiDestination,
  ApiLocalDestination,
  ApiStreamFormat,
  ApiBrowseItem,
  ApiBrowseResult,
  ApiInput,
  ApiSearchResult,
  ApiService,
  ApiFavorite,
  ApiGroupResult,
  ApiFavorites,
  ApiOutput,
  ApiQueue,
  ApiRecents,
  ApiVolumeLimits,
  ApiZoneState,
} from '@/domain/zones/apiTypes';
import type { ZoneState } from '@/domain/zones/zoneState';
import { createLogger } from '@/shared/logging/logger';
import { healthHttpStatus, type HealthReport } from '@/domain/server/health';
import type { ServerLifecycleSnapshot } from '@/domain/server/lifecycle';
import { serveCover } from '@/adapters/http/streams/serveCover';
import { COVER_ART_NOW_PLAYING_SIZE, isHttpUrl } from '@/shared/coverArt';

export type ApiHandlerDeps = {
  eventHub: ApiEventHub;
  getAllZoneStates: () => ZoneState[];
  getZoneState: (zoneId: number) => ZoneState | null | undefined;
  handleCommand: (zoneId: number, command: string, payload?: string) => void;
  /** Which device a zone's output plays to, when its protocol identifies one. */
  getOutputDevice: (zoneId: number) => ApiOutput['device'] | undefined;
  /**
   * Starts something on a zone. `uri` is either a stream URL or a `source.id` this API
   * handed out earlier; resolving metadata and rebuilding the queue happens downstream,
   * the same way it does for a Loxone-originated play.
   */
  playContent: (zoneId: number, uri: string) => Promise<void>;
  /** A page of a zone's queue, without the Loxone-facing rewrites. */
  getQueue: (zoneId: number, start: number, limit: number) => ApiQueue | null;
  /** Appends to the end of the queue. */
  queueAppend: (zoneId: number, uri: string) => Promise<void>;
  /** Inserts right after the entry playing now. */
  queueInsertNext: (zoneId: number, uri: string) => Promise<void>;
  /** Jumps to an entry by its id; false when no entry has that id. */
  queuePlay: (zoneId: number, itemId: string) => boolean;
  /** Moves an entry before another, or to the end when `beforeId` is null. */
  queueMove: (zoneId: number, itemId: string, beforeId: string | null) => boolean;
  queueRemove: (zoneId: number, itemId: string) => void;
  queueClear: (zoneId: number) => void;
  /** Reverts the last queue edit. */
  queueUndo: (zoneId: number) => void;
  /** A page of a zone's favourites. */
  getFavorites: (zoneId: number, start: number, limit: number) => Promise<ApiFavorites | null>;
  /** Adds a favourite; returns the created one. */
  addFavorite: (zoneId: number, name: string, uri: string) => Promise<ApiFavorite>;
  renameFavorite: (zoneId: number, id: number, name: string) => Promise<void>;
  removeFavorite: (zoneId: number, id: number) => Promise<void>;
  /** Reorders the whole list to the given ids. */
  reorderFavorites: (zoneId: number, ids: number[]) => Promise<void>;
  /** Starts a favourite by its id; false when the zone has no such favourite. */
  playFavorite: (zoneId: number, id: number) => Promise<boolean>;
  /** A page of what a zone played before, most recent first. */
  getRecents: (zoneId: number, start: number, limit: number) => Promise<ApiRecents | null>;
  clearRecents: (zoneId: number) => Promise<void>;
  /**
   * Puts a zone at the head of a group with these members, or ungroups it when the list
   * is empty. Returns what the group became, including anything rejected.
   */
  setGroup: (zoneId: number, members: number[]) => ApiGroupResult | null;
  /**
   * Plays or stops an alert. Null when the zone is unknown; otherwise the alerts layer's
   * own verdict, which can still be a refusal (no TTS provider, missing sound).
   */
  playAlert: (request: {
    zoneId: number;
    type: string;
    action: 'on' | 'off';
    zones: number[];
    text?: string;
    language?: string;
    volume?: number;
  }) => Promise<{ success: boolean; action: 'on' | 'off'; reason?: string } | null>;
  /**
   * The cover for what a zone is playing now: inline bytes, a data uri, or a url to
   * proxy. Null when the zone has none.
   */
  getZoneCover: (
    zoneId: number,
    targetSize: number,
  ) => { data: Buffer; mime?: string } | string | null;
  /** Which protocol a zone plays over right now; see ApiOutput. */
  getOutputProtocol: (zoneId: number) => string | null;
  /** The configured name of the service an audiopath belongs to, for `source.name`. */
  getServiceLabel: (audiopath: string) => string | null;
  /** The configured name of a line-in, so `source.name` is not the server's MAC. */
  getInputLabel: (inputId: string) => string | null;
  /** What a zone is streaming right now, for `format`. */
  getStreamFormat: (zoneId: number) => ApiStreamFormat | null;
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
  /** Everywhere audio can be sent right now. */
  listDestinations: () => ApiDestination[];
  /**
   * Registers the caller as a destination that plays audio itself. Null when this runtime was
   * built without local playback.
   */
  registerLocalDestination: (options: {
    name?: string;
    clientId?: string;
    host?: string;
  }) => Promise<ApiLocalDestination | null>;
  /** Removes a local destination; false when there is no such one. */
  removeLocalDestination: (id: string) => Promise<boolean>;
  /** Every content service, with what it can actually search. */
  listServices: () => Promise<ApiService[]>;
  /**
   * Lists a container's children. Null when the id is not one of ours or names nothing.
   */
  browse: (id: string, start: number, limit: number) => Promise<ApiBrowseResult | null>;
  /** Describes one item by id. Null when it cannot be found. */
  describeItem: (id: string) => Promise<ApiBrowseItem | null>;
  /** Searches across services, grouped by kind. */
  search: (request: {
    query: string;
    kinds: string[];
    services: string[];
    limit: number;
  }) => Promise<ApiSearchResult>;
  /** Every configured input, in configuration order. */
  getInputs: () => ApiInput[];
  /**
   * Switches a zone to an input. False when no input has that id.
   *
   * There is no counterpart: leaving an input means selecting something else, which the
   * ordinary play/favourite paths already do.
   */
  selectInput: (zoneId: number, inputId: string) => boolean;
  /** The current health verdict; see buildHealthReport. */
  getHealth: () => HealthReport;
  /** Whether the server is serving yet, for the cheap readiness probe. */
  getLifecycle: () => ServerLifecycleSnapshot;
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

/**
 * Browse paging bounds.
 *
 * Capped because a caller asking for everything is usually a mistake, and several providers
 * fetch a whole upstream page per request. 50 is the same default the Loxone dialect uses.
 */
const BROWSE_DEFAULT_LIMIT = 50;
const BROWSE_MAX_LIMIT = 500;

/**
 * Search paging bounds, per kind.
 *
 * The internal search layer clamps to 20 per category, which is why no consumer can fetch a
 * second page today. This API's own ceiling is set higher so it does not become the binding
 * limit once that is lifted.
 */
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 100;

/**
 * What you can do through a `/destinations/…` path.
 *
 * Playback only — but not because a local destination lacks the rest. It *is* a zone: it
 * appears in `GET /zones` with full state, and the queue, favourites, recents and grouping
 * routes all work on it. So this set is about which name addresses what, not about capability.
 *
 * `/destinations` earns its place for the one thing `/zones` cannot express — registering a
 * client as somewhere audio goes, and telling a zone from a tab. Playback is mirrored here so a
 * caller that only holds a destination id never has to know it is also a zone id. Everything
 * else lives under `/zones/…`, which is where a caller looking for the queue will look.
 */
const DESTINATION_ACTIONS = new Set([
  'play',
  'pause',
  'stop',
  'next',
  'previous',
  'volume',
  'position',
  'power',
  'repeat',
  'shuffle',
  'cover',
  'alert',
]);

/** The alert kinds this API accepts; `url` becomes a custom sound. */
const ALERT_KINDS: ApiAlertKind[] = ['tts', 'bell', 'alarm', 'fire', 'buzzer', 'url'];

/**
 * How the alerts layer spells "play this arbitrary sound". It takes the url as part of the
 * type rather than as its own argument, so a caller-supplied url is prefixed with this.
 */
const ALERT_CUSTOM_URL_PREFIX = 'custom_url/';

/** Smallest and largest cover a caller may ask for; outside this it is treated as unasked. */
const COVER_SIZE_MIN = 32;
const COVER_SIZE_MAX = 2000;

/**
 * Where a paged request starts.
 *
 * Accepts `start` and `offset` as the same thing. The response field is `start`, so that is
 * the documented name — but `/browse` shipped reading only `offset`, and a caller reading
 * `start` out of one response and writing `offset` into the next request is a trap worth
 * removing rather than documenting. Both work everywhere; neither is silently ignored.
 */
function pagingStart(params: URLSearchParams): number {
  const raw = params.get('start') ?? params.get('offset') ?? '0';
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * The cover size a `?size=` parameter asks for, or the now-playing default.
 *
 * Deliberately *not* clamped: an absent or nonsensical size means "no preference", and
 * clamping it would silently turn that into the nearest bound. Clamping a missing size to
 * the minimum is how this route once served 16px thumbnails to everyone who omitted it.
 */
function coverSize(raw: string | null): number {
  const requested = Number(raw);
  if (!raw || !Number.isFinite(requested)) {
    return COVER_ART_NOW_PLAYING_SIZE;
  }
  const rounded = Math.round(requested);
  return rounded >= COVER_SIZE_MIN && rounded <= COVER_SIZE_MAX
    ? rounded
    : COVER_ART_NOW_PLAYING_SIZE;
}

/**
 * A tag identifying which cover a response carried, or undefined when there is none.
 *
 * Hashed from what the artwork *is* — the upstream url, or the bytes when they are inline
 * — plus the requested size, since two sizes are different images at the same url. It is
 * therefore stable across restarts and identical across servers, which a counter or a
 * timestamp would not be.
 */
function coverEtag(
  cover: { data: Buffer; mime?: string } | string | null,
  size: number,
): string | undefined {
  if (!cover) {
    return undefined;
  }
  const identity = typeof cover === 'string' ? Buffer.from(cover) : cover.data;
  const hash = createHash('sha1').update(identity).update(`@${size}`).digest('base64url');
  return `"${hash}"`;
}

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
      const report = this.deps.getHealth();
      this.sendJson(res, healthHttpStatus(report.status), report);
      return;
    }

    // Separate from /health on purpose: a supervisor asking "can I stop waiting?" wants a
    // yes/no it can read from a status code, not a report it has to parse. Kept cheap
    // enough to poll every second, which is what replaces waiting on a file lock.
    if (pathname === '/ready' && method === 'GET') {
      const lifecycle = this.deps.getLifecycle();
      const ready = lifecycle.phase === 'ready';
      this.sendJson(res, ready ? 200 : 503, {
        ready,
        phase: lifecycle.phase,
        ...(lifecycle.error ? { error: lifecycle.error } : {}),
      });
      return;
    }

    if (pathname === '/events' && method === 'GET') {
      this.streamEvents(req, res);
      return;
    }

    if (pathname === '/services' && method === 'GET') {
      this.sendJson(res, 200, { services: await this.deps.listServices() });
      return;
    }

    if (pathname === '/search' && method === 'GET') {
      await this.handleSearch(res, url);
      return;
    }

    // The root has no id of its own, so `/browse` and `/browse/{id}` are one route with the
    // id optional rather than two.
    const browseMatch = /^\/browse(?:\/(.+))?$/.exec(pathname);
    if (browseMatch && method === 'GET') {
      await this.handleBrowse(res, browseMatch[1], url);
      return;
    }

    const itemMatch = /^\/items\/(.+)$/.exec(pathname);
    if (itemMatch && method === 'GET') {
      await this.handleItem(res, itemMatch[1]!);
      return;
    }

    if (pathname === '/destinations' && method === 'GET') {
      this.sendJson(res, 200, { destinations: this.deps.listDestinations() });
      return;
    }

    // `local` is a literal, not an id: a caller registering itself has no id yet, and this
    // is the one route where the server assigns one.
    if (pathname === '/destinations/local' && method === 'POST') {
      await this.handleRegisterLocal(req, res);
      return;
    }

    const localMatch = /^\/destinations\/local\/(.+)$/.exec(pathname);
    if (localMatch && method === 'DELETE') {
      const removed = await this.deps.removeLocalDestination(localMatch[1]!);
      if (!removed) {
        this.sendJson(res, 404, { error: 'destination-not-found' });
        return;
      }
      res.writeHead(204).end();
      return;
    }

    if (pathname === '/inputs' && method === 'GET') {
      // Server-level, not per zone: an input is selectable from any zone, so hanging the
      // list off one would imply each has its own.
      this.sendJson(res, 200, { inputs: this.deps.getInputs() });
      return;
    }

    if (pathname === '/zones' && method === 'GET') {
      this.sendJson(res, 200, { zones: this.snapshot() });
      return;
    }

    // A destination's id is its zone id, so `/destinations/{id}/pause` is the same command as
    // `/zones/{id}/pause` and shares the dispatcher below rather than duplicating fourteen
    // verbs. The two names are not redundant: a server with no zones configured still has
    // destinations, which is the whole point of the split — zones are optional, somewhere to
    // send audio is not.
    //
    // Only playback verbs are reachable this way. Grouping, favourites, recents and the queue
    // stay on `/zones/…` because they are things only a configured zone has.
    const destinationMatch = /^\/destinations\/(\d+)(?:\/([a-z]+))?$/.exec(pathname);
    const zoneMatch =
      /^\/zones\/(\d+)(?:\/([a-z]+))?$/.exec(pathname) ??
      (destinationMatch && (!destinationMatch[2] || DESTINATION_ACTIONS.has(destinationMatch[2]))
        ? destinationMatch
        : null);
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
      if (action === 'queue') {
        await this.handleQueue(req, res, method, zoneId, url);
        return;
      }
      if (action === 'favorites') {
        await this.handleFavorites(req, res, method, zoneId, url);
        return;
      }
      if (action === 'recents') {
        await this.handleRecents(res, method, zoneId, url);
        return;
      }
      if (action === 'group') {
        await this.handleGroup(req, res, method, zoneId);
        return;
      }
      if (action === 'cover') {
        await this.handleCover(req, res, method, zoneId, url);
        return;
      }
      if (action === 'alert') {
        await this.handleAlert(req, res, method, zoneId);
        return;
      }
      if (action === 'input') {
        await this.handleInput(req, res, method, zoneId);
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
      // `play` with a body starts something; without one it resumes whatever is
      // already queued. Everything else takes no body at all.
      if (action === 'play') {
        let body: Record<string, unknown>;
        try {
          body = await this.readJsonBody(req);
        } catch {
          this.sendJson(res, 400, { error: 'invalid-json' });
          return;
        }
        const uri = typeof body.uri === 'string' ? body.uri.trim() : '';
        if (uri) {
          await this.deps.playContent(zoneId, uri);
          res.writeHead(204).end();
          return;
        }
        if (body.uri !== undefined) {
          this.sendJson(res, 400, { error: 'invalid-uri' });
          return;
        }
      }
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
      case 'repeat': {
        // The engine's own vocabulary for this is 'off' | 'all' | 'one', so the value
        // passes straight through rather than being translated to a number here.
        if (body.repeat !== 'off' && body.repeat !== 'all' && body.repeat !== 'one') {
          this.sendJson(res, 400, { error: 'invalid-repeat' });
          return;
        }
        this.deps.handleCommand(zoneId, 'repeat', body.repeat);
        res.writeHead(204).end();
        return;
      }
      case 'shuffle': {
        if (typeof body.shuffle !== 'boolean') {
          this.sendJson(res, 400, { error: 'invalid-shuffle' });
          return;
        }
        this.deps.handleCommand(zoneId, 'shuffle', body.shuffle ? 'on' : 'off');
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
   * A zone's queue as one resource with four verbs, where the Loxone dialect has eight
   * commands (queueadd, queueinsert, queueandplay, queue/play, queue/move/…/before/…,
   * queue/remove, queue/clear, queueundo). Same capabilities, addressed by what they do
   * to the collection rather than by their own names.
   *
   *   GET    ?start=&limit=   read a page
   *   POST   {uri, next?}     add — at the end, or right after what is playing
   *   PATCH  {play|move}      jump to an entry, or reorder one
   *   DELETE {id?} | {undo}   remove one entry, clear the lot, or undo the last edit
   */
  private async handleQueue(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    zoneId: number,
    url: URL,
  ): Promise<void> {
    if (method === 'GET') {
      const start = pagingStart(url.searchParams);
      const limit = this.clampInt(Number(url.searchParams.get('limit') ?? 100), 1, 500) ?? 100;
      const queue = this.deps.getQueue(zoneId, start, limit);
      if (!queue) {
        this.sendJson(res, 404, { error: 'zone-not-found' });
        return;
      }
      this.sendJson(res, 200, queue);
      return;
    }

    if (method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') {
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

    if (method === 'POST') {
      const uri = typeof body.uri === 'string' ? body.uri.trim() : '';
      if (!uri) {
        this.sendJson(res, 400, { error: 'invalid-uri' });
        return;
      }
      // `next: true` is "play this after the current track" — the one placement worth
      // naming, since anything else is just an append followed by a move.
      if (body.next === true) {
        await this.deps.queueInsertNext(zoneId, uri);
      } else {
        await this.deps.queueAppend(zoneId, uri);
      }
      res.writeHead(204).end();
      return;
    }

    if (method === 'PATCH') {
      const play = typeof body.play === 'string' ? body.play.trim() : '';
      if (play) {
        if (!this.deps.queuePlay(zoneId, play)) {
          this.sendJson(res, 404, { error: 'queue-item-not-found' });
          return;
        }
        res.writeHead(204).end();
        return;
      }
      const move = typeof body.move === 'string' ? body.move.trim() : '';
      if (move) {
        // `before: null` (or absent) moves it to the end.
        const before = typeof body.before === 'string' ? body.before.trim() || null : null;
        if (!this.deps.queueMove(zoneId, move, before)) {
          this.sendJson(res, 404, { error: 'queue-item-not-found' });
          return;
        }
        res.writeHead(204).end();
        return;
      }
      this.sendJson(res, 400, { error: 'invalid-queue-patch' });
      return;
    }

    // DELETE
    if (body.undo === true) {
      this.deps.queueUndo(zoneId);
      res.writeHead(204).end();
      return;
    }
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (id) {
      this.deps.queueRemove(zoneId, id);
      res.writeHead(204).end();
      return;
    }
    // No id and no undo: clear the whole queue. Explicit, since an empty DELETE body
    // meaning "everything" should be a decision rather than an accident.
    if (body.all === true) {
      this.deps.queueClear(zoneId);
      res.writeHead(204).end();
      return;
    }
    this.sendJson(res, 400, { error: 'invalid-queue-delete' });
  }

  /**
   * The cover art for whatever a zone is playing, at a stable url.
   *
   * `track.coverUrl` already points at the artwork, but it changes per track and can be
   * a remote host or a data uri — neither of which you can put in an `<img src>` on a
   * wall panel and leave there. This url only names the zone, so it keeps working as the
   * music changes. (The `/streams/{zone}/{session}/cover` route is a different thing: it
   * exists so a Cast or DLNA device can fetch artwork itself, and carries a session id
   * precisely so those devices stop caching the previous track's image.)
   *
   * `size` is a hint, not a promise: it is passed upstream where the provider supports
   * variants (Apple Music, TuneIn, imageproxy) rather than being resized here. Asking a
   * CDN for a smaller image beats scaling a bigger one.
   *
   * Because the url deliberately does not change per track, cache-busting is handled two
   * ways: an `ETag` derived from the resolved artwork, so a polling client revalidates for
   * a bodyless `304` and still sees a new cover immediately; and any unrecognised query
   * parameter, which a client can vary (`?v=<track id>`) to defeat a cache it does not
   * control — a Loxone visualisation will happily hold an `<img src>` far longer than
   * `max-age` suggests.
   */
  private async handleCover(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    zoneId: number,
    url: URL,
  ): Promise<void> {
    if (method !== 'GET') {
      this.sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }
    const size = coverSize(url.searchParams.get('size'));
    const cover = this.deps.getZoneCover(zoneId, size);
    await serveCover(res, cover, this.log, {
      // Held briefly: a panel polling this should not re-fetch the same artwork every
      // second, but must still notice the next track without changing the url.
      cacheControl: 'public, max-age=10',
      etag: coverEtag(cover, size),
      ifNoneMatch: req.headers['if-none-match'],
    });
  }

  /**
   * A zone's sync group, as the membership it has rather than the Loxone dialect's
   * `dgroup/update/<id>/<csv>` plus a separate `dgroup/update/new/...` for creating one.
   * Putting a zone at the head of a list is the same operation either way.
   *
   *   PUT {members: [ids…]}   group these zones behind this one
   *   PUT {members: []}       ungroup
   *
   * Answers 200 rather than 204, because the result is worth reading: a member on a
   * different output protocol cannot join unless mixed groups are enabled, and saying so
   * beats leaving the caller to diff what it asked for against the next zone event.
   */
  private async handleGroup(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    zoneId: number,
  ): Promise<void> {
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
    if (!Array.isArray(body.members)) {
      this.sendJson(res, 400, { error: 'invalid-members' });
      return;
    }
    const members = body.members.filter(
      (v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0,
    );
    if (members.length !== body.members.length) {
      this.sendJson(res, 400, { error: 'invalid-members' });
      return;
    }
    const result = this.deps.setGroup(zoneId, members);
    if (!result) {
      this.sendJson(res, 404, { error: 'zone-not-found' });
      return;
    }
    this.sendJson(res, 200, result);
  }

  /**
   * Registers the caller as a destination that plays audio itself.
   *
   * This is what makes zones optional: a client can be somewhere audio goes without a zone
   * existing anywhere. It hands back a client id and a socket; nothing plays until the caller
   * connects, so this only reserves the identity.
   *
   * Passing back a `clientId` reclaims an existing registration, which a page reload needs —
   * without it every refresh would leave an orphan behind until it timed out.
   */
  private async handleRegisterLocal(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await this.readJsonBody(req);
    } catch {
      this.sendJson(res, 400, { error: 'invalid-json' });
      return;
    }
    const name = typeof body.name === 'string' ? body.name.trim() : undefined;
    const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : undefined;
    const destination = await this.deps.registerLocalDestination({
      ...(name ? { name } : {}),
      ...(clientId ? { clientId } : {}),
      // The address that reached us is the one address this caller is known to be able to
      // use — a configured bind address may be 0.0.0.0, or an interface it cannot route to.
      ...(req.headers.host ? { host: req.headers.host } : {}),
    });
    if (!destination) {
      this.sendJson(res, 501, {
        error: 'local-playback-unavailable',
        message: 'This server was built without local playback.',
      });
      return;
    }
    this.sendJson(res, 201, destination);
  }

  /**
   * Lists a container's children, or the services at the root.
   *
   * The root is every configured service — the library, radio, and each streaming account
   * under its own name. There is no `spotify@bridge-…` disguise here: that translation
   * exists for the Loxone clients, which know exactly one streaming service, and it stops
   * at that adapter.
   */
  private async handleBrowse(
    res: ServerResponse,
    rawId: string | undefined,
    url: URL,
  ): Promise<void> {
    const start = pagingStart(url.searchParams);
    const limit = this.clampInt(Number(url.searchParams.get('limit') ?? 0), 1, BROWSE_MAX_LIMIT)
      ?? BROWSE_DEFAULT_LIMIT;

    if (!rawId) {
      const services = await this.deps.listServices();
      // The root is synthesised, not fetched: it has no container of its own and its total
      // is exactly the number of services, so it is the one listing that is always honest.
      this.sendJson(res, 200, {
        container: null,
        items: services.map((service) => ({
          id: service.rootId,
          name: service.name,
          kind: 'category' as const,
          browsable: true,
          playable: false,
          service: service.id,
        })),
        start: 0,
        total: services.length,
      });
      return;
    }

    const result = await this.deps.browse(rawId, start, limit);
    if (!result) {
      this.sendJson(res, 404, { error: 'not-found' });
      return;
    }
    this.sendJson(res, 200, result);
  }

  /**
   * Describes one item by its id — the capability neither Loxone nor Music Assistant has.
   *
   * Worth having because a client that deep-links, restores a session or receives an id from
   * elsewhere has no parent listing to take the name from. Where the content layer genuinely
   * cannot answer, `name` comes back empty rather than filled with the raw id: Music
   * Assistant returns the id as the name in this case, which looks like data and is not.
   */
  private async handleItem(res: ServerResponse, rawId: string): Promise<void> {
    const item = await this.deps.describeItem(rawId);
    if (!item) {
      this.sendJson(res, 404, { error: 'not-found' });
      return;
    }
    this.sendJson(res, 200, item);
  }

  /**
   * Searches across services, grouped by kind.
   *
   * `kind` narrows what is asked for, which is not just a filter: a provider that cannot
   * search a kind is skipped for it entirely rather than asked and ignored. `service`
   * narrows which providers are asked.
   */
  private async handleSearch(res: ServerResponse, url: URL): Promise<void> {
    const query = (url.searchParams.get('q') ?? '').trim();
    if (!query) {
      this.sendJson(res, 400, { error: 'invalid-query', message: 'q is required.' });
      return;
    }
    const kinds = (url.searchParams.get('kind') ?? '')
      .split(',')
      .map((kind) => kind.trim().toLowerCase())
      .filter(Boolean);
    const services = (url.searchParams.get('service') ?? '')
      .split(',')
      .map((service) => service.trim().toLowerCase())
      .filter(Boolean);
    const limit = this.clampInt(Number(url.searchParams.get('limit') ?? 0), 1, SEARCH_MAX_LIMIT)
      ?? SEARCH_DEFAULT_LIMIT;

    this.sendJson(res, 200, await this.deps.search({ query, kinds, services, limit }));
  }

  /**
   * Switches a zone to one of the configured inputs.
   *
   * `input` is the id from `GET /api/v1/inputs` — the same string `source.id` reports back
   * once the zone is on it, which is what closes the loop: until now you could see a zone
   * was on a line-in but not put it there.
   *
   * There is no counterpart for leaving one. Selecting something else is how you leave —
   * a `play`, a favourite, another input — and the server tears the old source down as
   * part of that. A `DELETE` would be a third way to express it with "and what plays now?"
   * left unanswered.
   */
  private async handleInput(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    zoneId: number,
  ): Promise<void> {
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
    const inputId = typeof body.input === 'string' ? body.input.trim() : '';
    if (!inputId) {
      this.sendJson(res, 400, { error: 'invalid-input' });
      return;
    }
    if (!this.deps.getZoneState(zoneId)) {
      this.sendJson(res, 404, { error: 'zone-not-found' });
      return;
    }
    // Distinguished from an unknown zone on purpose: "you named an input that is not
    // configured" is a different mistake from "that zone does not exist", and a caller
    // reading ids out of GET /inputs deserves to be told which.
    if (!this.deps.selectInput(zoneId, inputId)) {
      this.sendJson(res, 404, { error: 'input-not-found' });
      return;
    }
    res.writeHead(204).end();
  }

  /**
   * Plays a sound or a spoken message over whatever a zone was doing.
   *
   * A resource rather than a `play` with a special uri, because an alert is an interruption
   * and not a queue entry: the zone's own playback is ducked and resumed around it, the
   * volume comes from that zone's configured alert level rather than its current one, and
   * one call can interrupt several zones as a single announcement.
   *
   * This is the thing an integrator actually asks a music server for — "say in the kitchen
   * that dinner is ready" — and until now only the Loxone clients could do it, spread over
   * `audio/<id>/tts`, `/alert`, `playeventfile` and `groupalert`.
   *
   * `DELETE` stops one, which matters for the looping kinds (`alarm`, `fire`): they play
   * until told otherwise.
   */
  private async handleAlert(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    zoneId: number,
  ): Promise<void> {
    if (method !== 'POST' && method !== 'DELETE') {
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

    const kind = typeof body.kind === 'string' ? body.kind.trim().toLowerCase() : '';
    if (!ALERT_KINDS.includes(kind as ApiAlertKind)) {
      this.sendJson(res, 400, {
        error: 'invalid-alert-kind',
        message: `kind must be one of: ${ALERT_KINDS.join(', ')}.`,
      });
      return;
    }

    // Extra zones join the announcement; the zone in the path always leads it.
    const extra = body.zones === undefined ? [] : body.zones;
    if (!Array.isArray(extra)) {
      this.sendJson(res, 400, { error: 'invalid-zones' });
      return;
    }
    const valid = extra.filter(
      (v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0,
    );
    if (valid.length !== extra.length) {
      this.sendJson(res, 400, { error: 'invalid-zones' });
      return;
    }
    const zones = [zoneId, ...valid.filter((id) => id !== zoneId)];

    const volume = body.volume === undefined ? undefined : this.clampInt(body.volume, 0, 100);
    if (body.volume !== undefined && volume === null) {
      this.sendJson(res, 400, { error: 'invalid-volume' });
      return;
    }

    let text: string | undefined;
    let language: string | undefined;
    let target = kind;
    if (kind === 'tts') {
      text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) {
        this.sendJson(res, 400, { error: 'invalid-text', message: 'tts needs text to speak.' });
        return;
      }
      language = typeof body.language === 'string' ? body.language.trim().toLowerCase() : undefined;
    } else if (kind === 'url') {
      const raw = typeof body.url === 'string' ? body.url.trim() : '';
      if (!isHttpUrl(raw)) {
        this.sendJson(res, 400, {
          error: 'invalid-url',
          message: 'url must be an http(s) address the server can reach.',
        });
        return;
      }
      // The alerts layer takes an arbitrary sound as a `custom_url/` type rather than as a
      // separate argument, so the url travels in place of the kind.
      target = `${ALERT_CUSTOM_URL_PREFIX}${raw}`;
    }

    const result = await this.deps.playAlert({
      zoneId,
      type: target,
      action: method === 'DELETE' ? 'off' : 'on',
      zones,
      text,
      language,
      volume: volume ?? undefined,
    });
    if (!result) {
      this.sendJson(res, 404, { error: 'zone-not-found' });
      return;
    }
    if (!result.success) {
      // The alerts layer refused it — a missing sound file, no TTS provider configured.
      this.sendJson(res, 422, { error: result.reason ?? 'alert-failed', kind });
      return;
    }
    this.sendJson(res, 200, {
      zoneId,
      kind,
      action: result.action,
      zones,
    });
  }

  /**
   * A zone's favourites, as a collection rather than the Loxone dialect's separate
   * roomfavs/add, /setname, /setid, /delete and roomfav/play commands.
   *
   *   GET    ?start=&limit=        read a page
   *   POST   {uri, name?}          add one
   *   PATCH  {id, name}            rename it
   *   PATCH  {order: [ids…]}       reorder the list
   *   PATCH  {play: id}            start it
   *   DELETE {id}                  remove it
   */
  private async handleFavorites(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    zoneId: number,
    url: URL,
  ): Promise<void> {
    if (method === 'GET') {
      const start = pagingStart(url.searchParams);
      const limit = this.clampInt(Number(url.searchParams.get('limit') ?? 50), 1, 500) ?? 50;
      const favorites = await this.deps.getFavorites(zoneId, start, limit);
      if (!favorites) {
        this.sendJson(res, 404, { error: 'zone-not-found' });
        return;
      }
      this.sendJson(res, 200, favorites);
      return;
    }

    if (method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') {
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

    if (method === 'POST') {
      const uri = typeof body.uri === 'string' ? body.uri.trim() : '';
      if (!uri) {
        this.sendJson(res, 400, { error: 'invalid-uri' });
        return;
      }
      // The name is optional: without one the server fills in what it knows about the
      // source, which is usually better than what a caller would invent.
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const created = await this.deps.addFavorite(zoneId, name, uri);
      this.sendJson(res, 201, created);
      return;
    }

    if (method === 'PATCH') {
      if (Array.isArray(body.order)) {
        const ids = body.order.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
        if (ids.length !== body.order.length) {
          this.sendJson(res, 400, { error: 'invalid-favorite-order' });
          return;
        }
        await this.deps.reorderFavorites(zoneId, ids);
        res.writeHead(204).end();
        return;
      }
      if (typeof body.play === 'number' && Number.isFinite(body.play)) {
        if (!(await this.deps.playFavorite(zoneId, body.play))) {
          this.sendJson(res, 404, { error: 'favorite-not-found' });
          return;
        }
        res.writeHead(204).end();
        return;
      }
      const id = typeof body.id === 'number' && Number.isFinite(body.id) ? body.id : null;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (id === null || !name) {
        this.sendJson(res, 400, { error: 'invalid-favorite-patch' });
        return;
      }
      await this.deps.renameFavorite(zoneId, id, name);
      res.writeHead(204).end();
      return;
    }

    const id = typeof body.id === 'number' && Number.isFinite(body.id) ? body.id : null;
    if (id === null) {
      this.sendJson(res, 400, { error: 'invalid-favorite-delete' });
      return;
    }
    await this.deps.removeFavorite(zoneId, id);
    res.writeHead(204).end();
  }

  /**
   * What a zone played before. Read-only apart from clearing: a recent entry has no
   * handle to rename or reorder — it is history, and `source` is what you replay.
   */
  private async handleRecents(
    res: ServerResponse,
    method: string,
    zoneId: number,
    url: URL,
  ): Promise<void> {
    if (method === 'GET') {
      const start = pagingStart(url.searchParams);
      const limit = this.clampInt(Number(url.searchParams.get('limit') ?? 50), 1, 500) ?? 50;
      const recents = await this.deps.getRecents(zoneId, start, limit);
      if (!recents) {
        this.sendJson(res, 404, { error: 'zone-not-found' });
        return;
      }
      this.sendJson(res, 200, recents);
      return;
    }
    if (method === 'DELETE') {
      await this.deps.clearRecents(zoneId);
      res.writeHead(204).end();
      return;
    }
    this.sendJson(res, 405, { error: 'method-not-allowed' });
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
    return toApiZoneState(state, {
      device: (zoneId) => this.deps.getOutputDevice(zoneId),
      outputProtocol: (zoneId) => this.deps.getOutputProtocol(zoneId),
      serviceLabel: (audiopath) => this.deps.getServiceLabel(audiopath),
      inputLabel: (inputId) => this.deps.getInputLabel(inputId),
      streamFormat: (zoneId) => this.deps.getStreamFormat(zoneId),
      volumeLimits: this.deps.getVolumeLimits(state.id),
    });
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
