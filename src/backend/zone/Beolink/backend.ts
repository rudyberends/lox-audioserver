import Backend, { BackendProbeOptions } from '../backendBaseClass';
import logger from '../../../utils/troxorlogger';
import { config } from '../../../config/config';
import axios, { AxiosRequestConfig } from 'axios';
import { updateZoneGroup, sendCommandToZone, getZoneById } from '../zonemanager';
import { PlayerStatus } from '../loxoneTypes';
import BeolinkNotifyClient from './notifyClient';
import { NotificationMessage, PrimaryExperience } from './types';
import { mapNotificationToTrack } from './stateMapper';
import { handleBeolinkCommand } from './commands';
import { upsertGroup, getGroupByLeader, removeGroupByLeader, getGroupByZone, removeZoneFromGroups } from '../groupTracker';

/**
 * BackendBeolink class extends the Base backend class to handle Beolink notifications.
 */
export default class BackendBeolink extends Backend {
  private static deviceToZone = new Map<string, number>();
  private static zoneToDevices = new Map<number, Set<string>>();
  private static instances = new Map<number, BackendBeolink>();

  private static normaliseDeviceId(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed.toLowerCase();
  }

  private static registerDevice(deviceId: string, zoneId: number): void {
    const normalized = BackendBeolink.normaliseDeviceId(deviceId);
    if (!normalized) return;
    BackendBeolink.deviceToZone.set(normalized, zoneId);

    let entries = BackendBeolink.zoneToDevices.get(zoneId);
    if (!entries) {
      entries = new Set<string>();
      BackendBeolink.zoneToDevices.set(zoneId, entries);
    }
    entries.add(normalized);
  }

  private static unregisterZone(zoneId: number): void {
    const devices = BackendBeolink.zoneToDevices.get(zoneId);
    if (!devices) return;
    devices.forEach((deviceId) => BackendBeolink.deviceToZone.delete(deviceId));
    BackendBeolink.zoneToDevices.delete(zoneId);
    BackendBeolink.instances.delete(zoneId);
  }

  private static getZoneIdForDevice(deviceId: unknown): number | undefined {
    const normalized = BackendBeolink.normaliseDeviceId(deviceId);
    if (!normalized) return undefined;
    return BackendBeolink.deviceToZone.get(normalized);
  }

  private static async ensureDeviceMappings(): Promise<void> {
    const tasks: Array<Promise<void>> = [];
    BackendBeolink.instances.forEach((instance) => {
      tasks.push(instance.refreshDeviceIdentity());
    });
    if (tasks.length === 0) return;
    await Promise.allSettled(tasks);
  }

  private notifyUrl: string; // URL for the BeoNotify notifications
  private notifyClient: BeolinkNotifyClient;
  private deviceJid?: string;
  private normalizedDeviceJid?: string;

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
    BackendBeolink.instances.set(playerid, this);
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
    await this.refreshDeviceIdentity();
    await this.refreshGroupFromDevice();

