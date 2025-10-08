import Backend, { BackendProbeOptions } from '../backendBaseClass';
import logger from '../../../utils/troxorlogger';
import { PlayerStatus, AudioType, RepeatMode } from '../loxoneTypes';
import axios from 'axios';

/**
 * BackendSonos class extends the Base backend class to handle Sonos-specific functionalities.
 */
export default class BackendSonos extends Backend {
  static async probe(options: BackendProbeOptions): Promise<void> {
    const url = `http://${options.ip}:1400/xml/device_description.xml`;
    try {
      await axios.get(url, { timeout: options.timeoutMs ?? 4000 });
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? error.response?.statusText || error.message
        : (error as Error).message;
      throw new Error(`Unable to reach Sonos device at ${url}: ${message}`);
    }
  }

  /**
   * Constructor for the BackendSonos class.
   *
   * @param {string} ip - The IP address of the Sonos speaker.
   * @param {string} playerid - The ID of the player.
   */
  constructor(ip: string, playerid: number) {
    super(ip, playerid);
  }

  /**
   * Initializes the connection to the Sonos speaker.
   *
   * @returns {Promise<void>} - A promise that resolves when the connection is initialized.
   */
  async initialize(): Promise<void> {
    try {
      // Log connection initialization
      logger.info(`[SonosBackend] Initializing connection to Sonos speaker at ${this.ip}, Player ID: ${this.playerid}`);

      // Call the common method from the base class for logging
      this.logConnection();

      // Set up a dummy player entry for testing purposes
      const dummyEntry: Partial<PlayerStatus> = {
        playerid: this.playerid,
        title: 'Dummy Track',
        artist: 'Unknown Artist',
        album: 'Test Album',
        coverurl: 'https://dummycover.url/cover.jpg',
        audiotype: AudioType.Playlist,
        audiopath: '/dummy/path',
        mode: 'pause',
        plrepeat: RepeatMode.NoRepeat,
        plshuffle: false,
        duration: 300, // 5 minutes duration
        time: 0, // Start from the beginning
        power: 'on',
        volume: 50,
        qindex: 0,
      };

      // Update the zone with the dummy status
      this.pushPlayerStatusUpdate(dummyEntry);
      logger.info(`[SonosBackend] Dummy status set for player ${this.playerid}`);
    } catch (error) {
      logger.error(`[SonosBackend] Error initializing Backend: ${error}`);
      throw error; // Re-throw the error after logging
    }
  }

  /**
   * Sends a command to the Sonos speaker.
   *
   * @param {string} command - The command to be sent to the Sonos speaker.
   * @returns {Promise<void>} - A promise that resolves when the command has been sent.
   */
  async sendCommand(command: string): Promise<void> {
    try {
      logger.info(`[SonosBackend][zone ${this.playerid}] Sending command: [${command}] to Sonos speaker at ${this.ip}`);
      // Replace with actual logic to send the command to the Sonos speaker

      // For example: Send HTTP request or WebSocket command to the Sonos API
    } catch (error) {
      logger.error(`[SonosBackend] Error sending command [${command}] to Sonos for player ${this.playerid}: ${error}`);
      throw error; // Re-throw for error handling
    }
  }
}
