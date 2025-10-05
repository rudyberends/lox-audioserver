import Backend from './backendBaseClass';
import logger from '../../utils/troxorlogger';
import { Track } from './zonemanager';

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
      this.startUpdatingTrack();
    } catch (error) {
      logger.error(`[DummyBackend] Error initializing backend: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
  }

  private startUpdatingTrack(): void {
    const pushUpdate = (): void => {
      const dummyTrack: Track = {
        playerid: this.playerid,
        title: `Please configure Zone ${this.playerid}`,
        artist: `Zone ID ${this.playerid}`,
        album: 'DummyBackend',
        coverurl: '',
        audiotype: 2,
        audiopath: '/dummy/path',
        mode: 'pause',
        plrepeat: 0,
        plshuffle: 0,
        duration: 300,
        time: 0,
        power: 'on',
        volume: 10,
        station: '',
        players: [],
      };

      this.pushTrackUpdate(dummyTrack);
      logger.debug(`[DummyBackend] Dummy track update pushed for player ${this.playerid}`);
    };

    pushUpdate();

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }

    this.updateInterval = setInterval(pushUpdate, 60_000);
    logger.info(`[DummyBackend] Dummy track set for player ${this.playerid}`);
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
