import NodeRSA from 'node-rsa';
import { CommandResult, emptyCommand, response } from './commandTypes';
import {
  config,
  processAudioServerConfig,
  setVolumePresets,
  setZoneDefaultVolume,
  setZoneMaxVolume,
  setZoneEventVolumes,
} from '../../config/config';
import type { ZoneVolumeConfig } from '../../config/config';
import { saveMusicCache } from '../../config/musicCache';
import { asyncCrc32 } from '../../utils/crc32utils';
import logger from '../../utils/troxorlogger';
import { updateZonePlayerName, applyStoredVolumePreset } from '../../backend/zone/zonemanager';
import { extractExtensions } from '../utils/extensions';

/**
 * Shared RSA key used for Loxone key exchange endpoints.
 * Created once on module load to avoid regenerating expensive keys per request.
 */
const rsaKey = new NodeRSA({ b: 2048 });
rsaKey.setOptions({ encryptionScheme: 'pkcs1' });

/**
 * Report that the audio configuration is ready and provide a static session identifier.
 */
export function audioCfgReady(url: string): CommandResult {
  const sessionData = { session: 547541322864 };
  return emptyCommand(url, sessionData);
}

/**
 * Return the CRC and extension list for the current audio configuration.
 */
export function audioCfgGetConfig(url: string): CommandResult {
  const extensions = extractExtensions(config.audioserver?.musicCFG, config.audioserver?.macID);
  const configData = {
    crc32: config.audioserver?.musicCRC,
    //timestamp: config.audioserver?.musicTimestamp ?? null,
    extensions,
  };
  return emptyCommand(url, configData);
}

/**
 * Expose the public RSA key so Loxone clients can encrypt sensitive payloads.
 */
export function audioCfgGetKey(url: string): CommandResult {
  const publicKeyComponents = rsaKey.exportKey('components-public');
  const data = [
    {
      pubkey: publicKeyComponents.n.toString('hex'),
      exp: publicKeyComponents.e,
    },
  ];
  return emptyCommand(url, data);
}

/**
 * Signal the MiniServer that identification succeeded without further payload.
 */
export function audioCfgIdentify(url: string): CommandResult {
  return emptyCommand(url, []);
}

/**
 * Confirm MiniServer time sync requests; legacy behaviour echoes boolean true.
 */
export function audioCfgMiniserverTime(url: string): CommandResult {
  return emptyCommand(url, true);
}

/**
 * Accept updated audio configuration payloads from the client.
 * Decodes the inline base64 blob, updates the runtime config, and echoes the new CRC.
 */
