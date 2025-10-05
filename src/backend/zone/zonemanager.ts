import logger from '../../utils/troxorlogger'; // Importing the custom logger for logging messages
import { config, getAdminConfig, updateAdminConfig } from '../../config/config'; // Import config from the configuration module
import { broadcastEvent } from '../../http/broadcastEvent';
import { createBackend } from './backendFactory';
import type { ZoneConfigEntry, AdminConfig } from '../../config/configStore';

// Define the structure for Player
interface Player {
  uuid: string; // Unique identifier for the player
  playerid: number; // ID of the player
  backend: string; // Backend service associated with the player
  ip: string; // IP address of the player
}

// Define the structure for Track
interface Track {
  playerid: number; // ID of the player associated with the track
  coverurl: string; // URL for the track cover image
  station: string; // Station name for radio tracks
  audiotype: number; // Type of audio
  audiopath: string; // Path to the audio file
  mode: string; // Playback mode (e.g., stop, play, pause)
  plrepeat: number; // Repeat mode for playback
  plshuffle: number; // Shuffle mode for playback
  duration: number; // Duration of the track in seconds
  time: number; // Current playback time
  power: string; // Power state of the player (e.g., on, off)
  volume: number; // Volume level of the player
  title?: string;
  album?: string;
  artist?: string;
  players: { playerid: number }[]; // Array of players associated with the track
  clientState?: string;          // bv. "on"
  type?: number;                 // bv. 3 = track
  qid?: string;                  // huidig queue item id
  qindex?: number;               // huidige positie in queue
  sourceName?: string;           // bv. "Music Assistant"
  name?: string;                 // bron/zone naam
}

// Define the structure for Zone
interface Zone {
  [playerId: number]: {
    player: {
      uuid: string; // Unique identifier for the player
      playerid: number; // ID of the player
      clienttype: number; // Type of client (e.g., 0 for default)
      enabled: boolean; // Indicates if the player is enabled
      internalname: string; // Internal name for the zone
      max_volume: number; // Maximum volume level for the zone
      name: string; // Name of the zone
      upnpmode: number; // UPnP mode setting
      upnprelay: number; // UPnP relay setting
      backend: string; // Backend service associated with the zone
      ip: string; // IP address of the zone
      backendInstance?: any; // Store the backend instance here
    };
    track: Track; // Track information associated with the zone
    queue?: {
      id: number;
      items: any[];
      shuffle: boolean;
      start: number;
      totalitems: number;
    };
  };
}

// Initialize an in-memory database for zones
const zone: Zone = {};
type ZoneEntry = Zone[number];

interface ZoneStatus {
  id: number;
  backend: string;
  ip: string;
  name: string;
  connected: boolean;
  state?: string;
  title?: string;
  artist?: string;
  coverUrl?: string;
}

interface PreparedZoneContext {
  players: Player[];
  adminConfig: AdminConfig;
  adminZones: Map<number, ZoneConfigEntry>;
}

