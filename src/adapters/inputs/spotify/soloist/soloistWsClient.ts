import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { createLogger } from '@/shared/logging/logger';

/** Playback states Soloist reports; `buffering` also precedes the move to the next track. */
export type SoloistStatus = 'playing' | 'paused' | 'buffering' | 'idle' | 'stopped';

/** The slice of Soloist's `item` we read. Its shape mirrors the WebSocket's entity decorations. */
export type SoloistItem = {
  uri?: string;
  decorations?: {
    identity?: { name?: string };
    visual_identity?: { cover?: Array<{ url?: string; size?: string }> };
    parent?: { entity?: { decorations?: { identity?: { name?: string } } } };
    creators?: Array<{ entity?: { decorations?: { identity?: { name?: string } } } }>;
    playback?: { duration_ms?: number };
  };
};

/**
 * One line of the queue Soloist keeps.
 *
 * `uid` is its own handle on the entry, which survives a track appearing twice in the same list;
 * `source` says where it came from — `context` for the album or playlist that is playing, against
 * something the listener queued by hand.
 */
export type SoloistQueueEntry = {
  uid?: string;
  source?: string;
  item?: SoloistItem;
};

export type SoloistStateEvent = {
  type: string;
  status?: SoloistStatus;
  item?: SoloistItem;
  position?: { position_ms?: number };
  volume?: number;
  /**
   * What Soloist has played and what it is about to play, either side of the current track — which
   * is itself in neither list. Both arrive on `queue_changed`, unasked after every change and on
   * request via `get_queue`.
   */
  previous?: SoloistQueueEntry[];
  upcoming?: SoloistQueueEntry[];
  /**
   * Whether this device is the one Spotify is actually playing on.
   *
   * Connect pushes the account's playback to every device it has, so an idle room reports the
   * same track, the same status and the same position as the room that is sounding. This is the
   * only thing that tells them apart.
   */
  is_active?: boolean;
  /**
   * What Spotify will accept right now, keyed by command name.
   *
   * Worth reading for one of them. A track that has only just started reports
   * `add_to_queue, pause, set_repeat, shuffle` and refuses a seek with `seek_to_restricted`;
   * `seek` joins the list about three hundred milliseconds later (measured on 1.3.8.12: t+416 ms
   * without, t+730 ms with). So a position asked for at the moment playback begins has to wait for
   * this rather than be retried blindly.
   */
  available_actions?: Record<string, unknown>;
};

/** Soloist refuses anything outside 0-100, and a zone's level can arrive as a fraction. */
export function clampVolume(volume: number): number {
  return Math.max(0, Math.min(100, Math.round(volume)));
}

/** Title, artist, album, duration and art, as this server's metadata shape wants them. */
export function readTrack(item: SoloistItem | undefined): {
  uri?: string;
  title?: string;
  artist?: string;
  album?: string;
  durationSec?: number;
  coverUrl?: string;
} {
  const d = item?.decorations;
  const covers = d?.visual_identity?.cover ?? [];
  // Largest first: the art is fetched once per track and shown at whatever size the client wants.
  const cover =
    covers.find((c) => c.size === 'xlarge') ??
    covers.find((c) => c.size === 'large') ??
    covers.find((c) => c.size === 'default') ??
    covers[0];
  const artists = (d?.creators ?? [])
    .map((c) => c.entity?.decorations?.identity?.name)
    .filter((name): name is string => Boolean(name));
  const durationMs = d?.playback?.duration_ms;
  return {
    uri: item?.uri,
    title: d?.identity?.name,
    artist: artists.join(', ') || undefined,
    album: d?.parent?.entity?.decorations?.identity?.name,
    durationSec: typeof durationMs === 'number' ? Math.round(durationMs / 1000) : undefined,
    coverUrl: cover?.url,
  };
}

/**
 * The control channel of one zone's Soloist.
 *
 * On a port this server picked and handed the process, so there is nothing to discover: Soloist
 * publishes the number it chose for itself only when it was given one, which leaves a process
 * started on port 0 listening somewhere unknowable. See `startPersistent`.
 */
export class SoloistWsClient extends EventEmitter {
  private readonly log = createLogger('Input', 'SoloistWs');
  private socket: WebSocket | null = null;
  private closed = false;
  /** Soloist accepts a socket before it has logged in; commands sent in between are refused. */
  private loggedIn = false;
  /** Whether Spotify is playing on this device, as opposed to merely telling it what is on. */
  private active = false;

  constructor(
    private readonly zoneId: number,
    private readonly port: number,
  ) {
    super();
    // Defensive: nothing here emits 'error', but an EventEmitter without a listener for it throws,
    // and this one carries data from a child process.
    this.on('error', () => undefined);
  }

