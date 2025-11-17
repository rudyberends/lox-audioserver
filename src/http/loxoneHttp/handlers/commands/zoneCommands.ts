/**
 * -----------------------------------------------------------------------------
 * Zone Command Handlers
 * -----------------------------------------------------------------------------
 * These handlers implement the HTTP endpoints related to zones, playback,
 * queues, and favorites. They perform only lightweight request parsing and
 * delegate all logic to backend modules:
 *
 *   - runtime/zones/zoneRuntime  ← nieuwe runtime zone layer
 *   - backend/local/favorites/favoritesService
 *
 * Each function returns its response in the exact Loxone-compatible format
 * expected by the MiniServer.
 * -----------------------------------------------------------------------------
 */

import { CommandResult, response, emptyCommand } from '../requestHandler';
import { splitUrl, parseNumberPart, decodeSegment } from './utils/commandUtils';
import { zoneRuntime, zoneStateStore } from '@/runtime/zones';
import { providerRuntime } from '@/runtime/provider';
import logger from '@/utils/troxorLogger';
import { broadcastMessage } from '../../websocketManager';
import { RecentResponse } from '@/core/types/content';

/* -------------------------------------------------------------------------- */
/*  Zone status & queue                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Returns the current playback and connection state for a specific zone.
 * Example: /audioGetStatus/<zoneId>
 */
export function audioGetStatus(url: string): CommandResult {
  const parts = splitUrl(url);
  const zoneId = parseNumberPart(parts[1], 0);
  const payload = zoneRuntime.getZoneState(zoneId);
  return response(url, 'status', [payload]);
}

/**
 * Returns the current queue for a specific zone.
 * Example: /audioCfgGetQueue/<zoneId>
 */
/**
 * -----------------------------------------------------------------------------
 * audioCfgGetQueue
 * -----------------------------------------------------------------------------
 * Handles requests like: /audio/<zoneId>/getqueue/<start>/<count>
 *
 * Returns the current playback queue for a specific zone, matching
 * the original AudioServer schema expected by Loxone clients.
 * -----------------------------------------------------------------------------
 */
export function audioCfgGetQueue(url: string) {
  const parts = splitUrl(url);
  const zoneId = parseNumberPart(parts[1], 0);
  const start = parseNumberPart(parts[3], 0);
  const limit = parseNumberPart(parts[4], 50);

  const state = zoneStateStore.get(zoneId);
  const queue = state.queue;

  if (!queue || !Array.isArray(queue.items)) {
    logger.info(`[audioCfgGetQueue] Zone ${zoneId}: no queue found`);
    const payload = buildEmptyQueue(zoneId);
    return response(url, 'getqueue', [payload]);
  }

  const total = queue.totalitems ?? queue.items.length;
  const slice = queue.items.slice(start, start + limit);

  logger.info(
    `[audioCfgGetQueue] Zone ${zoneId}: returning ${slice.length}/${total} items (shuffle=${queue.shuffle})`,
  );

  const payload = {
    id: queue.id,
    items: slice,
    shuffle: queue.shuffle,
    start,
    totalitems: total,
  };

  return response(url, 'getqueue', [payload]);
}

/** Builds a valid but empty queue response. */
function buildEmptyQueue(zoneId: number) {
  return {
    id: zoneId,
    items: [],
    shuffle: false,
    start: 0,
    totalitems: 0,
  };
}

/**
 * Returns the list of players currently synced (grouped) with a given zone.
 * Example: /audioCfgGetSyncedPlayers/<zoneId>
 */
export function audioCfgGetSyncedPlayers(url: string): CommandResult {
  //const parts = splitUrl(url);
  //const zoneId = parseNumberPart(parts[1], 0);
  return response(url, 'getsyncedplayers', [{ items: [] }]);
}

/**
 * Returns or clears the "recently played" list for a zone.
 * Example: /audio/14/recent/50       → get 50 items
 *          /audio/14/recent/clear    → clear list
 */
