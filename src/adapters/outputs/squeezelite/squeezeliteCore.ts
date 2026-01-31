import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import { SlimServer, EventType, type SlimEvent, type SlimClient } from '@lox-audioserver/node-slimproto';

export class SqueezeliteCore {
  private readonly log = createLogger('Output', 'SqueezeliteCore');
  private server: SlimServer | null = null;
  private started = false;
  private loggingBound = false;

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
    this.server.subscribe(
      (event) => {
        const player = this.server?.getPlayer(event.playerId);
        const address = player?.deviceAddress;
        const name = player?.name;
        if (event.type === EventType.PLAYER_CONNECTED) {
          this.log.info('Squeezelite player connected', { playerId: event.playerId, name, address });
        } else if (event.type === EventType.PLAYER_NAME_RECEIVED) {
          this.log.info('Squeezelite player name', { playerId: event.playerId, name, address });
        } else if (event.type === EventType.PLAYER_DISCONNECTED) {
          this.log.info('Squeezelite player disconnected', { playerId: event.playerId, name, address });
        }
      },
      [EventType.PLAYER_CONNECTED, EventType.PLAYER_NAME_RECEIVED, EventType.PLAYER_DISCONNECTED],
    );
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
