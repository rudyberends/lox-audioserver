/**
 * Audio configuration command handlers for the Loxone AudioServer emulation.
 *
 * These endpoints mimic the behavior of the genuine AudioServer firmware
 * when the MiniServer (or app) sends configuration, pairing, or volume data.
 * Responses are deliberately shaped to allow official clients to continue
 * through their pairing and configuration flow without cryptographic validation.
 *
 * Each handler corresponds to a `/audioCfg*` command and is registered
 * in the `LoxoneRouter` during startup.
 */

import NodeRSA from 'node-rsa';
import { CommandResult, emptyCommand, response } from '../requestHandler';
import { decodeBase64Segment, safeJsonParse } from './utils/commandUtils';
import { configManager, audioServerRuntime, zoneRuntime, getAudioServerConfig, systemRuntime } from '@/runtime';
import logger from '@/utils/troxorLogger';

/* -------------------------------------------------------------------------- */
/*  Utility helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Shared RSA key used for Loxone key exchange endpoints.
 * Created once on module load to avoid regenerating expensive keys per request.
 */
const rsaKey = new NodeRSA({ b: 2048 });
rsaKey.setOptions({ encryptionScheme: 'pkcs1' });

/* -------------------------------------------------------------------------- */
/*  Command handlers                                                          */
/* -------------------------------------------------------------------------- */

/** Initial handshake confirmation: `/audioCfgReady` */
export function audioCfgReady(url: string): CommandResult {
  return emptyCommand(url, { session: 547541322864 });
}

/**
 * Returns the CRC and extension list for the current AudioServer configuration.
 * Used by the MiniServer to verify configuration sync.
 */
export function audioCfgGetConfig(url: string): CommandResult {
  const audio = getAudioServerConfig()!;
  return emptyCommand(url, {
    crc32: audio.musicCrc ?? null,
    extensions: audio.extensions ?? [],
  });
}

/** Returns public RSA key for legacy firmware calls: `/audioCfgGetKey` */
export function audioCfgGetKey(url: string): CommandResult {
  const pub = rsaKey.exportKey('components-public') as { n: Buffer; e: number };
  return emptyCommand(url, [{ pubkey: pub.n.toString('hex'), exp: pub.e }]);
}

/** Returns PEM-encoded public key variant: `/audioCfgGetKeyFull` */
export function audioCfgGetKeyFull(url: string): CommandResult {
  const pem = rsaKey.exportKey('pkcs8-public-pem');
  return response(url, 'getkey', [{ pubkey: pem }]);
}

/** Acknowledges AudioServer identification: `/audioCfgIdentify` */
export function audioCfgIdentify(url: string): CommandResult {
  return emptyCommand(url, []);
}

/** Confirms MiniServer → AudioServer time synchronization. */
export function audioCfgMiniserverTime(url: string): CommandResult {
  return emptyCommand(url, true);
}

/** Handles speaker type configuration from the AudioServer.
 * Currently not used by the runtime. */
export function audioCfgSpeakerType(url: string): CommandResult {
  return emptyCommand(url, []);
}

/** Handles group options configuration from the AudioServer.
 * Currently not used by the runtime. */
export function audioCfgGroupOpts(url: string): CommandResult {
  return emptyCommand(url, []);
}

/** Handles presence mode configuration from the AudioServer.
 * Currently not used by the runtime. */
export function audioCfgPresenceMode(url: string): CommandResult {
  return emptyCommand(url, []);
}

/** Handles network configuration (IP, gateway, DNS) from the AudioServer.
 * Currently not used by the runtime. */
export function audioCfgMiniServerIp(url: string): CommandResult {
  return emptyCommand(url, []);
}

/** Handles miniserver firmware and AudioServer version information.
 * Currently not used by the runtime. */
export function audioCfgMiniServerVersion(url: string): CommandResult {
  return emptyCommand(url, []);
}

/** Handles timezone configuration from the AudioServer.
 * Currently not used by the runtime. */
export function audioCfgTimeZone(url: string): CommandResult {
  return emptyCommand(url, []);
}

/** Restart audioserver requested from Loxone. */
export function audioCfgRestart(url: string): CommandResult {
  logger.info('[configCommands] MiniServer Requested a reboot.');
  systemRuntime.reload();
  return emptyCommand(url, true);
}

/**
 * Accepts and processes a Base64-encoded audio configuration payload from the MiniServer.
 * Updates CRC, extensions, and persisted AudioServer configuration.
 *
 * Example: `/audioCfgSetConfig/<base64payload>`
 */
