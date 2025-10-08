import logger from '../../utils/troxorlogger';
import { getZoneById, updateZonePlayerStatus } from './zonemanager';
import { PlayerStatus } from './loxoneTypes';

export interface BackendProbeOptions {
  ip: string;
  playerId: number;
  maPlayerId?: string;
  port?: number;
  timeoutMs?: number;
}

/**
 * Abstract base class representing a backend connection.
 * Subclasses must implement the initialize method.
 */
export default abstract class Backend {
  protected ip: string; // The IP address of the backend device
  protected playerid: number; // The identifier for the player

  /**
   * Constructor for the Backend class.
   *
   * @param {string} ip - The IP address of the device.
   * @param {string} playerid - The ID of the player.
   */
  constructor(ip: string, playerid: number) {
    this.ip = ip; // Set the IP address
    this.playerid = playerid; // Set the player ID
  }

  static async probe(_options: BackendProbeOptions): Promise<void> {
    // Default implementation: assume configuration is acceptable.
  }

  /**
   * Abstract method to initialize the backend connection.
   *
   * Subclasses must implement this method to establish their own backend connection.
   *
   * @returns {Promise<void>} - A promise that resolves when the initialization is complete.
   */
  abstract initialize(): Promise<void>;

  /**
   * Abstract method to send commands to the backend connection.
   *
   * Subclasses must implement this method to establish their own backend connection.
   *
   * @returns {Promise<void>} - A promise that resolves when the initialization is complete.
  */
  abstract sendCommand(command: string, param: any): Promise<void>;

  /**
   * Logs a connection message to the logger.
   *
   * This method can be used by subclasses to log when they have successfully connected to the backend.
   */
  logConnection(): void {
    logger.info(`[Backend] Connected to backend at ${this.playerid}`);
  }

  sendGroupCommand(command: any, type: any, playerid: any, ...additionalIDs: any[]): void {
    logger.error(`[Backend] Not Implemented`);
  }

  /**
   * Hook for cleaning up timers, sockets, etc. Implement in subclasses when needed.
   */
  async cleanup(): Promise<void> {
    // Default: nothing to clean up
  }

  /**
   * Retrieve the zone for this backend, logging a warning if it doesn't exist.
   */
  protected getZoneOrWarn() {
    const zone = getZoneById(this.playerid);
    if (!zone) {
      const backendName = this.constructor?.name || 'Backend';
      logger.warn(`[${backendName}] Zone ${this.playerid} not found`);
    }
    return zone;
  }

  protected pushPlayerStatusUpdate(update: Partial<PlayerStatus>): void {
    if (!update || Object.keys(update).length === 0) return;
    const zone = this.getZoneOrWarn();
    if (!zone) return;
    updateZonePlayerStatus(this.playerid, update);
  }
}