export async function audioRecent(url: string): Promise<CommandResult> {
  const parts = splitUrl(url);
  const zoneId = parseNumberPart(parts[1], 0);
  const action = (parts[2] ?? '').toLowerCase();
  const paramRaw = parts[3];
  const isClear = (paramRaw ?? '').toLowerCase() === 'clear';
  const limit = !isClear ? parseNumberPart(paramRaw, 50) : 50;

  const state = zoneStateStore.get(zoneId);
  if (state) {
    const payload = JSON.stringify({ audio_event: [state] });
    broadcastMessage(payload);
  }

  if (action !== 'recent') {
    logger.warn(`[audioRecent] Unexpected action "${action}" for zone ${zoneId}`);
  }

  if (isClear && providerRuntime.isActive()) {
    try {
      await providerRuntime.clearRecentlyPlayed(zoneId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[audioRecent] Failed to clear recently played items: ${message}`);
    }
  }

  let payload: RecentResponse | undefined;
  if (providerRuntime.isActive()) {
    try {
      payload = await providerRuntime.getRecentlyPlayed(zoneId, limit);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[audioRecent] Failed to load recently played items: ${message}`);
    }
  }

  //const normalized = normalizeRecentResponse(payload);
  return response(url, 'recent', payload);
}

/** Plays a playlist in a zone, optionally with shuffle. */
export async function audioPlaylistPlay(url: string): Promise<CommandResult> {
  const parts = splitUrl(url);
  const zoneId = parseNumberPart(parts[1], 0);
  const playlistPath = decodeSegment(parts.slice(4).join('/'));
  const shuffle = url.toLowerCase().includes('shuffle');
  await zoneRuntime.sendZoneCommand(zoneId, 'playlistplay', [playlistPath, String(shuffle)]);
  return response(url, 'playlistplay', [{ zoneId, playlistPath, shuffle }]);
}

/** Plays a track or album from the local library. */
export async function audioLibraryPlay(url: string): Promise<CommandResult> {
  const parts = splitUrl(url);
  const zoneId = parseNumberPart(parts[1], 0);
  const path = decodeSegment(parts.slice(4).join('/'));
  const shuffle = url.toLowerCase().includes('shuffle');
  await zoneRuntime.sendZoneCommand(zoneId, 'libraryplay', [path, String(shuffle)]);
  return response(url, 'libraryplay', [{ zoneId, path, shuffle }]);
}

/** Plays a station, stream, or service item. */
export async function audioServicePlay(url: string): Promise<CommandResult> {
  const parts = splitUrl(url);
  const zoneId = parseNumberPart(parts[1], 0);
  const service = decodeSegment(parts[3]);
  let stationId = decodeSegment(parts.slice(4).join('/'));

  if (stationId.startsWith('nouser/')) {
    stationId = stationId.slice('nouser/'.length);
  }

  await zoneRuntime.sendZoneCommand(zoneId, 'serviceplay', [stationId, 'false']);
  return response(url, 'serviceplay', [{ zoneId, service, stationId, shuffle: false }]);
}

/** Plays any arbitrary playurl (used by clients for testing or non-library content). */
export async function audioPlayUrl(url: string): Promise<CommandResult> {
  const parts = splitUrl(url);
  const zoneId = parseNumberPart(parts[1], 0);
  const playUrl = decodeSegment(parts.slice(3).join('/'));
  await zoneRuntime.sendZoneCommand(zoneId, 'playurl', playUrl);
  return response(url, 'playurl', [{ zoneId, playUrl }]);
}

/** Handles dynamic zone control commands like volume, pause, stop, etc. */
export function audioDynamicCommand(url: string): CommandResult {
  const parts = splitUrl(url);
  const zoneId = parseNumberPart(parts[1], 0);
  const command = parts[2];
  const param = parts.slice(3).join('/');
  zoneRuntime.sendZoneCommand(zoneId, command, param);
  return emptyCommand(url, []);
}