export async function audioCfgSetConfig(url: string): Promise<CommandResult> {
  const encoded = url.split('/')[3];
  if (!encoded) {
    logger.warn('[configCommands] Missing AudioServer config payload.');
    return response(url, 'setconfig', { success: false, error: 'missing-payload' });
  }

  try {
    const decoded = decodeURIComponent(encoded);
    const jsonStr = decodeBase64Segment(decoded);

    logger.info('[configCommands] Received new AudioServer configuration from MiniServer.');
    await audioServerRuntime.processIncomingConfig(jsonStr);

    // Success → report CRC and status to Loxone
    const audio = getAudioServerConfig()!;
    return response(url, 'setconfig', {
      success: true,
      crc32: audio.musicCrc ?? null,
      name: audio.name ?? 'Unknown',
      ip: audio.ip ?? '0.0.0.0',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[configCommands] Failed to process AudioServer config: ${msg}`);
    return response(url, 'setconfig', { success: false, error: 'invalid-config' });
  }
}

/**
 * Stores the MiniServer-supplied configuration timestamp for future sync checks.
 * Example: `/audioCfgSetConfigTimestamp/<timestamp>`
 */
export async function audioCfgSetConfigTimestamp(url: string): Promise<CommandResult> {
  const ts = Number(url.split('/')[3]);
  if (!Number.isFinite(ts)) {
    logger.warn(`[configCommands] Invalid timestamp payload: ${url}`);
    return response(url, 'setconfigtimestamp', { success: false, error: 'invalid-timestamp' });
  }

  try {
    const audio = getAudioServerConfig()!;
    const updated = { ...audio, lastUpdate: ts };
    configManager.update({ audioserver: updated });
    await configManager.save();

    logger.info(`[configCommands] Updated AudioServer timestamp to ${ts}`);
    return response(url, 'setconfigtimestamp', {
      success: true,
      timestamp: ts,
      crc32: updated.musicCrc ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[configCommands] Failed to update timestamp: ${msg}`);
    return response(url, 'setconfigtimestamp', { success: false, error: 'internal-error' });
  }
}

/**
 * Applies volume presets sent by the MiniServer.
 * Payload is Base64-encoded JSON describing zone volumes.
 */
export async function audioCfgSetVolumes(url: string): Promise<CommandResult> {
  const encoded = url.split('/')[3];
  if (!encoded) {
    logger.warn('[configCommands] Missing volume payload.');
    return response(url, 'volumes', { success: false, error: 'missing-payload' });
  }

  try {
    const decoded = decodeURIComponent(encoded);
    const jsonStr = decodeBase64Segment(decoded);
    const parsed = safeJsonParse<{ players?: Array<Record<string, unknown>> }>(jsonStr);

    if (!parsed?.players?.length) {
      throw new Error('Missing or invalid "players" array');
    }

    let successCount = 0;
    for (const player of parsed.players) {
      const zoneId = Number(player.playerid ?? player.id);
      if (!Number.isFinite(zoneId) || zoneId <= 0) {
        continue;
      }

      const partial = { ...player };
      delete partial.playerid;
      delete partial.id;

      const sanitized = await zoneRuntime.setZoneEventVolumes(zoneId, partial);
      if (sanitized) {
        successCount++;
      }
    }

    logger.info(`[configCommands] Applied volume presets for ${successCount}/${parsed.players.length} zones.`);
    return response(url, 'volumes', { success: true, players: successCount });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[configCommands] Failed to apply volume presets: ${msg}`);
    return response(url, 'volumes', { success: false, error: 'invalid-volume-payload' });
  }
}

/** Sets the default volume for a specific zone: `/audioCfgSetDefaultVolume/<zone>/<value>` */
export function audioCfgSetDefaultVolume(url: string): CommandResult {
  const [, , , zoneIdStr, valueStr] = url.split('/');
  const zoneId = Number(zoneIdStr);
  const value = Number(valueStr);

  if (!Number.isFinite(zoneId) || !Number.isFinite(value)) {
    logger.warn(`[configCommands] Invalid parameters for setDefaultVolume: ${url}`);
    return response(url, 'setdefaultvolume', { success: false, error: 'invalid-parameters' });
  }

  try {
    const sanitized = zoneRuntime.setZoneEventVolumes(zoneId, { default: value });
    if (!sanitized) {
      throw new Error('Unknown zone or invalid volume data');
    }

    logger.info(`[configCommands] Zone ${zoneId} default volume set to ${value}.`);
    return response(url, 'setdefaultvolume', { success: true, value });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[configCommands] Failed to set default volume: ${msg}`);
    return response(url, 'setdefaultvolume', { success: false, error: 'update-failed' });
  }
}