export async function audioCfgSetConfig(url: string): Promise<CommandResult> {
  const parts = url.split('/');
  const encodedPayload = parts[3];

  if (!encodedPayload) {
    logger.warn(`[configCommands] Received audio/cfg/setconfig without payload: ${url}`);
    return response(url, 'setconfig', { success: false });
  }

  try {
    const decodedSegment = decodeURIComponent(encodedPayload);
    const normalizedBase64 = normalizeBase64(decodedSegment);
    const rawConfig = Buffer.from(normalizedBase64, 'base64').toString('utf8');
    const parsedConfig = JSON.parse(rawConfig);
    const crc32 = await asyncCrc32(rawConfig);

    const processed = await processAudioServerConfig(parsedConfig);
    const target = config.audioserver ?? processed ?? null;
    if (target) {
      target.musicCFG = parsedConfig;
      target.musicCRC = crc32;
      target.paired = true;
      config.audioserver = target;
    }

    const responsePayload = {
      crc32,
      extensions: extractExtensions(parsedConfig, config.audioserver?.macID),
    };

    saveMusicCache({ crc32, musicCFG: parsedConfig, timestamp: config.audioserver?.musicTimestamp });

    return response(url, 'setconfig', responsePayload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[configCommands] Failed to process audio/cfg/setconfig payload: ${message}`);
    return response(url, 'setconfig', { success: false, error: 'Invalid configuration payload' });
  }
}

/**
 * Store the MiniServer supplied configuration timestamp so subsequent getconfig
 * calls can prove the cached configuration is up to date.
 */
export function audioCfgSetConfigTimestamp(url: string): CommandResult {
  const parts = url.split('/');
  const timestampSegment = parts[3];

  if (!timestampSegment) {
    logger.warn(`[configCommands] Received audio/cfg/setconfigtimestamp without payload: ${url}`);
    return response(url, 'setconfigtimestamp', { success: false, error: 'Missing timestamp payload' });
  }

  const timestamp = Number(timestampSegment);

  if (!Number.isFinite(timestamp)) {
    logger.warn(`[configCommands] Invalid audio/cfg/setconfigtimestamp payload: ${timestampSegment}`);
    return response(url, 'setconfigtimestamp', { success: false, error: 'Invalid timestamp payload' });
  }

  if (config.audioserver) {
    config.audioserver.musicTimestamp = timestamp;
    if (config.audioserver.musicCFG !== undefined && config.audioserver.musicCRC) {
      saveMusicCache({
        crc32: config.audioserver.musicCRC,
        musicCFG: config.audioserver.musicCFG,
        timestamp,
      });
    }
  }

  return response(url, 'setconfigtimestamp', {
    success: true,
    timestamp,
    crc32: config.audioserver?.musicCRC ?? null,
  });
}

/**
 * Persist volume presets pushed by the MiniServer during pairing.
 * Currently they are acknowledged but not yet applied to local state.
 */
export function audioCfgSetVolumes(url: string): CommandResult {
  const parts = url.split('/');
  const encodedPayload = parts[3];

  if (!encodedPayload) {
    logger.warn(`[configCommands] Received audio/cfg/volumes without payload: ${url}`);
    return response(url, 'volumes', { success: false });
  }

  try {
    const decodedSegment = decodeURIComponent(encodedPayload);
    const normalizedBase64 = normalizeBase64(decodedSegment);
    const rawConfig = Buffer.from(normalizedBase64, 'base64').toString('utf8');
    const parsed = JSON.parse(rawConfig);
    const players = Array.isArray(parsed?.players) ? parsed.players : [];
    const presets = setVolumePresets(players);

    presets.forEach(({ playerid }) => applyStoredVolumePreset(playerid, false));

    return response(url, 'volumes', {
      success: true,
      players: presets.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[configCommands] Failed to parse audio/cfg/volumes payload: ${message}`);
    return response(url, 'volumes', { success: false, error: 'Invalid volume payload' });
  }
}

export function audioCfgSetDefaultVolume(url: string): CommandResult {
  const parts = url.split('/');
  const zoneId = Number(parts[3]);
  const volumeSegment = parts[4];

  if (!Number.isFinite(zoneId) || zoneId <= 0 || volumeSegment === undefined) {
    logger.warn(`[configCommands] Invalid audio/cfg/defaultvolume payload: ${url}`);
    return response(url, 'defaultvolume', { success: false, error: 'invalid-payload' });
  }

  const value = Number(volumeSegment);
  if (!Number.isFinite(value)) {
    logger.warn(`[configCommands] Invalid default volume value: ${volumeSegment}`);
    return response(url, 'defaultvolume', { success: false, error: 'invalid-volume' });
  }

  const sanitized = setZoneDefaultVolume(zoneId, value);
  if (!sanitized || sanitized.default === undefined) {
    return response(url, 'defaultvolume', { success: false, error: 'unable-to-store' });
  }

  applyStoredVolumePreset(zoneId, true);

  return response(url, 'defaultvolume', {
    success: true,
    zone: zoneId,
    default: sanitized.default,
  });
}

export function audioCfgSetMaxVolume(url: string): CommandResult {
  const parts = url.split('/');
  const zoneId = Number(parts[3]);
  const volumeSegment = parts[4];

  if (!Number.isFinite(zoneId) || zoneId <= 0 || volumeSegment === undefined) {
    logger.warn(`[configCommands] Invalid audio/cfg/maxvolume payload: ${url}`);
    return response(url, 'maxvolume', { success: false, error: 'invalid-payload' });
  }

  const value = Number(volumeSegment);
  if (!Number.isFinite(value)) {
    logger.warn(`[configCommands] Invalid max volume value: ${volumeSegment}`);
    return response(url, 'maxvolume', { success: false, error: 'invalid-volume' });
  }

  const sanitized = setZoneMaxVolume(zoneId, value);
  if (!sanitized || sanitized.max === undefined) {
    return response(url, 'maxvolume', { success: false, error: 'unable-to-store' });
  }

  applyStoredVolumePreset(zoneId, true);

  return response(url, 'maxvolume', {
    success: true,
    zone: zoneId,
    max: sanitized.max,
  });
}

