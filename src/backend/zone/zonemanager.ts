import logger from '../../utils/troxorlogger';
import {
  config,
  getAdminConfig,
  updateAdminConfig,
  getStoredVolumePreset,
} from '../../config/config';
import type { ZoneVolumeConfig } from '../../config/config';
import { broadcastEvent } from '../../http/broadcastEvent';
import { createBackend } from './backendFactory';
import type { ZoneConfigEntry, AdminConfig } from '../../config/configStore';
import { mergeZoneConfigEntries } from './zoneConfigUtils';
import {
  PlayerStatus as LoxonePlayerStatus,
  AudioType,
  FileType,
  RepeatMode,
  AudioEvent,
  SyncedPlayerEntry,
} from './loxoneTypes';
import {
  getAllGroups as getTrackedGroups,
  getGroupByZone as getTrackedGroupByZone,
  removeZoneFromGroups,
  GroupRecord,
} from './groupTracker';

type PlayerOutputChannel = {
  id?: string;
};

type PlayerOutput = {
  channels?: PlayerOutputChannel[];
};

type PlayerOutputCollection = PlayerOutput[] | Record<string, PlayerOutput>;

interface Player {
  uuid: string;
  playerid: number;
  backend: string;
  ip: string;
  name?: string;
  outputs?: PlayerOutputCollection;
}

type PlayerStatus = LoxonePlayerStatus;

interface ZoneEntryQueue {
  id: number;
  items: any[];
  shuffle: boolean;
  start: number;
  totalitems: number;
}

interface ZoneState {
  player: {
    uuid: string;
    playerid: number;
    clienttype: number;
    enabled: boolean;
    internalname: string;
    max_volume: number;
    name: string;
    upnpmode: number;
    upnprelay: number;
    backend: string;
    ip: string;
    backendInstance?: any;
  };
  playerEntry: PlayerStatus;
  queue?: ZoneEntryQueue;
  fadeTargetVolume?: number;
}

/**
 * In-memory registry of active zones keyed by Loxone player ID. Populated from the MiniServer config
 * and mirrored toward the admin UI via websocket broadcasts.
 */
const zone: Record<number, ZoneState> = {};
type ZoneEntry = ZoneState;

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
  resolveSourceName?: SourceResolver;
}

function createDefaultPlayerEntry(playerId: number, zoneName: string): PlayerStatus {
  return {
    playerid: playerId,
    coverurl: '',
    station: '',
    audiotype: AudioType.Playlist,
    audiopath: '',
    mode: 'stop',
    plrepeat: RepeatMode.NoRepeat,
    plshuffle: false,
    duration: 0,
    duration_ms: 0,
    time: 0,
    power: 'on',
    volume: 0,
    title: '',
    artist: '',
    album: '',
    qindex: 0,
    name: zoneName,
    type: FileType.Unknown,
    clientState: 'off',
    players: [{ playerid: playerId }],
  };
}

function toAudioEvent(entry: PlayerStatus): AudioEvent {
  const {
    album = '',
    artist = '',
    audiopath = '',
    audiotype = AudioType.Playlist,
    coverurl = '',
    duration = 0,
    duration_ms,
    eventype,
    mode = 'stop',
    name,
    parent = null,
    playerid,
    plrepeat = RepeatMode.NoRepeat,
    plshuffle = false,
    position_ms,
    power = 'off',
    qid,
    qindex = 0,
    sourceName,
    station,
    time = 0,
    title,
    type = FileType.Unknown,
    icontype,
    volume = 0,
  } = entry;

  const toMilliseconds = (seconds: number) => (Number.isFinite(seconds) ? seconds * 1000 : 0);
  const durationSeconds = Number(duration) || 0;
  const timeSeconds = Number(time) || 0;
  const resolvedName = name ?? title ?? '';

  return {
    album,
    artist,
    audiopath,
    audiotype,
    coverurl,
    duration: durationSeconds,
    duration_ms: duration_ms ?? toMilliseconds(durationSeconds),
    eventype,
    mode,
    name: resolvedName,
    parent,
    playerid,
    plrepeat,
    plshuffle: Boolean(plshuffle),
    position_ms: position_ms ?? toMilliseconds(timeSeconds),
    power,
    qid,
    qindex,
    sourceName,
    station,
    time: timeSeconds,
    title: title ?? resolvedName,
    type,
    icontype,
    volume: Number(volume),
  };
}