function normaliseMusicConfig(rawMusicConfig: unknown): Record<string, any>[] {
  if (!rawMusicConfig) return [];

  if (Array.isArray(rawMusicConfig)) {
    return rawMusicConfig as Record<string, any>[];
  }

  if (typeof rawMusicConfig === 'string') {
    const trimmed = rawMusicConfig.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      return normaliseMusicConfig(parsed);
    } catch (error) {
      logger.error(`[ZoneManager] Failed to parse music configuration string: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  if (typeof rawMusicConfig === 'object') {
    const values = Object.values(rawMusicConfig as Record<string, any>);
    return values.length ? values : [rawMusicConfig as Record<string, any>];
  }

  return [];
}

function extractPlayers(musicConfig: Record<string, any>, macId?: string): Player[] {
  if (!musicConfig || typeof musicConfig !== 'object') return [];

  const serverSection = macId && musicConfig[macId] ? musicConfig[macId] : musicConfig;
  if (!serverSection || typeof serverSection !== 'object') return [];

  const candidates = [serverSection.players, serverSection.Players, serverSection.player, serverSection.zones];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (Array.isArray(candidate)) {
      return candidate as Player[];
    }
    if (typeof candidate === 'object') {
      return Object.values(candidate as Record<string, Player>);
    }
  }

  return [];
}

function prepareZoneContext(): PreparedZoneContext | null {
  const rawMusicConfig = config.audioserver?.musicCFG;
  if (!rawMusicConfig) {
    logger.error('[ZoneManager] No music configuration present on AudioServer config.');
    return null;
  }

  const musicConfigs = normaliseMusicConfig(rawMusicConfig);
  if (!musicConfigs.length) {
    logger.error('[ZoneManager] Unable to normalise music configuration; cannot initialise zones.');
    return null;
  }

  const macId = config.audioserver?.macID;
  const musicConfig = macId
    ? musicConfigs.find((entry) => entry && typeof entry === 'object' && entry[macId]) ?? musicConfigs[0]
    : musicConfigs[0];

  if (!musicConfig) {
    logger.error('[ZoneManager] Music configuration missing expected AudioServer entry.');
    return null;
  }

  const players = extractPlayers(musicConfig, macId).sort((a, b) => a.playerid - b.playerid);
  const adminConfig = getAdminConfig();
  const adminZones = new Map<number, ZoneConfigEntry>(adminConfig.zones.map((zone) => [zone.id, zone]));

  return { players, adminConfig, adminZones };
}

async function cleanupZone(playerId: number): Promise<void> {
  const existingZone = zone[playerId];
  if (!existingZone) return;
  const backendInstance = existingZone.player.backendInstance;
  if (backendInstance?.cleanup) {
    try {
      await backendInstance.cleanup();
    } catch (error) {
      logger.error(`[ZoneManager] Error cleaning up backend for Loxone player ID: ${playerId}: ${error}`);
    }
  }
  delete zone[playerId];
}

async function setupZoneInternal(
  player: Player,
  index: number,
  adminZones: Map<number, ZoneConfigEntry>,
  newZoneEntries: ZoneConfigEntry[],
): Promise<void> {
  const playerId = player.playerid;
  await cleanupZone(playerId);

  const zoneOverride = adminZones.get(playerId);
  let backend = zoneOverride?.backend;
  let ip = zoneOverride?.ip;
  const maPlayerId = zoneOverride?.maPlayerId;

  if (!backend || !ip) {
    logger.warn(`[ZoneManager] Missing backend or IP for Loxone player ID: ${playerId}. Creating default DummyBackend entry.`);
    const defaultZone: ZoneConfigEntry = { id: playerId, backend: 'DummyBackend', ip: '127.0.0.1' };
    newZoneEntries.push(defaultZone);
    adminZones.set(playerId, defaultZone);
    backend = defaultZone.backend;
    ip = defaultZone.ip;
  }

  const zoneNumber = index + 1;
  const zoneName = `Zone ${zoneNumber}`;

  zone[playerId] = {
    player: {
      uuid: player.uuid,
      playerid: player.playerid,
      clienttype: 0,
      enabled: true,
      internalname: `zone-${zoneNumber}`,
      max_volume: 100,
      name: zoneName,
      upnpmode: 0,
      upnprelay: 0,
      backend: backend || '',
      ip: ip || '',
      backendInstance: backend ? createBackend(backend, ip!, playerId, { maPlayerId }) : null,
    },
    track: {
      playerid: playerId,
      coverurl: '',
      station: '',
      audiotype: 2,
      audiopath: '',
      mode: 'stop',
      plrepeat: 0,
      plshuffle: 0,
      duration: 0,
      time: 0,
      power: 'on',
      volume: 0,
      players: [{ playerid: playerId }],
    },
  };

  logger.info(
    `[ZoneManager] Zone #${zoneNumber} set up for Loxone player ID: ${playerId}, Backend: ${backend || 'not specified'}, IP: ${ip || 'not specified'}`,
  );

  if (zone[playerId].player.backendInstance) {
    try {
      await zone[playerId].player.backendInstance.initialize();
    } catch (error) {
      logger.error(`[ZoneManager] Error initializing zone backend for Loxone player ID: ${playerId}: ${error}`);
      zone[playerId].player.backendInstance = null;
    }
  }
}

function persistNewZoneEntries(newZoneEntries: ZoneConfigEntry[], adminConfig: AdminConfig) {
  if (!newZoneEntries.length) return;
  const updatedZones = [...adminConfig.zones];
  let hasChanges = false;

  newZoneEntries.forEach((entry) => {
    if (!updatedZones.some((zoneConfig) => zoneConfig.id === entry.id)) {
      updatedZones.push(entry);
      hasChanges = true;
      logger.info(`[ZoneManager] Added default zone configuration for Loxone player ID ${entry.id}.`);
    }
  });

  if (hasChanges) {
    updateAdminConfig({
      ...adminConfig,
      zones: updatedZones,
    });
  }
}

/**
 * Sets up zones based on the music configuration fetched from the MiniServer.
 * This function initializes each player as a zone and logs relevant information.
 *
 * @returns {Promise<void>} A promise that resolves when zones are set up.
 * @throws {Error} Throws an error if no music configuration or players are found.
 */
const setupZones = async (): Promise<void> => {
  const context = prepareZoneContext();
  if (!context) return;

  const { players, adminConfig, adminZones } = context;

  if (players.length === 0) {
    logger.error('[ZoneManager] No players configured in Music configuration. Skipping Zone Initialization');
    return;
  }

  logger.info(`[ZoneManager] ${players.length} zones configured in Music configuration.`);

  await cleanupZones();
  Object.keys(zone).forEach((key) => delete zone[Number(key)]);

  const newZoneEntries: ZoneConfigEntry[] = [];

  for (const [index, player] of players.entries()) {
    await setupZoneInternal(player, index, adminZones, newZoneEntries);
  }

  persistNewZoneEntries(newZoneEntries, adminConfig);
};

const setupZoneById = async (playerId: number): Promise<boolean> => {
  const context = prepareZoneContext();
  if (!context) return false;

  const { players, adminConfig, adminZones } = context;
  const index = players.findIndex((player) => player.playerid === playerId);
  if (index === -1) {
    logger.warn(`[ZoneManager] Cannot connect unknown Loxone player ID: ${playerId}`);
    return false;
  }

  const newZoneEntries: ZoneConfigEntry[] = [];
  await setupZoneInternal(players[index], index, adminZones, newZoneEntries);
  persistNewZoneEntries(newZoneEntries, adminConfig);
  return true;
};

function getZoneStatuses(): Record<number, ZoneStatus> {
  const statuses: Record<number, ZoneStatus> = {};
  const adminConfig = getAdminConfig();

  adminConfig.zones.forEach((zoneConfig) => {
    statuses[zoneConfig.id] = {
      id: zoneConfig.id,
      backend: zoneConfig.backend,
      ip: zoneConfig.ip,
      name: `Zone ${zoneConfig.id}`,
      connected: Boolean(zone[zoneConfig.id]?.player.backendInstance),
    };
  });

  Object.entries(zone).forEach(([idString, zoneEntry]) => {
    const id = Number(idString);
    const track = zoneEntry.track;
    statuses[id] = {
      id,
      backend: zoneEntry.player.backend || statuses[id]?.backend || '',
      ip: zoneEntry.player.ip || statuses[id]?.ip || '',
      name: zoneEntry.player.name || statuses[id]?.name || `Zone ${id}`,
      connected: Boolean(zoneEntry.player.backendInstance),
      state: track?.mode || track?.clientState || statuses[id]?.state,
      title: track?.title || track?.name || statuses[id]?.title,
      artist: track?.artist || statuses[id]?.artist,
      coverUrl: track?.coverurl || statuses[id]?.coverUrl,
    };
  });

  return statuses;
}

/**
 * Sends a command to the specified zone's backend.
 * This function allows sending a command to the backend service associated with a zone based on the provided player ID and command.
 *
 * @param {string} playerId - The ID of the player whose backend will receive the command.
 * @param {string} command - The command to be sent to the backend.
 * @param {string} param - The parameter to be sent to the backend.
 * @returns {Promise<void>} A promise that resolves when the command has been sent.
 * @throws {Error} Throws an error if the backend is not defined for the player ID.
 */
const sendCommandToZone = async (
  playerId: number,
  command: string,
  param?: string | string[],
): Promise<void> => {
  const zone = getZoneById(playerId); // Get the zone by player ID
  if (!zone) {
    logger.warn(`[ZoneManager] Command ignored for unknown Loxone player ID: ${playerId}`);
    return;
  }

  const backendInstance = zone.player.backendInstance; // Get the backend instance

  if (backendInstance) {
    try {
      await backendInstance.sendCommand(command, param);
    } catch (error) {
      logger.error(`[ZoneManager] Error sending command to zone backend for Loxone player ID: ${playerId}: ${error}`);
    }
  } else {
    logger.error(`[ZoneManager] No backend instance found for Loxone player ID: ${playerId}`);
  }
};

/**
 * Sends a group command to the backend for a specified zone based on the provided group IDs.
 *
 * @param {string} command - The command to execute for the group action.
 * @param {any} type - The type of the command, which can be specific to the command's context.
 * @param {string} Group - A comma-separated string of player IDs, where the first ID is the master ID.
 *
 * This function splits the Group string into an array, retrieves the zone associated with the 
 * master ID, and attempts to send the group command to the backend instance. If successful, 
 * it will log any errors encountered during the process.
 *
 */
const sendGroupCommandToZone = async (command: string, type: any, Group: string): Promise<void> => {
  const idArray = Group.split(',');  // Split the IDs by comma
  const masterID = Number(idArray[0]);        // The first entry is always the masterID
  const additionalIDs = idArray.slice(1); // Get all additional IDs as an array

  const zone = getZoneById(masterID); // Get the zone by player ID

  if (!zone) {
    logger.warn(`[ZoneManager] Group command ignored for unknown Loxone player ID: ${masterID}`);
    return;
  }

  const backendInstance = zone.player.backendInstance; // Get the backend instance

  if (backendInstance) {
    try {
      await backendInstance.sendGroupCommand(command, type, masterID, ...additionalIDs);
    } catch (error) {
      logger.error(`[ZoneManager] Error sending command to zone backend for Loxone player ID: ${masterID}: ${error}`);
    }
  } else {
    logger.error(`[ZoneManager] No backend instance found for Loxone player ID: ${masterID}`);
  }
};

/**
 * Retrieves a zone by player ID.
 * This function searches for a zone in the in-memory database using the provided player ID.
 *
 * @param {string} playerId - The ID of the player whose zone is to be retrieved.
 * @returns {any} The zone associated with the player ID.
 * @throws {Error} Throws an error if no zone is found for the player ID.
 */
const getZoneById = (playerId: number): ZoneEntry | undefined => {
  const foundZone = zone[playerId]; // Find the zone by player ID

  // Check if AudioServer is Paired
  if (!config.audioserver?.paired) {
    logger.debug(`[ZoneManager] !! AudioServer not Paired. NO Zones initialized !!`);
  }

  // Check if the zone exists
  if (!foundZone) {
    logger.error(`[ZoneManager] No zone found for Loxone player ID: ${playerId}`); // Log error if not found
    return undefined;
  }

  return foundZone; // Return the found zone
};

/**
 * Updates the track information for a specific zone.
 * This function allows updating track details for a zone based on the provided player ID and new track information.
 *
 * @param {string} playerId - The ID of the player whose track information is to be updated.
 * @param {Partial<Track>} newTrackInfo - The new track information to update.
 * @returns {boolean} Returns true if the update was successful, otherwise false.
 */
const updateZoneTrack = (playerId: number, newTrackInfo: Partial<Track>): boolean => {
  const existingZone = zone[playerId]; // Find the existing zone

  // Check if the zone exists
  if (!existingZone) {
    logger.error(`[ZoneManager] Cannot update track: No zone found for Loxone player ID: ${playerId}`); // Log error if not found
    return false; // Return false to indicate failure
  }

  // Update the track information with new data
  existingZone.track = { ...existingZone.track, ...newTrackInfo };
  logger.debug(`[ZoneManager] Updated track for Loxone player ID: ${playerId}`, existingZone.track); // Log successful update

  // Push the new information to all WebSocket Clients
  const audioEventMessage = JSON.stringify({
    audio_event: [existingZone.track],
  });

  broadcastEvent(audioEventMessage); // Broadcast updated track information to WebSocket clients

  return true; // Return true to indicate success
};

/**
 * Updates the queue information for a specific zone and broadcasts an
 * `audio_queue_event` to all connected Loxone clients.
 *
 * This is analoog aan `updateZoneTrack`, maar dan voor queue status.
 *
 * @param {string} playerId - De Loxone player ID van de zone.
 * @param {number} queueSize - Het aantal items in de huidige queue.
 * @param {number} [restrictions=1] - Restrictie vlag; de meeste servers sturen 1.
 * @returns {boolean} - True als succesvol gebroadcast, anders false.
 */
const updateZoneQueue = (playerId: number, queueSize: number, restrictions: number = 1): boolean => {
  const existingZone = zone[playerId];

  // Controleer of de zone bestaat
  if (!existingZone) {
    logger.error(`[ZoneManager] Cannot update queue: No zone found for Loxone player ID: ${playerId}`);
    return false;
  }

  // Bouw de broadcast payload volgens de echte server
  const audioQueueEvent = JSON.stringify({
    audio_queue_event: [
      {
        playerid: Number(playerId),   // Loxone playerId numeriek
        queuesize: Number.isFinite(queueSize) ? queueSize : 0,
        restrictions: Number.isFinite(restrictions) ? restrictions : 0
      }
    ]
  });

  // Log en verstuur
  logger.debug(`[ZoneManager] Updated queue for Loxone player ID: ${playerId} (size=${queueSize}, restrictions=${restrictions})`);
  broadcastEvent(audioQueueEvent);

  return true;
};

// TODO
// Test with BeoLink
const updateZoneGroup = () => {
  const first = zone[15];
  const second = zone[14];
  if (!first || !second) return;
  broadcastEvent(
    `{"audio_sync_event":[{"group":"fe78dcce-e931-095d-0eff-018e010d95d8","mastervolume":25,"players":[{"id":"${first.player.uuid}","playerid":${first.player.playerid}},{"id":"${second.player.uuid}","playerid":${second.player.playerid}}],"type":"dynamic"}]}`,
  );
}
// TODO

const cleanupZones = async (): Promise<void> => {
  const entries = Object.values(zone);
  await Promise.all(
    entries.map(async (entry) => {
      const backendInstance = entry.player.backendInstance;
      if (backendInstance?.cleanup) {
        try {
          await backendInstance.cleanup();
        } catch (error) {
          logger.error(
            `[ZoneManager] Error cleaning up backend for Loxone player ID: ${entry.player.playerid}: ${error}`,
          );
        }
      }
    }),
  );
};

export {
  setupZones,
  setupZoneById,
  sendCommandToZone,
  sendGroupCommandToZone,
  updateZoneTrack,
  updateZoneQueue,
  updateZoneGroup,
  getZoneById,
  cleanupZones,
  getZoneStatuses,
  Track,
};