export function audioCfgSetEventVolumes(url: string): CommandResult {
  const parts = url.split('/');
  const zoneId = Number(parts[3]);
  const encodedPayload = parts.slice(4).join('/');

  if (!Number.isFinite(zoneId) || zoneId <= 0 || !encodedPayload) {
    logger.warn(`[configCommands] Invalid audio/cfg/eventvolumes payload: ${url}`);
    return response(url, 'eventvolumes', { success: false, error: 'invalid-payload' });
  }

  try {
    const decodedSegment = decodeURIComponent(encodedPayload);
    const normalizedBase64 = normalizeBase64(decodedSegment);
    const rawConfig = Buffer.from(normalizedBase64, 'base64').toString('utf8');
    const parsed = JSON.parse(rawConfig);

    const partial: Partial<ZoneVolumeConfig> = {
      alarm: parsed?.general ?? parsed?.alarm,
      fire: parsed?.fire,
      bell: parsed?.bell,
      buzzer: parsed?.buzzer ?? parsed?.clock,
      tts: parsed?.tts,
    };

    const sanitized = setZoneEventVolumes(zoneId, partial);
    if (!sanitized) {
      return response(url, 'eventvolumes', { success: false, error: 'unable-to-store' });
    }

    applyStoredVolumePreset(zoneId, true);

    return response(url, 'eventvolumes', {
      success: true,
      zone: zoneId,
      volumes: sanitized,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[configCommands] Failed to parse audio/cfg/eventvolumes payload: ${message}`);
    return response(url, 'eventvolumes', { success: false, error: 'invalid-volume-payload' });
  }
}

/**
 * Acknowledge player option updates coming from the MiniServer pairing flow.
 */
export function audioCfgSetPlayerOpts(url: string): CommandResult {
  return emptyCommand(url, 'ok');
}

/**
 * Update zone display names from the MiniServer provided payload.
 */
export function audioCfgSetPlayerName(url: string): CommandResult {
  const parts = url.split('/');
  const encodedPayload = parts[3];

  if (!encodedPayload) {
    logger.warn(`[configCommands] Received audio/cfg/playername without payload: ${url}`);
    return response(url, 'playername', { success: false });
  }

  let decodedJson: unknown;
  try {
    const decodedSegment = decodeURIComponent(encodedPayload);
    const normalizedBase64 = normalizeBase64(decodedSegment);
    const rawConfig = Buffer.from(normalizedBase64, 'base64').toString('utf8');
    decodedJson = JSON.parse(rawConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[configCommands] Failed to parse audio/cfg/playername payload: ${message}`);
    return response(url, 'playername', { success: false, error: 'Invalid player name payload' });
  }

  const updates = extractPlayerNameUpdates(decodedJson);
  let applied = 0;
  for (const update of updates) {
    if (updateZonePlayerName(update.playerid, update.name)) {
      applied += 1;
    }
  }

  return response(url, 'playername', { success: true, updated: applied });
}

function extractPlayerNameUpdates(payload: unknown): Array<{ playerid: number; name: string }> {
  const updates: Array<{ playerid: number; name: string }> = [];

  const visitCandidate = (candidate: any) => {
    if (!candidate) return;
    const id = Number(candidate.playerid ?? candidate.id ?? candidate.playerID ?? candidate.zoneid ?? candidate.zoneId);
    const name = typeof candidate.name === 'string' ? candidate.name : typeof candidate.title === 'string' ? candidate.title : undefined;
    if (Number.isFinite(id) && name) {
      updates.push({ playerid: id, name });
    }
  };

  if (Array.isArray(payload)) {
    payload.forEach(visitCandidate);
    return updates;
  }

  if (payload && typeof payload === 'object') {
    const records = (payload as Record<string, unknown>)['players'] ?? (payload as Record<string, unknown>)['player'];
    if (Array.isArray(records)) {
      records.forEach(visitCandidate);
    } else if (records && typeof records === 'object') {
      Object.values(records).forEach(visitCandidate);
    } else {
      visitCandidate(payload);
    }
  }

  return updates;
}

function normalizeBase64(input: string): string {
  const restored = input.replace(/-/g, '+').replace(/_/g, '/');
  const paddingNeeded = (4 - (restored.length % 4 || 4)) % 4;
  return restored.padEnd(restored.length + paddingNeeded, '=');
}

/**
 * Provide the PEM-encoded public key for clients expecting the newer format.
 */
export function audioCfgGetKeyFull(url: string): CommandResult {
  const pem = rsaKey.exportKey('pkcs8-public-pem');
  const data = [
    {
      pubkey: pem,
    },
  ];
  return response(url, 'getkey', data);
}