/** Sets the max volume limit for a zone: `/audioCfgSetMaxVolume/<zone>/<value>` */
export function audioCfgSetMaxVolume(url: string): CommandResult {
  const [, , , zoneIdStr, valueStr] = url.split('/');
  const zoneId = Number(zoneIdStr);
  const value = Number(valueStr);

  if (!Number.isFinite(zoneId) || !Number.isFinite(value)) {
    logger.warn(`[configCommands] Invalid parameters for setMaxVolume: ${url}`);
    return response(url, 'setmaxvolume', { success: false, error: 'invalid-parameters' });
  }

  try {
    const sanitized = zoneRuntime.setZoneEventVolumes(zoneId, { max: value });
    if (!sanitized) {
      throw new Error('Unknown zone or invalid volume data');
    }

    logger.info(`[configCommands] Zone ${zoneId} max volume set to ${value}.`);
    return response(url, 'setmaxvolume', { success: true, value });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[configCommands] Failed to set max volume: ${msg}`);
    return response(url, 'setmaxvolume', { success: false, error: 'update-failed' });
  }
}

/**
 * Sets event-specific volumes (alarm, fire, TTS, etc.) for a given zone.
 * Example: `/audioCfgSetEventVolumes/<zone>/<base64-json>`
 */
export function audioCfgSetEventVolumes(url: string): CommandResult {
  const encoded = url.split('/')[3];
  if (!encoded) {
    logger.warn('[configCommands] Missing event volume payload.');
    return response(url, 'seteventvolumes', { success: false, error: 'missing-payload' });
  }

  try {
    const decoded = decodeURIComponent(encoded);
    const jsonStr = decodeBase64Segment(decoded);
    const parsed = safeJsonParse<Record<string, unknown>>(jsonStr);

    if (!parsed || typeof parsed.playerid !== 'number') {
      throw new Error('Invalid or missing playerid in payload');
    }

    const zoneId = parsed.playerid;
    const partial = { ...parsed };
    delete partial.playerid;

    const sanitized = zoneRuntime.setZoneEventVolumes(zoneId, partial);
    if (!sanitized) {
      throw new Error(`Unknown zone or invalid data for zone ${zoneId}`);
    }

    logger.info(`[configCommands] Updated event volumes for zone ${zoneId}.`);
    return response(url, 'seteventvolumes', { success: true, zone: zoneId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[configCommands] Failed to apply event volumes: ${msg}`);
    return response(url, 'seteventvolumes', { success: false, error: 'invalid-payload' });
  }
}

/** Acknowledges player option updates (no-op). */
export function audioCfgSetPlayerOpts(url: string): CommandResult {
  return emptyCommand(url, 'ok');
}

/**
 * Updates zone display names from MiniServer-provided JSON payload.
 * Example: `/audioCfgSetPlayerName/<base64-json>`
 */
export async function audioCfgSetPlayerName(url: string): Promise<CommandResult> {
  const encoded = url.split('/')[3];
  if (!encoded) {
    return response(url, 'playername', { success: false });
  }

  try {
    const decoded = decodeURIComponent(encoded);
    const jsonStr = decodeBase64Segment(decoded);
    const parsed = safeJsonParse<Record<string, unknown>>(jsonStr);
    if (!parsed) {
      throw new Error('Invalid JSON');
    }

    const updates = extractPlayerNameUpdates(parsed);
    logger.debug(`[audioCfgSetPlayerName] Received updates: ${JSON.stringify(updates)}`);

    for (const { playerid, name } of updates) {
      zoneRuntime.updateZoneMetadata(playerid, { name });
      const zones = configManager.getZoneConfigs();
      const updatedZones = zones.map((z) =>
        z.id === playerid ? { ...z, name } : z,
      );

      configManager.update({ zones: updatedZones });
      await configManager.save();
    }

    return response(url, 'playername', { success: true, result: '' });
  } catch (err) {
    logger.error(`[configCommands] Failed to parse playername: ${String(err)}`);
    return response(url, 'playername', { success: false, error: 'invalid-player-payload' });
  }
}

/**
 * Extracts name update entries from various payload shapes.
 */
function extractPlayerNameUpdates(payload: Record<string, unknown>): Array<{ playerid: number; name: string }> {
  const updates: Array<{ playerid: number; name: string }> = [];

  const visit = (item: any): void => {
    if (!item) {
      return;
    }
    const id = Number(item.playerid ?? item.id ?? item.zoneid ?? item.zoneId);
    const name =
      typeof item.name === 'string'
        ? item.name
        : typeof item.title === 'string'
          ? item.title
          : undefined;
    if (Number.isFinite(id) && name) {
      updates.push({ playerid: id, name });
    }
  };

  if (Array.isArray(payload)) {
    payload.forEach(visit);
  } else if (typeof payload === 'object') {
    const players = (payload as any).players ?? (payload as any).player;
    if (Array.isArray(players)) {
      players.forEach(visit);
    } else if (players && typeof players === 'object') {
      Object.values(players).forEach(visit);
    } else {
      visit(payload);
    }
  }

  return updates;
}