  public async connect(timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    // The process takes a moment to bind, so a refusal means "not yet" rather than "not there".
    // Giving up on the first one killed the process that was starting.
    while (Date.now() < deadline) {
      if (await this.tryConnect(this.port)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    this.log.warn('soloist never answered on its control port', {
      zoneId: this.zoneId,
      port: this.port,
    });
    return false;
  }

  private tryConnect(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      let settled = false;
      socket.on('open', () => {
        this.socket = socket;
        settled = true;
        this.log.debug('soloist control channel open', { zoneId: this.zoneId, port });
        resolve(true);
      });
      socket.on('message', (raw) => this.handleMessage(raw));
      socket.on('error', (error) => {
        this.log.debug('soloist control channel error', {
          zoneId: this.zoneId,
          message: error.message,
        });
        if (!settled) {
          settled = true;
          resolve(false);
        }
      });
      socket.on('close', () => {
        this.socket = null;
        if (!this.closed) {
          this.emit('disconnected');
        }
      });
    });
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let event: SoloistStateEvent & { logged_in?: boolean; message?: string };
    try {
      event = JSON.parse(raw.toString()) as SoloistStateEvent & { logged_in?: boolean };
    } catch {
      return;
    }
    if (!event?.type) {
      return;
    }
    if (event.type === 'auth_state') {
      this.loggedIn = event.logged_in === true;
    }
    if (typeof event.is_active === 'boolean') {
      this.active = event.is_active;
    }
    if (event.type === 'error') {
      // Never re-emit this under its own name. An EventEmitter throws on an unhandled `error`
      // event, so one line of JSON from a child process would take the whole server down — which
      // is exactly what a "command requires authentication" reply did.
      this.log.warn('soloist refused a command', {
        zoneId: this.zoneId,
        message: event.message ?? '',
      });
    }
    this.emit('event', event);
  }

  /**
   * Wait until Soloist has finished logging in to Spotify.
   *
   * It accepts a connection well before it can act on one — the socket is up while it is still
   * restoring its session — and anything sent in between comes back as "command requires
   * authentication" and is simply lost.
   */
  public async waitUntilReady(timeoutMs = 20_000): Promise<boolean> {
    if (this.loggedIn) {
      return true;
    }
    return new Promise((resolve) => {
      const done = (ok: boolean): void => {
        clearTimeout(timer);
        this.off('event', onEvent);
        resolve(ok);
      };
      const onEvent = (event: SoloistStateEvent & { logged_in?: boolean }): void => {
        if (event.type === 'auth_state' && event.logged_in === true) {
          done(true);
        }
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.on('event', onEvent);
    });
  }

  /** True while Spotify is playing on this device rather than merely mirroring the account. */
  public get isActive(): boolean {
    return this.active;
  }

  private send(command: string, extra: Record<string, unknown> = {}): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.socket.send(JSON.stringify({ type: 'command', command, ...extra }));
    return true;
  }

  public play(uri: string): boolean {
    return this.send('play', { uri });
  }

  public pause(): boolean {
    return this.send('pause');
  }

  /**
   * Carry on where it was paused.
   *
   * `play` with nothing to play is what resumes; there is no `resume` command — asking for one
   * comes back as "unknown command".
   */
  public resume(): boolean {
    return this.send('play');
  }

  /**
   * Ask for the queue.
   *
   * It also arrives unasked whenever it changes, so this is only for the moment a zone is taken
   * over: the takeover itself is announced as playback, and without asking, the queue would stay
   * unknown until the listener happened to change something.
   */
  public requestQueue(): boolean {
    return this.send('get_queue');
  }

  /** Move through the queue Soloist owns. Only meaningful while it is the one holding the list. */
  public skipNext(): boolean {
    return this.send('skip_next');
  }

  public skipPrevious(): boolean {
    return this.send('skip_prev');
  }

  public seek(positionMs: number): boolean {
    return this.send('seek', { position_ms: Math.max(0, Math.round(positionMs)) });
  }

  /**
   * Tell Spotify what level the room is at, so the app's slider stands where the zone does.
   *
   * A label, not a taper. Soloist is started at 100 and never attenuates, and the sound card it
   * plays into keeps the level it is handed rather than applying it — so this number reaches the
   * slider and the volume Connect reports for this device, and nothing else.
   */
  public setVolume(volume: number): boolean {
    return this.send('set_volume', { volume: clampVolume(volume) });
  }

  /**
   * Become the device Spotify plays on.
   *
   * Without this a `play` is a request to the account rather than to this room: Spotify sends it to
   * whichever device currently holds the session, so a second room asking for a track has it start
   * in the first one. Every room that is about to play has to take the account first.
   */
  public activate(): boolean {
    return this.send('activate');
  }

  /**
   * Wait until Spotify is playing on this device.
   *
   * Taking the account is not instant, and it is announced by a `device_changed` that carries the
   * flag rather than by the reply to the command.
   */
  public async waitUntilActive(timeoutMs = 10_000): Promise<boolean> {
    if (this.active) {
      return true;
    }
    return new Promise((resolve) => {
      const done = (ok: boolean): void => {
        clearTimeout(timer);
        this.off('event', onEvent);
        resolve(ok);
      };
      const onEvent = (): void => {
        if (this.active) {
          done(true);
        }
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.on('event', onEvent);
    });
  }

  /**
   * Give up being the active Spotify device.
   *
   * Worth doing when a zone switches to another source: left active, this device keeps the
   * account's playback pinned to a room that is no longer listening.
   */
  public deactivate(): boolean {
    return this.send('deactivate');
  }

  public close(): void {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
  }
}
