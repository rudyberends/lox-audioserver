import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import { SlimServer, EventType, type SlimEvent, type SlimClient } from '@lox-audioserver/node-slimproto';

type PlayerSnapshot = {
  name?: string;
  address?: string;
  port?: number;
  deviceType?: string;
  firmware?: string;
  supportedCodecs?: string[];
  maxSampleRate?: number;
  state?: string;
  jiffies?: number;
  elapsedMs?: number;
  volume?: number;
  lastHeartbeatAt?: number | null;
  clockRttMs?: number;
  clockAgeMs?: number;
  url?: string;
  mimeType?: string;
  itemId?: string;
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
  lastLoggedKey?: string;
};

export class SqueezeliteCore {
  private readonly log = createLogger('Output', 'SqueezeliteCore');
  private server: SlimServer | null = null;
  private started = false;
  private loggingBound = false;
  private readonly snapshots = new Map<string, PlayerSnapshot>();

  constructor(private readonly configPort: ConfigPort) {
    // Server is created lazily after config is loaded.
  }

  public async start(): Promise<void> {
    if (this.started) return;
    if (!this.server) {
      this.server = new SlimServer();
    }
    const sys = this.configPort.getSystemConfig();
    const ipAddress = sys?.audioserver?.ip?.trim() || undefined;
    const name = sys?.audioserver?.name?.trim() || 'Loxone Audio Server';
    const controlPort = normalizePort(sys?.audioserver?.slimprotoPort);
    const cliPort = normalizePort(sys?.audioserver?.slimprotoCliPort);
    const cliPortJson = normalizePort(sys?.audioserver?.slimprotoJsonPort);
    this.server.options.ipAddress = ipAddress;
    this.server.options.name = name;
    if (controlPort) {
      this.server.options.controlPort = controlPort;
    }
    if (cliPort) {
      this.server.options.cliPort = cliPort;
    }
    if (cliPortJson) {
      this.server.options.cliPortJson = cliPortJson;
    }
    await this.server.start();
    this.started = true;
    this.bindLogging();
    this.log.info('SlimProto server started', { port: this.server.options.controlPort ?? 3483 });
  }

  public async stop(): Promise<void> {
    if (!this.started) return;
    await this.server?.stop();
    this.started = false;
    this.log.info('SlimProto server stopped');
  }

  public get players(): SlimClient[] {
    return this.server?.players ?? [];
  }

  public getPlayer(playerId: string): SlimClient | undefined {
    return this.server?.getPlayer(playerId);
  }

  public subscribe(
    cb: (event: SlimEvent) => void | Promise<void>,
    eventFilter?: EventType | EventType[] | null,
    playerFilter?: string | string[] | null,
  ): () => void {
    if (!this.server) {
      this.server = new SlimServer();
    }
    return this.server.subscribe(cb, eventFilter, playerFilter);
  }

  private bindLogging(): void {
    if (this.loggingBound || !this.server) return;
    this.loggingBound = true;
    this.server.subscribe((event) => this.handleLogEvent(event), [
      EventType.PLAYER_CONNECTED,
      EventType.PLAYER_NAME_RECEIVED,
      EventType.PLAYER_DISCONNECTED,
      EventType.PLAYER_UPDATED,
      EventType.PLAYER_HEARTBEAT,
      EventType.PLAYER_DECODER_READY,
      EventType.PLAYER_DECODER_ERROR,
      EventType.PLAYER_OUTPUT_UNDERRUN,
      EventType.PLAYER_BUFFER_READY,
      EventType.PLAYER_DISPLAY_RESOLUTION,
    ]);
  }

  private handleLogEvent(event: SlimEvent): void {
    if (!this.server) return;
    const playerId = event.playerId;
    const player = this.server.getPlayer(playerId);
    const snapshot = this.getOrCreateSnapshot(playerId);

    if (player) {
      this.updateSnapshot(snapshot, player);
    }

    const ctx = this.buildSnapshotContext(playerId, snapshot);

    switch (event.type) {
      case EventType.PLAYER_CONNECTED:
        this.log.info('Squeezelite player connected', ctx);
        break;
      case EventType.PLAYER_NAME_RECEIVED:
        this.log.info('Squeezelite player name', ctx);
        break;
      case EventType.PLAYER_DISCONNECTED: {
        const ageMs =
          typeof snapshot.lastHeartbeatAt === 'number' ? Math.max(0, Date.now() - snapshot.lastHeartbeatAt) : null;
        this.log.info('Squeezelite player disconnected', { ...ctx, lastHeartbeatAgeMs: ageMs });
        break;
      }
      case EventType.PLAYER_DECODER_ERROR:
        this.log.warn('Squeezelite decoder error', ctx);
        break;
      case EventType.PLAYER_OUTPUT_UNDERRUN:
        this.log.warn('Squeezelite output underrun', ctx);
        break;
      case EventType.PLAYER_DECODER_READY:
        this.log.debug('Squeezelite decoder ready', ctx);
        break;
      case EventType.PLAYER_BUFFER_READY:
        this.log.debug('Squeezelite buffer ready', ctx);
        break;
      case EventType.PLAYER_DISPLAY_RESOLUTION:
        this.log.debug('Squeezelite display resolution', { ...ctx, resolution: event.data });
        break;
      case EventType.PLAYER_UPDATED: {
        // Avoid log spam: only log meaningful changes.
        const key = [
          snapshot.state ?? '',
          snapshot.url ?? '',
          snapshot.title ?? '',
          snapshot.volume ?? '',
        ].join('|');
        if (snapshot.lastLoggedKey === key) {
          return;
        }
        snapshot.lastLoggedKey = key;
        this.log.debug('Squeezelite player updated', ctx);
        break;
      }
      case EventType.PLAYER_HEARTBEAT:
        // Update snapshot (already done), but avoid logging each heartbeat.
        break;
      default:
        break;
    }
  }