    try {
      await this.notifyClient.subscribe(this.handleNotification);
    } catch (error) {
      logger.error(`[BeolinkBackend] Error initializing Beolink: ${error}`);
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    BackendBeolink.unregisterZone(this.playerid);
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
  async sendGroupCommand(command: string, type: string, playerid: number, ...additionalIDs: string[]): Promise<void> {
    if (command === 'groupJoinMany' || command === 'groupJoin') {
      await this.joinExperience(type, additionalIDs);
    } else if (command === 'groupLeaveMany' || command === 'groupLeave') {
      await this.leaveExperience(type, additionalIDs);
    } else {
      logger.warn(`[BeoLink][Zone ${this.playerid}] Unsupported group command: ${command}`);
    }
  }

  private async joinExperience(_type: string, members: string[]): Promise<void> {
    const existingGroup = getGroupByLeader(this.playerid);
    const currentMembers = new Set(existingGroup?.members ?? []);
    let trackerChanged = false;

    for (const id of members) {
      const memberId = Number(id);
      if (!Number.isFinite(memberId) || memberId <= 0 || memberId === this.playerid) continue;
      try {
        await sendCommandToZone(memberId, 'groupJoin');
        currentMembers.add(memberId);
        trackerChanged = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[BeoLink][Zone ${this.playerid}] Failed to join member ${memberId}: ${message}`);
      }
    }

    if (trackerChanged) {
      const { changed } = upsertGroup({
        leader: this.playerid,
        members: Array.from(currentMembers),
        backend: 'Beolink',
        externalId: existingGroup?.externalId ?? `group-${this.playerid}`,
        source: existingGroup?.source ?? 'manual',
      });
      if (changed) updateZoneGroup();
    }
  }

  private async leaveExperience(_type: string, members: string[]): Promise<void> {
    const existingGroup = getGroupByLeader(this.playerid);
    if (!existingGroup) return;

    const candidateMembers = Array.from(
      new Set(
        members
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id) && id > 0 && id !== this.playerid),
      ),
    );
    if (candidateMembers.length === 0) return;

    const successfulRemovals: number[] = [];

    for (const memberId of candidateMembers) {
      const zone = getZoneById(memberId);
      const targetIp = zone?.player?.ip;
      if (!zone || !targetIp) {
        logger.warn(`[BeoLink][Zone ${this.playerid}] Skipping leave for member ${memberId}: zone or IP not found`);
        continue;
      }

      try {
        await axios.delete(`http://${targetIp}:8080/BeoZone/Zone/ActiveSources/primaryExperience`);
        successfulRemovals.push(memberId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[BeoLink][Zone ${this.playerid}] Failed to remove member ${memberId}: ${message}`);
      }
    }

    if (successfulRemovals.length > 0) {
      const remainingMembers = existingGroup.members
        .filter((memberId) => memberId !== this.playerid)
        .filter((memberId) => !successfulRemovals.includes(memberId));

      if (remainingMembers.length > 0) {
        const { changed } = upsertGroup({
          leader: this.playerid,
          members: remainingMembers,
          backend: existingGroup.backend,
          externalId: existingGroup.externalId,
          source: existingGroup.source,
        });
        if (changed) updateZoneGroup();
      } else {
        if (removeGroupByLeader(this.playerid)) updateZoneGroup();
      }
    }
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
      {
        audioServerIp: config.audioserver?.ip,
        onPrimaryExperienceChange: (experience: PrimaryExperience | null | undefined) => {
          void this.applyPrimaryExperience(experience ?? undefined).catch((error) =>
            logger.warn(`[BeoLink][Zone ${this.playerid}] Failed to apply experience change: ${error}`),
          );
        },
      },
    );

    // Log the trackInfo for debugging purposes
    if (trackInfo.audiotype !== undefined) {
      logger.debug(`[BeoNotify][Zone:${this.playerid}] Track information: ${JSON.stringify(trackInfo)}`);
    }

    // Update the zone track information using ZoneManager
    this.pushPlayerStatusUpdate(trackInfo as Partial<PlayerStatus>);
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
        doAction: (action, param) => this.doAction(action, param),
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
      const currentVolume = Number(zone.playerEntry.volume); // Convert to number
      const volumeChange = Number(change); // Ensure change is also a number

      // Calculate the new volume within the supported range (0-100)
      const newVolume = Math.max(0, Math.min(100, currentVolume + volumeChange));

      // Update the zone with the new volume
      const updatedTrackInfo: Partial<PlayerStatus> = {
        volume: newVolume, // This should now be a number
      };
      this.pushPlayerStatusUpdate(updatedTrackInfo);

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
  private async doAction(action: string, type?: any): Promise<void> {
    const typeQuery =
      typeof type === 'string' && type.trim().length > 0
        ? `?type=${encodeURIComponent(type)}`
        : '';
    const url = `http://${this.ip}:8080/BeoZone/Zone/${action}${typeQuery}`;

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

  private async refreshDeviceIdentity(): Promise<void> {
    const url = `http://${this.ip}:8080/BeoDevice`;
    try {
      const response = await axios.get(url);
      const candidate = this.extractDeviceJid(response.data, response.headers);
      const normalized = BackendBeolink.normaliseDeviceId(candidate);
      if (!candidate || !normalized) {
        logger.debug(`[BeoLink][Zone ${this.playerid}] Device identity missing in ${url} response.`);
        return;
      }

      if (this.normalizedDeviceJid && this.normalizedDeviceJid !== normalized) {
        BackendBeolink.unregisterZone(this.playerid);
      }

      this.deviceJid = candidate;
      this.normalizedDeviceJid = normalized;
      BackendBeolink.registerDevice(candidate, this.playerid);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[BeoLink][Zone ${this.playerid}] Failed to fetch device identity from ${url}: ${message}`);
    }
  }

  private extractDeviceJid(payload: any, headers?: Record<string, unknown>): string | undefined {
    if (headers) {
      const headerCandidate = headers['device-jid'] ?? headers['Device-Jid'];
      if (typeof headerCandidate === 'string' && headerCandidate.trim()) {
        return headerCandidate.trim();
      }
    }

    if (!payload || typeof payload !== 'object') return undefined;
    const candidates = [
      payload?.beoDevice?.productId?.jid,
      payload?.beoDevice?.productId?.anonymousProductId,
      payload?.beoDevice?.deviceJid,
      payload?.device?.jid,
      payload?.device?.id,
      payload?.deviceJid,
      payload?.product?.jid,
      payload?.body?.product?.jid,
      payload?.body?.device?.jid,
      payload?.jid,
      payload?.id,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }

    const productType = payload?.beoDevice?.productId?.productType;
    const itemNumber = payload?.beoDevice?.productId?.itemNumber;
    const serialNumber = payload?.beoDevice?.productId?.serialNumber;

    if (productType && itemNumber && serialNumber) {
      return `${String(productType).trim()}.${String(itemNumber).trim()}.${String(serialNumber).trim()}@products.bang-olufsen.com`;
    }

    return undefined;
  }

  private async refreshGroupFromDevice(): Promise<void> {
    const url = `http://${this.ip}:8080/BeoZone/Zone/ActiveSources`;
    try {
      const response = await axios.get(url);
      const payload = response.data ?? {};
      const primary =
        payload?.primaryExperience ??
        payload?.primary_experience ??
        payload?.primaryexperience ??
        payload?.PrimaryExperience;
      if (primary) {
        await this.applyPrimaryExperience(primary as PrimaryExperience).catch((error) =>
          logger.debug(`[BeoLink][Zone ${this.playerid}] Failed to apply active sources snapshot: ${error}`),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.debug(`[BeoLink][Zone ${this.playerid}] Failed to refresh primary experience: ${message}`);
    }
  }

  private async applyPrimaryExperience(experience?: PrimaryExperience | null, attempt = 0): Promise<void> {
    if (!experience) return;

    const existingMembership = getGroupByZone(this.playerid);

    const extractDeviceIds = (entries: unknown): string[] => {
      if (!entries) return [];
      const array = Array.isArray(entries) ? entries : [entries];
      return array
        .map((entry) => {
          if (typeof entry === 'string') return entry;
          if (entry && typeof entry === 'object' && typeof (entry as { jid?: string }).jid === 'string') {
            return (entry as { jid?: string }).jid;
          }
          return undefined;
        })
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
    };

    const listenerDeviceIds = extractDeviceIds(experience.listener)
      .map((id) => BackendBeolink.normaliseDeviceId(id))
      .filter((id): id is string => Boolean(id));

    const normalizedLeaderCandidate =
      BackendBeolink.normaliseDeviceId(
        experience?.source?.product?.jid ??
          (Array.isArray(experience.listener) ? experience.listener[0] : undefined) ??
          this.deviceJid,
      ) ?? this.normalizedDeviceJid;

    const unresolved = new Set<string>();
    if (normalizedLeaderCandidate && BackendBeolink.getZoneIdForDevice(normalizedLeaderCandidate) === undefined) {
      unresolved.add(normalizedLeaderCandidate);
    }
    listenerDeviceIds.forEach((deviceId) => {
      if (BackendBeolink.getZoneIdForDevice(deviceId) === undefined) {
        unresolved.add(deviceId);
      }
    });

    if (unresolved.size > 0 && attempt === 0) {
      await BackendBeolink.ensureDeviceMappings();
      return this.applyPrimaryExperience(experience, attempt + 1);
    }

    if (unresolved.size > 0) {
      logger.debug(
        `[BeoLink][Zone ${this.playerid}] Unable to resolve device mapping for ${Array.from(unresolved).join(', ')}`,
      );
    }

    const leaderZoneIdCandidate = normalizedLeaderCandidate ?? listenerDeviceIds[0];
    const resolvedLeaderZoneId = leaderZoneIdCandidate
      ? BackendBeolink.getZoneIdForDevice(leaderZoneIdCandidate)
      : undefined;
    const leaderZoneId = resolvedLeaderZoneId ?? this.playerid;
    const isLeader = leaderZoneId === this.playerid;

    if (listenerDeviceIds.length === 0) {
      if (!existingMembership) return;
      if (!isLeader) {
        logger.debug(
          `[BeoLink][Zone ${this.playerid}] Ignoring empty listener list for non-leader zone (leader ${leaderZoneId}).`,
        );
        return;
      }

      const removed = existingMembership.leader === this.playerid
        ? removeGroupByLeader(existingMembership.leader)
        : removeZoneFromGroups(this.playerid);

      if (removed) updateZoneGroup();
      return;
    }

    const normalizedLeader = normalizedLeaderCandidate ?? listenerDeviceIds[0];

    const memberZoneIds = new Set<number>();
    listenerDeviceIds.forEach((deviceId) => {
      const zoneId = BackendBeolink.getZoneIdForDevice(deviceId);
      if (zoneId !== undefined) {
        memberZoneIds.add(zoneId);
      }
    });

    memberZoneIds.add(leaderZoneId);
    memberZoneIds.add(this.playerid);

    if (!isLeader) {
      listenerDeviceIds.forEach((deviceId) => {
        const zoneId = BackendBeolink.getZoneIdForDevice(deviceId);
        if (zoneId !== undefined) BackendBeolink.registerDevice(deviceId, zoneId);
      });
      if (normalizedLeader) {
        BackendBeolink.registerDevice(normalizedLeader, leaderZoneId);
      }
      return;
    }

    const hasMultipleListeners = listenerDeviceIds.length > 1;
    if (memberZoneIds.size <= 1) {
      if (hasMultipleListeners) {
        logger.debug(
          `[BeoLink][Zone ${this.playerid}] Experience has listeners we cannot map yet: ${listenerDeviceIds.join(', ')}`,
        );
        return;
      }
      if (removeGroupByLeader(leaderZoneId)) {
        updateZoneGroup();
      }
      return;
    }

    const members = Array.from(memberZoneIds);
    const externalIdRaw = typeof experience?.source?.id === 'string' ? experience.source.id.trim() : '';
    const existingGroup = getGroupByLeader(leaderZoneId);
    const resolvedExternalId =
      externalIdRaw || existingGroup?.externalId || `beolink-${leaderZoneId}`;

    // keep device-zone registry in sync for this experience
    listenerDeviceIds.forEach((deviceId) => {
      const zoneId = BackendBeolink.getZoneIdForDevice(deviceId);
      if (zoneId !== undefined) BackendBeolink.registerDevice(deviceId, zoneId);
    });
    if (normalizedLeader) {
      BackendBeolink.registerDevice(normalizedLeader, leaderZoneId);
    }

    const { changed } = upsertGroup({
      leader: leaderZoneId,
      members,
      backend: 'Beolink',
      externalId: resolvedExternalId,
      source: 'backend',
    });
    if (changed) {
      updateZoneGroup();
    }
  }
}
