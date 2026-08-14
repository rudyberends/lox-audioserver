import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
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

export type SoloistStateEvent = {
  type: string;
  status?: SoloistStatus;
  item?: SoloistItem;
  position?: { position_ms?: number };
  volume?: number;
  /**
   * Whether this device is the one Spotify is actually playing on.
   *
   * Connect pushes the account's playback to every device it has, so an idle room reports the
   * same track, the same status and the same position as the room that is sounding. This is the
   * only thing that tells them apart.
   */
  is_active?: boolean;
};

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
 * Soloist writes the port it chose into `<data-dir>/ws.port` once it is up, so the address is
 * discovered rather than configured — which also means a zone cannot collide with another.
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
    private readonly dataDir: string,
  ) {
    super();
    // Defensive: nothing here emits 'error', but an EventEmitter without a listener for it throws,
    // and this one carries data from a child process.
    this.on('error', () => undefined);
  }

  public async connect(timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const port = await this.waitForPort(timeoutMs);
    if (port === null) {
      this.log.warn('soloist never published a websocket port', { zoneId: this.zoneId });
      return false;
    }
    // The port appears a moment before the socket accepts, so a single refusal means "not yet"
    // rather than "not there". Giving up on the first one killed the process that was starting.
    while (Date.now() < deadline) {
      if (await this.tryConnect(port)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
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

  private async waitForPort(timeoutMs: number): Promise<number | null> {
    const portFile = path.join(this.dataDir, 'ws.port');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const raw = (await fsp.readFile(portFile, 'utf8')).trim();
        const port = Number.parseInt(raw, 10);
        if (Number.isFinite(port) && port > 0) {
          return port;
        }
      } catch {
        /* not written yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
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

  public seek(positionMs: number): boolean {
    return this.send('seek', { position_ms: Math.max(0, Math.round(positionMs)) });
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