/**
 * The MiniServer can deliver the music config as JSON, stringified JSON, or keyed objects.
 * Normalise everything into a plain array so downstream processing can stay simple.
 */
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

/**
 * Extract the set of players for the current AudioServer, coping with the many casing variants
 * Loxone uses in different firmware versions.
 */
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

function normaliseOutputs(outputs?: PlayerOutputCollection): PlayerOutput[] {
  if (!outputs) return [];
  if (Array.isArray(outputs)) return outputs.filter(Boolean);
  return Object.values(outputs).filter(Boolean);
}

function extractPrimaryChannelId(player: Player): string | undefined {
  const outputs = normaliseOutputs(player.outputs);
  for (const output of outputs) {
    const channels = Array.isArray(output?.channels) ? output.channels : [];
    for (const channel of channels) {
      if (typeof channel?.id === 'string' && channel.id.trim()) {
        return channel.id.trim();
      }
    }
  }
  return undefined;
}

type SourceResolver = (player: Player) => string | undefined;

/**
 * Build a helper that maps channel serials back to friendly source names (core + extensions).
 */
function createSourceResolver(serverSection: Record<string, any>, macId?: string): SourceResolver | undefined {
  if (!serverSection || typeof serverSection !== 'object') return undefined;

  const sourceMap = new Map<string, string>();
  const register = (serial: unknown, name: unknown) => {
    if (typeof serial !== 'string') return;
    const normalizedSerial = serial.trim().toUpperCase();
    if (!normalizedSerial) return;
    if (sourceMap.has(normalizedSerial)) return;
    const resolvedName = typeof name === 'string' && name.trim() ? name.trim() : normalizedSerial;
    sourceMap.set(normalizedSerial, resolvedName);
  };

  const registerServer = (section: Record<string, any> | undefined) => {
    if (!section || typeof section !== 'object') return;
    register(section.serial, section.name);
    register(section.mac, section.name);
    register(section.macid, section.name);
  };

  register(macId, serverSection?.name);
  registerServer(serverSection);

  const extensions =
    Array.isArray(serverSection.extensions)
      ? serverSection.extensions
      : Array.isArray(serverSection.Extensions)
        ? serverSection.Extensions
        : [];

  extensions.forEach((extension: Record<string, any>) => {
    if (!extension || typeof extension !== 'object') return;
    register(extension.serial ?? extension.mac, extension.name ?? extension.label);
  });

  if (!sourceMap.size) return undefined;

  return (player: Player) => {
    const channelId = extractPrimaryChannelId(player);
    if (!channelId) return undefined;
    const [rawSerial] = channelId.split('#');
    if (!rawSerial) return undefined;
    const normalizedSerial = rawSerial.trim().toUpperCase();
    if (!normalizedSerial) return undefined;
    return sourceMap.get(normalizedSerial) ?? normalizedSerial;
  };
}

/**
 * Compose the working view for zone setup, combining MiniServer data, admin overrides,
 * and the source resolver in one place.
 */
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

  const serverSection = macId && musicConfig[macId] ? musicConfig[macId] : musicConfig;
  const resolveSourceName = createSourceResolver(serverSection, macId);
  const players = extractPlayers(musicConfig, macId).sort((a, b) => a.playerid - b.playerid);
  const adminConfig = getAdminConfig();
  const adminZones = new Map<number, ZoneConfigEntry>(adminConfig.zones.map((zone) => [zone.id, zone]));

  return { players, adminConfig, adminZones, resolveSourceName };
}

/**
 * Tear down the backend for a single zone; used when re-syncing from MiniServer updates.
 */
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
  removeZoneFromGroups(playerId);
  delete zone[playerId];
}

/**
 * Apply admin overrides, create the backend instance, and broadcast player info for a single zone.
 */
