import Backend, { BackendProbeOptions } from '../backendBaseClass'; // Base backend class
import logger from '../../../utils/troxorlogger'; // Custom logger
import { config } from '../../../config/config';
import axios, { AxiosRequestConfig } from 'axios'; // Import Axios
import { Track, updateZoneGroup } from '../zonemanager';
import BeolinkNotifyClient from './notifyClient';
import { NotificationMessage } from './types';
import { mapNotificationToTrack } from './stateMapper';
import { handleBeolinkCommand } from './commands';

/**
 * BackendBeolink class extends the Base backend class to handle Beolink notifications.
 */
export default class BackendBeolink extends Backend {
  private notifyUrl: string; // URL for the BeoNotify notifications
  private notifyClient: BeolinkNotifyClient;

  /**
   * Constructor for the BackendBeolink class.
   *
   * @param {string} ip - The IP address of the device.
   * @param {string} playerid - The ID of the player.
   */
  constructor(ip: string, playerid: number) {
    super(ip, playerid);
    this.notifyUrl = `http://${this.ip}:8080/BeoNotify/Notifications`; // Notification URL based on IP
    this.notifyClient = new BeolinkNotifyClient(this.notifyUrl);
  }

  static async probe(options: BackendProbeOptions): Promise<void> {
    const url = `http://${options.ip}:8080/BeoNotify/Notifications`;
    try {
      const response = await axios.get(url, {
        responseType: 'stream',
        timeout: options.timeoutMs ?? 4000,
      });
      response.data.destroy();
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? error.response?.statusText || error.message
        : (error as Error).message;
      throw new Error(`Unable to reach Beolink notifications at ${url}: ${message}`);
    }
  }

