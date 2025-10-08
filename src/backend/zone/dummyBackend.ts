import Backend from './backendBaseClass';
import logger from '../../utils/troxorlogger';
import { PlayerStatus, AudioType, RepeatMode, FileType } from './loxoneTypes';

/**
 * DummyBackend – minimal backend implementation for fallback for unconfigered zones.
 */
export default class DummyBackend extends Backend {
  private updateInterval: NodeJS.Timeout | null = null;

  constructor(ip: string, playerId: number) {
    super(ip, playerId);
  }

  static async probe(): Promise<void> {
    // Dummy backend is always considered valid.
  }

  async initialize(): Promise<void> {
    try {
      logger.info(`[DummyBackend] Initializing connection to device at ${this.ip}, Player ID: ${this.playerid}`);
      this.logConnection();
      this.startUpdatingPlayerEntry();
    } catch (error) {
      logger.error(`[DummyBackend] Error initializing backend: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
  }

  private startUpdatingPlayerEntry(): void {
    const pushUpdate = (): void => {
      const dummyEntry: PlayerStatus = {
        playerid: this.playerid,
        title: `Unconfigured`,
        artist: `ID ${this.playerid}`,
        album: 'DummyBackend',
        coverurl: '',
        audiotype: AudioType.Playlist,
        audiopath: '/dummy/path',
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

      this.pushPlayerStatusUpdate(dummyEntry);
      logger.debug(`[DummyBackend] Dummy player entry update pushed for player ${this.playerid}`);
    };

    pushUpdate();

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }

    this.updateInterval = setInterval(pushUpdate, 60_000);
    logger.info(`[DummyBackend] Dummy status set for player ${this.playerid}`);
  }

  async sendCommand(command: string): Promise<void> {
    try {
      logger.info(`[DummyBackend][zone ${this.playerid}] Received command: [${command}] (no-op)`);
    } catch (error) {
      logger.error(`[DummyBackend] Error receiving command [${command}] for player ${this.playerid}: ${error}`);
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    await super.cleanup();
  }
}