async function setupZoneInternal(
  player: Player,
  index: number,
  adminZones: Map<number, ZoneConfigEntry>,
  newZoneEntries: ZoneConfigEntry[],
  updatedZoneEntries: ZoneConfigEntry[],
  resolveSourceName?: SourceResolver,
): Promise<void> {
  const playerId = player.playerid;
  await cleanupZone(playerId);

  let zoneOverride = adminZones.get(playerId);
  const resolvedSource = resolveSourceName?.(player);
  const sourceName = typeof resolvedSource === 'string' ? resolvedSource.trim() : '';

  if (zoneOverride && sourceName && zoneOverride.source !== sourceName) {
    zoneOverride = { ...zoneOverride, source: sourceName };
    adminZones.set(playerId, zoneOverride);
    updatedZoneEntries.push(zoneOverride);
  }

  let backend = zoneOverride?.backend;
  let ip = zoneOverride?.ip;
  const maPlayerId = zoneOverride?.maPlayerId;
  let configuredName = typeof zoneOverride?.name === 'string' ? zoneOverride.name.trim() : '';
  const playerProvidedName = typeof player?.name === 'string' ? player.name.trim() : '';

  if (!backend || !ip) {
    logger.warn(
      `[ZoneManager] Missing backend or IP for Loxone player ID: ${playerId}. Creating default NullBackend entry.`,
    );
    const fallbackName = configuredName || playerProvidedName || `Zone ${index + 1}`;
    const defaultZone: ZoneConfigEntry = {
      id: playerId,
      backend: 'NullBackend',
      ip: '',
      name: fallbackName,
      source: sourceName || undefined,
    };
    newZoneEntries.push(defaultZone);
    adminZones.set(playerId, defaultZone);
    backend = defaultZone.backend;
    ip = defaultZone.ip;
    configuredName = defaultZone.name || configuredName;
  }

  const zoneNumber = index + 1;
  const zoneName = configuredName || playerProvidedName || `Zone ${zoneNumber}`;

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
    playerEntry: createDefaultPlayerEntry(playerId, zoneName),
  };

  logger.info(
    `[ZoneManager][${zoneName}] set up for Loxone player ID: ${playerId}, Backend: ${backend || 'not specified'}, IP: ${ip || 'not specified'}`,
  );

  if (zone[playerId].player.backendInstance) {
    try {
      await zone[playerId].player.backendInstance.initialize();
    } catch (error) {
      logger.error(`[ZoneManager] Error initializing zone backend for Loxone player ID: ${playerId}: ${error}`);
      zone[playerId].player.backendInstance = null;
    }
  }

  applyStoredVolumePreset(playerId, false);
  updateZoneFadeTarget(playerId);
}

/**
 * Write any new or updated zones back to the admin configuration to keep disk state in sync.
 */
function persistZoneConfigChanges(
  newZoneEntries: ZoneConfigEntry[],
  updatedZoneEntries: ZoneConfigEntry[],
  adminConfig: AdminConfig,
) {
  const { merged, added } = mergeZoneConfigEntries(adminConfig.zones, newZoneEntries);
  const updatesById = new Map(updatedZoneEntries.map((entry) => [entry.id, entry]));

  let finalZones = merged;
  if (updatesById.size) {
    finalZones = merged.map((entry) => {
      const update = updatesById.get(entry.id);
      return update ? { ...entry, ...update } : entry;
    });
  }

  if (!added.length && !updatesById.size) return;

  added.forEach((entry) => {
    logger.info(`[ZoneManager] Added default zone configuration for Loxone player ID ${entry.id}.`);
  });

  updatesById.forEach((entry) => {
    logger.info(`[ZoneManager] Updated zone configuration for Loxone player ID ${entry.id}.`);
  });

  updateAdminConfig({
    ...adminConfig,
    zones: finalZones,
  });
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

  const { players, adminConfig, adminZones, resolveSourceName } = context;

  if (players.length === 0) {
    logger.error('[ZoneManager] No players configured in Music configuration. Skipping Zone Initialization');
    return;
  }

  logger.info(`[ZoneManager] ${players.length} zones configured in Music configuration.`);

  await cleanupZones();
  Object.keys(zone).forEach((key) => delete zone[Number(key)]);

  const newZoneEntries: ZoneConfigEntry[] = [];
  const updatedZoneEntries: ZoneConfigEntry[] = [];

  for (const [index, player] of players.entries()) {
    await setupZoneInternal(player, index, adminZones, newZoneEntries, updatedZoneEntries, resolveSourceName);
  }

  persistZoneConfigChanges(newZoneEntries, updatedZoneEntries, adminConfig);
};