  private getOrCreateSnapshot(playerId: string): PlayerSnapshot {
    let snapshot = this.snapshots.get(playerId);
    if (!snapshot) {
      snapshot = {};
      this.snapshots.set(playerId, snapshot);
    }
    return snapshot;
  }

  private updateSnapshot(snapshot: PlayerSnapshot, player: SlimClient): void {
    snapshot.name = player.name || snapshot.name;
    snapshot.address = player.deviceAddress ?? snapshot.address;
    snapshot.port = player.devicePort ?? snapshot.port;
    snapshot.deviceType = player.deviceType || snapshot.deviceType;
    snapshot.firmware = player.firmware || snapshot.firmware;
    snapshot.supportedCodecs = player.supportedCodecs ?? snapshot.supportedCodecs;
    snapshot.maxSampleRate = player.maxSampleRate ?? snapshot.maxSampleRate;
    snapshot.state = player.state || snapshot.state;
    snapshot.jiffies = player.jiffies ?? snapshot.jiffies;
    snapshot.elapsedMs = player.elapsedMilliseconds ?? snapshot.elapsedMs;
    snapshot.volume = player.volumeLevel ?? snapshot.volume;
    snapshot.lastHeartbeatAt = player.lastHeartbeatAt ?? snapshot.lastHeartbeatAt ?? null;
    const clock = player.clockSync;
    if (clock) {
      snapshot.clockRttMs = clock.rttMs;
      snapshot.clockAgeMs = Math.max(0, Date.now() - clock.updatedAtMs);
    }

    const media = player.currentMedia;
    snapshot.url = media?.url ?? snapshot.url;
    snapshot.mimeType = media?.mimeType ?? snapshot.mimeType;
    snapshot.itemId = media?.metadata?.item_id ?? snapshot.itemId;
    snapshot.title = media?.metadata?.title ?? snapshot.title;
    snapshot.artist = media?.metadata?.artist ?? snapshot.artist;
    snapshot.album = media?.metadata?.album ?? snapshot.album;
    snapshot.duration = media?.metadata?.duration ?? snapshot.duration;
  }

  private buildSnapshotContext(playerId: string, snapshot: PlayerSnapshot): Record<string, unknown> {
    return {
      playerId,
      name: snapshot.name,
      address: snapshot.address,
      port: snapshot.port,
      deviceType: snapshot.deviceType,
      firmware: snapshot.firmware,
      supportedCodecs: snapshot.supportedCodecs,
      maxSampleRate: snapshot.maxSampleRate,
      state: snapshot.state,
      jiffies: snapshot.jiffies,
      elapsedMs: snapshot.elapsedMs,
      volume: snapshot.volume,
      clockRttMs: snapshot.clockRttMs,
      clockAgeMs: snapshot.clockAgeMs,
      url: snapshot.url,
      mimeType: snapshot.mimeType,
      itemId: snapshot.itemId,
      title: snapshot.title,
      artist: snapshot.artist,
      album: snapshot.album,
      duration: snapshot.duration,
    };
  }

  public async waitForPlayer(
    matcher: (player: SlimClient) => boolean,
    timeoutMs = 8000,
  ): Promise<SlimClient | null> {
    const existing = this.players.find(matcher);
    if (existing) return existing;

    return await new Promise((resolve) => {
      let finished = false;
      const timeout = setTimeout(() => {
        finished = true;
        unsubscribe();
        resolve(null);
      }, timeoutMs);

      const unsubscribe = this.subscribe((event) => {
        if (finished) return;
        if (event.type !== EventType.PLAYER_CONNECTED && event.type !== EventType.PLAYER_NAME_RECEIVED) {
          return;
        }
        const player = this.getPlayer(event.playerId);
        if (!player) return;
        if (!matcher(player)) return;
        finished = true;
        clearTimeout(timeout);
        unsubscribe();
        resolve(player);
      });
    });
  }
}

function normalizePort(value?: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) return null;
  return Math.trunc(parsed);
}