  /**
   * Initializes the notification listener and sets an interval to reset it every 3 minutes.
   *
   * @returns {Promise<void>} - A promise that resolves when the initialization is complete.
   */
  async initialize(): Promise<void> {
    try {
      await this.notifyClient.subscribe(this.handleNotification);
    } catch (error) {
      logger.error(`[BeolinkBackend] Error initializing Beolink: ${error}`);
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    await this.notifyClient.close();
    await super.cleanup();
  }

  /**
   * Sends a group command to join additional player IDs in a Beolink group.
   *
   * @param {string} command - The command to execute for the group action.
   * @param {string} type - The type of the command, e.g., 'Audio'.
   * @param {string} playerid - The ID of the master player (the group creator).
   * @param {...string[]} additionalIDs - The IDs of the additional players to be added to the group.
   * 
   * This method logs the creation of a new Beolink group and attempts to add each
   * additional player ID to the group, skipping the master ID.
   * 
   */
  sendGroupCommand(command: string, type: string, playerid: number, ...additionalIDs: string[]): void {
    // Custom implementation for sending a group command
    logger.info(`[BeoLink] Creating New Beolink Group. Master: ${this.playerid} | GroupMembers: ${additionalIDs.join(', ')}`);

    // Loop over additional IDs and perform an action for each, ignoring the master ID
    additionalIDs.forEach((id) => {
      if (id !== String(this.playerid)) { // Check if the ID is not the master ID
        logger.info(`[BeoLink] Adding member to group: ${id}`);
        //sendCommandToZone(Number(id), 'groupJoin', this.playerid); // Send command to join the group
      } else {
        logger.info(`[BeoLink] Skipping master ID: ${id}`); // Log that the master ID is being skipped
      }
    });
    updateZoneGroup();
  }


  /**
   * Handles incoming notifications and updates the zone track information accordingly.
   *
   * @param {NotificationMessage} msg - The notification message received from the Beolink API.
   * @returns {Promise<void>} - A promise that resolves when the notification is handled.
   */
  private handleNotification = async (msg: NotificationMessage): Promise<void> => {
    logger.debug(`[BeoNotify][Zone:${this.playerid}] Received notification: ${msg.notification.type}`);

    // Create trackInfo based on the notification type
    const trackInfo = mapNotificationToTrack(
      msg.notification.type,
      msg.notification.data,
      config.audioserver?.ip,
    );

    // Log the trackInfo for debugging purposes
    if (trackInfo.audiotype !== undefined) {
      logger.debug(`[BeoNotify][Zone:${this.playerid}] Track information: ${JSON.stringify(trackInfo)}`);
    }

    // Update the zone track information using ZoneManager
    this.pushTrackUpdate(trackInfo);
  };

  /**
   * Sends a command to the Beolink Device based on the provided command string.
   *
   * @param {string} command - The command to send (e.g., "play", "pause").
   * @returns {Promise<void>} - A promise that resolves when the command has been sent.
   */
  async sendCommand(command: string, param: any): Promise<void> {
    logger.info(`[BeoLink][zone ${this.playerid}][${command}] Sending command`);
    const handled = await handleBeolinkCommand(
      {
        adjustVolume: (change) => this.adjustVolume(change),
        doAction: (action) => this.doAction(action),
      },
      command,
      param,
    );

    if (!handled) {
      logger.warn(`[BeoLink][zone ${this.playerid}] Unknown command: ${command}`);
    }
  }

  /**
   * Adjusts the current volume by a specified amount (+3 or -3).
   *
   * @param {number} change - The amount to change the volume by (+3 or -3).
   * @returns {Promise<void>} - A promise that resolves when the volume adjustment is complete.
   */
  private async adjustVolume(change: number): Promise<void> {
    try {
      const zone = this.getZoneOrWarn();
      if (!zone) {
        logger.warn(`[BeoLink][Zone ${this.playerid}] Volume change ignored: zone not found`);
        return;
      }

      // Ensure currentVolume is a number
      const currentVolume = Number(zone.track.volume); // Convert to number
      const volumeChange = Number(change); // Ensure change is also a number

      // Calculate the new volume
      const newVolume = currentVolume + volumeChange; // Numeric addition

      // Update the zone with the new volume
      const updatedTrackInfo: Partial<Track> = {
        volume: newVolume, // This should now be a number
      };
      this.pushTrackUpdate(updatedTrackInfo);

      logger.debug(`[BeoLink][Zone ${this.playerid}] Volume changed by ${volumeChange}, new volume: ${newVolume}`);

      // Set the volume on the backend using an HTTP PUT request
      const url = `http://${this.ip}:8080/BeoZone/Zone/Sound/Volume/Speaker/Level`;

      try {
        // Send the new volume to the backend
        const response = await axios.put(url, { level: newVolume });
        logger.info(`[BeoRemote][Zone ${this.playerid}] Volume set to ${newVolume} on the backend`);
        return response.data; // Return the response data if needed
      } catch (error) {
        logger.error(`[BeoRemote][Zone ${this.playerid}] Error setting volume on the backend: ${error}`);
      }
    } catch (error) {
      logger.error(`[BeoLink][Zone ${this.playerid}] Error adjusting volume: ${error}`);
    }
  }

  /**
   * Sends a specific action to the Beolink backend via HTTP.
   *
   * @param {string} action - The action to send to the Beolink backend.
   * @returns {Promise<void>} - A promise that resolves when the action is sent.
   */
  private async doAction(action: string): Promise<void> {
    const url = `http://${this.ip}:8080/BeoZone/Zone/${action}`;

    // Define the request options
    const options: AxiosRequestConfig = {
      method: 'POST',
      responseType: 'text', // or 'json' depending on your expected response
    };

    try {
      // Send the request with Axios
      const response = await axios.post(url, {}, options);
      logger.info(`[BeoRemote][zoneId ${this.playerid}] Response: ${response.data}`);
    } catch (error) {
      const errorMsg = axios.isAxiosError(error) ? error.response?.data : error;
      logger.error(`[BeoRemote][zoneId ${this.playerid}] Error on HTTP request: ${errorMsg}`);
    }
  }
}