const setupZoneById = async (playerId: number): Promise<boolean> => {
  const context = prepareZoneContext();
  if (!context) return false;

  const { players, adminConfig, adminZones, resolveSourceName } = context;
  const index = players.findIndex((player) => player.playerid === playerId);
  if (index === -1) {
    logger.warn(`[ZoneManager] Cannot connect unknown Loxone player ID: ${playerId}`);
    return false;
  }

  const newZoneEntries: ZoneConfigEntry[] = [];
  const updatedZoneEntries: ZoneConfigEntry[] = [];
  await setupZoneInternal(players[index], index, adminZones, newZoneEntries, updatedZoneEntries, resolveSourceName);
  persistZoneConfigChanges(newZoneEntries, updatedZoneEntries, adminConfig);
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
      name: zoneConfig.name || `Zone ${zoneConfig.id}`,
      connected: Boolean(zone[zoneConfig.id]?.player.backendInstance),
    };
  });

  Object.entries(zone).forEach(([idString, zoneEntry]) => {
    const id = Number(idString);
    const playerEntry = zoneEntry.playerEntry;
    statuses[id] = {
      id,
      backend: zoneEntry.player.backend || statuses[id]?.backend || '',
      ip: zoneEntry.player.ip || statuses[id]?.ip || '',
      name: zoneEntry.player.name || statuses[id]?.name || `Zone ${id}`,
      connected: Boolean(zoneEntry.player.backendInstance),
      state: playerEntry?.mode || playerEntry?.clientState || statuses[id]?.state,
      title: playerEntry?.title || playerEntry?.name || statuses[id]?.title,
      artist: playerEntry?.artist || statuses[id]?.artist,
      coverUrl: playerEntry?.coverurl || statuses[id]?.coverUrl,
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

interface BackendPlayerLookupResult {
  zoneId: number;
  zone: ZoneEntry;
}

function normalizeBackendIdentifier(identifier: unknown): string | undefined {
  if (typeof identifier !== 'string') return undefined;
  const trimmed = identifier.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function getBackendPlayerIdentifiers(entry: ZoneEntry): string[] {
  const identifiers: string[] = [];
  const uuid = normalizeBackendIdentifier(entry.player?.uuid);
  if (uuid) identifiers.push(uuid);

  const backendInstance = entry.player?.backendInstance as { maPlayerId?: string; playerId?: string } | undefined;
  const maId = normalizeBackendIdentifier(backendInstance?.maPlayerId);
  if (maId) identifiers.push(maId);

  const genericId = normalizeBackendIdentifier((backendInstance as any)?.playerId);
  if (genericId) identifiers.push(genericId);

  return identifiers;
}

function findZoneByBackendPlayerId(backendPlayerId: string): BackendPlayerLookupResult | undefined {
  const normalizedTarget = normalizeBackendIdentifier(backendPlayerId);
  if (!normalizedTarget) return undefined;

  for (const [idString, entry] of Object.entries(zone)) {
    if (!entry) continue;
    const identifiers = getBackendPlayerIdentifiers(entry);
    if (identifiers.some((identifier) => identifier === normalizedTarget)) {
      const zoneId = Number(idString);
      if (!Number.isFinite(zoneId)) continue;
      return { zoneId, zone: entry };
    }
  }

  return undefined;
}

/**
 * Updates the Loxone player status for a zone and notifies connected listeners.
 * This is the primary way backends surface state changes (title, playback mode, etc.).
*
 * @param {string} playerId - The ID of the player whose state is being updated.
 * @param {Partial<PlayerStatus>} newState - The new state information to merge.
 * @returns {boolean} Returns true if the update was successful, otherwise false.
 */
const updateZonePlayerStatus = (playerId: number, newState: Partial<PlayerStatus>): boolean => {
  const existingZone = zone[playerId]; // Find the existing zone

  // Check if the zone exists
  if (!existingZone) {
    logger.error(`[ZoneManager] Cannot update player entry: No zone found for Loxone player ID: ${playerId}`);
    return false; // Return false to indicate failure
  }

  // Update the player entry with new data
  existingZone.playerEntry = { ...existingZone.playerEntry, ...newState };
  logger.debug(`[ZoneManager] Updated player entry for Loxone player ID: ${playerId}`, existingZone.playerEntry);

  // Push the new information to all WebSocket Clients
  const audioEventPayload = toAudioEvent(existingZone.playerEntry);
  const audioEventMessage = JSON.stringify({
    audio_event: [audioEventPayload],
  });

  broadcastEvent(audioEventMessage); // Broadcast updated player information to WebSocket clients

  return true; // Return true to indicate success
};

/**
 * Updates the queue information for a specific zone and broadcasts an
 * `audio_queue_event` to all connected Loxone clients.
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
        playerid: Number(playerId), // Loxone playerId numeriek
        queuesize: Number.isFinite(queueSize) ? queueSize : 0,
        restrictions: Number.isFinite(restrictions) ? restrictions : 0,
      },
    ],
  });

  // Log en verstuur
  logger.debug(
    `[ZoneManager] Updated queue for Loxone player ID: ${playerId} (size=${queueSize}, restrictions=${restrictions})`,
  );
  broadcastEvent(audioQueueEvent);

  return true;
};

function updateZonePlayerName(playerId: number, name: string): boolean {
  const existingZone = zone[playerId];

  if (!existingZone) {
    logger.error(`[ZoneManager] Cannot update player name: No zone found for Loxone player ID: ${playerId}`);
    return false;
  }

  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (trimmedName) {
    existingZone.player.name = trimmedName;
    const adminConfig = getAdminConfig();
    const zones = [...adminConfig.zones];
    const index = zones.findIndex((entry) => entry.id === playerId);
    if (index >= 0) {
      if (zones[index].name !== trimmedName) {
        zones[index] = { ...zones[index], name: trimmedName };
        updateAdminConfig({ ...adminConfig, zones });
      }
    } else {
      zones.push({ id: playerId, backend: existingZone.player.backend, ip: existingZone.player.ip, name: trimmedName });
      updateAdminConfig({ ...adminConfig, zones });
    }
  }

  return updateZonePlayerStatus(playerId, { name: trimmedName });
}

type AudioSyncEventPlayer = {
  id: string;
  playerid: number;
  name?: string;
};

type AudioSyncGroupPayload = {
  group: string;
  mastervolume: number;
  players: AudioSyncEventPlayer[];
  type: 'dynamic';
};

type GroupBuildResult = {
  payload: AudioSyncGroupPayload;
  participantIds: number[];
  syncedPlayers: SyncedPlayerEntry[];
};

const clampVolume = (value: unknown): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric < 0) return 0;
  if (numeric > 100) return 100;
  return Math.round(numeric);
};

function resolveBackendPlayerIdentifier(entry: ZoneState): string {
  const uuid = typeof entry.player?.uuid === 'string' ? entry.player.uuid.trim() : '';
  if (uuid) return uuid;

  const backendInstance = entry.player?.backendInstance as { maPlayerId?: string } | undefined;
  const maPlayerId = typeof backendInstance?.maPlayerId === 'string' ? backendInstance.maPlayerId.trim() : '';
  if (maPlayerId) return maPlayerId;

  return String(entry.player.playerid);
}

function playersEqual(current: SyncedPlayerEntry[] | undefined, next: SyncedPlayerEntry[]): boolean {
  if (!Array.isArray(current) || current.length !== next.length) return false;
  return current.every((entry, index) => entry.playerid === next[index].playerid);
}

function buildGroupPayload(record: GroupRecord): GroupBuildResult | undefined {
  if (!record) return undefined;

  const candidateIds = record.members
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);

  const uniqueIds: number[] = [];
  const seen = new Set<number>();
  candidateIds.forEach((id) => {
    if (!seen.has(id)) {
      seen.add(id);
      uniqueIds.push(id);
    }
  });

  const participants = uniqueIds
    .map((id) => {
      const entry = zone[id];
      return entry ? { id, entry } : undefined;
    })
    .filter((item): item is { id: number; entry: ZoneState } => Boolean(item));

  if (participants.length === 0) return undefined;

  const syncedPlayers: SyncedPlayerEntry[] = participants.map(({ id, entry }) => ({
    playerid: id,
    name: entry.player.name,
  }));

  const audioPlayers: AudioSyncEventPlayer[] = participants.map(({ entry }) => ({
    id: resolveBackendPlayerIdentifier(entry),
    playerid: entry.player.playerid,
    name: entry.player.name,
  }));

  const activeParticipant =
    participants.find(({ entry }) => String(entry.playerEntry?.power ?? '').toLowerCase() === 'on') ??
    participants[0];

  const mastervolume = clampVolume(activeParticipant?.entry.playerEntry?.volume);
  const groupId = record.externalId ?? `group-${record.leader}`;

  return {
    payload: {
      group: groupId,
      mastervolume,
      players: audioPlayers,
      type: 'dynamic',
    },
    participantIds: participants.map((participant) => participant.id),
    syncedPlayers,
  };
}

const updateZoneGroup = (): void => {
  const trackedGroups = getTrackedGroups().filter((record) => record.members.length > 1);
  const zonePlayersMap = new Map<number, SyncedPlayerEntry[]>();
  const audioSyncGroups: AudioSyncGroupPayload[] = [];

  trackedGroups.forEach((record) => {
    const result = buildGroupPayload(record);
    if (!result) return;
    audioSyncGroups.push(result.payload);
    result.participantIds.forEach((participantId) => {
      zonePlayersMap.set(participantId, result.syncedPlayers);
    });
  });

  broadcastEvent(JSON.stringify({ audio_sync_event: audioSyncGroups }));

  if (audioSyncGroups.length > 0) {
    audioSyncGroups.forEach((group) => {
      broadcastEvent(
        JSON.stringify({
          mastervolumechanged_event: {
            group: group.group,
            mastervolume: group.mastervolume,
          },
        }),
      );
    });
  }

  Object.keys(zone).forEach((idString) => {
    const zoneId = Number(idString);
    if (!Number.isFinite(zoneId)) return;
    const entry = zone[zoneId];
    if (!entry) return;

    const defaultPlayers: SyncedPlayerEntry[] = [{ playerid: zoneId, name: entry.player.name }];
    const mappedPlayers = zonePlayersMap.get(zoneId) ?? defaultPlayers;
    const currentPlayers = entry.playerEntry.players as SyncedPlayerEntry[] | undefined;
    const currentlyGrouped = Array.isArray(currentPlayers) && currentPlayers.length > 1;
    const shouldUpdate = zonePlayersMap.has(zoneId) || currentlyGrouped;

    if (!shouldUpdate) return;

    if (!playersEqual(currentPlayers, mappedPlayers)) {
      updateZonePlayerStatus(zoneId, { players: mappedPlayers });
    }
  });

  logger.debug(`[ZoneManager] Broadcast audio_sync_event with ${audioSyncGroups.length} group(s).`);
};

type MasterVolumeAdjustment = {
  groupId?: string;
  masterZoneId: number;
  targetVolume: number;
  updates: Array<{ zoneId: number; volume: number }>;
  skipped: Array<{ zoneId: number; reason: string }>;
};

const applyMasterVolumeToGroup = async (zoneId: number, targetVolume: number): Promise<MasterVolumeAdjustment> => {
  const zoneEntry = getZoneById(zoneId);
  const clampedTarget = clampVolume(targetVolume);
  if (!zoneEntry) {
    return {
      masterZoneId: zoneId,
      targetVolume: clampedTarget,
      updates: [],
      skipped: [{ zoneId, reason: 'zone-not-found' }],
    };
  }

  const trackedGroup = getTrackedGroupByZone(zoneId);

  let participantIds: number[] = [];
  let groupId: string | undefined;
  if (trackedGroup && trackedGroup.members.length > 1) {
    groupId = trackedGroup.externalId ?? `group-${trackedGroup.leader}`;
    participantIds = [...trackedGroup.members];
  } else {
    const players = Array.isArray(zoneEntry.playerEntry?.players) ? zoneEntry.playerEntry.players : [];
    if (players.length > 1) {
      participantIds = players.map((player) => Number(player?.playerid)).filter((id) => Number.isFinite(id) && id > 0);
    }
  }

  if (participantIds.length === 0) {
    participantIds = [zoneId];
  }

  const uniqueParticipantIds = Array.from(new Set(participantIds));
  const masterZoneId = trackedGroup?.leader ?? uniqueParticipantIds[0] ?? zoneId;
  const masterEntry = getZoneById(masterZoneId) ?? zoneEntry;
  const masterVolume = clampVolume(masterEntry.playerEntry?.volume ?? 0);
  const volumeDelta = clampedTarget - masterVolume;

  const updates: Array<{ zoneId: number; volume: number }> = [];
  const skipped: Array<{ zoneId: number; reason: string }> = [];

  for (const participantId of uniqueParticipantIds) {
    const participantEntry = getZoneById(participantId);
    if (!participantEntry) {
      skipped.push({ zoneId: participantId, reason: 'zone-not-found' });
      continue;
    }

    const currentVolume = clampVolume(participantEntry.playerEntry?.volume ?? 0);
    const desiredVolume =
      participantId === masterZoneId ? clampedTarget : clampVolume(currentVolume + volumeDelta);
    const delta = desiredVolume - currentVolume;

    if (delta === 0) {
      updates.push({ zoneId: participantId, volume: desiredVolume });
      continue;
    }

    try {
      await sendCommandToZone(participantId, 'volume', String(delta));
      updateZonePlayerStatus(participantId, { volume: desiredVolume });
      updates.push({ zoneId: participantId, volume: desiredVolume });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[ZoneManager] Failed to adjust volume for zone ${participantId}: ${message}`);
      skipped.push({ zoneId: participantId, reason: 'command-failed' });
    }
  }

  if (updates.length > 0) {
    updateZoneGroup();
  }

  return {
    groupId,
    masterZoneId,
    targetVolume: clampedTarget,
    updates,
    skipped,
  };
};

/**
 * Stop every backend instance and clear the in-memory registry. Used on shutdown and full re-syncs.
 */
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

function applyVolumePresetToZone(playerId: number, preset: ZoneVolumeConfig, broadcast = false): void {
  const entry = zone[playerId];
  if (!entry) return;

  const updates: Partial<PlayerStatus> = {};

  if (preset.default !== undefined) updates.defaultVolume = preset.default;
  if (preset.alarm !== undefined) updates.alarmVolume = preset.alarm;
  if (preset.fire !== undefined) (updates as any).fireVolume = preset.fire;
  if (preset.bell !== undefined) updates.bellVolume = preset.bell;
  if (preset.buzzer !== undefined) updates.buzzerVolume = preset.buzzer;
  if (preset.tts !== undefined) updates.ttsVolume = preset.tts;
  if (preset.max !== undefined) {
    updates.maxVolume = preset.max;
    entry.player.max_volume = preset.max;
  }

  if (Object.keys(updates).length === 0) return;

  if (broadcast) {
    updateZonePlayerStatus(playerId, updates);
  } else {
    entry.playerEntry = { ...entry.playerEntry, ...updates };
  }
}

function applyStoredVolumePreset(playerId: number, broadcast = false): ZoneVolumeConfig | undefined {
  const preset = getStoredVolumePreset(playerId);
  if (!preset) return undefined;
  applyVolumePresetToZone(playerId, preset, broadcast);
  const entry = zone[playerId];
  if (entry) {
    entry.fadeTargetVolume = preset.tts ?? preset.default ?? entry.playerEntry.defaultVolume ?? entry.playerEntry.volume ?? 0;
  }
  return preset;
}

export {
  setupZones,
  setupZoneById,
  sendCommandToZone,
  sendGroupCommandToZone,
  updateZonePlayerStatus,
  updateZonePlayerName,
  updateZoneQueue,
  updateZoneGroup,
  applyMasterVolumeToGroup,
  getZoneById,
  findZoneByBackendPlayerId,
  cleanupZones,
  getZoneStatuses,
  applyStoredVolumePreset,
  applyVolumePresetToZone,
  updateZoneFadeTarget,
};

export { mergeZoneConfigEntries } from './zoneConfigUtils';
function updateZoneFadeTarget(playerId: number): void {
  const entry = zone[playerId];
  if (!entry) return;
  const preset = getStoredVolumePreset(playerId);
  const fallback = Number.isFinite(entry.playerEntry?.defaultVolume)
    ? Number(entry.playerEntry.defaultVolume)
    : Number(entry.playerEntry?.volume ?? 0);

  if (preset?.tts !== undefined) {
    entry.fadeTargetVolume = preset.tts;
  } else if (preset?.default !== undefined) {
    entry.fadeTargetVolume = preset.default;
  } else {
    entry.fadeTargetVolume = fallback;
  }
}
