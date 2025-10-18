import Backend from './backendBaseClass';
import logger from '../../utils/troxorlogger';
import { PlayerStatus, AudioType, RepeatMode, FileType } from './loxoneTypes';
import type { ZoneCapabilityDescriptor, ZoneCapabilityContext } from './capabilityTypes';
import { backendNoneCapabilities } from './capabilityHelper';

/**
 * NullBackend – fallback backend used when a zone has no concrete integration.
 * Provides predictable, no-op behaviour while keeping the abstract base class lean.
 */
export default class NullBackend extends Backend {
  private updateInterval: NodeJS.Timeout | null = null;

  constructor(_ip: string, playerId: number) {
    super('', playerId);
  }

  static async probe(): Promise<void> {
    // Always considered valid.
  }

  async initialize(): Promise<void> {
    try {
      logger.info(`[NullBackend] Initializing Player ID: ${this.playerid}`);
      this.logConnection();
      this.pushInitialPlayerEntry();
      this.startHeartbeat();
    } catch (error) {
      logger.error(
        `[NullBackend] Error during initialization: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  async sendCommand(command: string, param?: unknown): Promise<void> {
    try {
      const payload =
        param === undefined || param === null ? '' : typeof param === 'string' ? param : JSON.stringify(param);
      logger.info(
        `[NullBackend][zone ${this.playerid}] Ignoring command "${command}"${payload ? ` payload=${payload}` : ''}`,
      );
    } catch (error) {
      logger.error(
        `[NullBackend] Error logging command "${command}" for player ${this.playerid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async cleanup(): Promise<void> {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    await super.cleanup();
  }

  describeCapabilities(_context: ZoneCapabilityContext = {}): ZoneCapabilityDescriptor[] {
    return backendNoneCapabilities({
      control: { status: 'none', detail: 'Unconfigured' },
    });
  }

  private pushInitialPlayerEntry(): void {
    const status: PlayerStatus = {
      playerid: this.playerid,
      title: `Unconfigured`,
      artist: `Zone ${this.playerid}`,
      album: 'NullBackend',
      coverurl: '',
      audiotype: AudioType.Playlist,
      audiopath: '/null/path',
      mode: 'pause',
      plrepeat: RepeatMode.NoRepeat,
      plshuffle: false,
      duration: 300,
      time: 0,
      power: 'on',
      volume: 10,
      station: '',
      players: [],
      qindex: 0,
      duration_ms: 300_000,
      name: `Zone ${this.playerid}`,
      type: FileType.Unknown,
    };

    this.pushPlayerStatusUpdate(status);
  }

  private startHeartbeat(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    this.updateInterval = setInterval(() => {
      this.pushPlayerStatusUpdate({
        playerid: this.playerid,
        time: 0,
        mode: 'pause',
      });
    }, 60_000);
    logger.debug(`[NullBackend] Heartbeat started for player ${this.playerid}`);
  }
}
