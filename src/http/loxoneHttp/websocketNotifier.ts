import logger from '@/utils/troxorLogger';
import { broadcastMessage } from './websocketManager';
import type { ZoneStatePatch } from '@/runtime/zones/types/zoneStateTypes';

/**
 * -----------------------------------------------------------------------------
 * WebSocket Notifier
 * -----------------------------------------------------------------------------
 * Centralized helper for sending AudioServer-style websocket events to clients.
 *
 * Each notifier emits a JSON payload that matches the Loxone AudioServer protocol,
 * allowing the client to update its state immediately (favorites, queue, zone, etc.).
 * -----------------------------------------------------------------------------
 */

/**
 * Broadcasts a `roomfavchanged_event` to notify clients that the
 * list of favorites for a zone has changed.
 *
 * @param zoneId - Numeric zone ID (playerid)
 * @param count - Total number of favorites after the change
 *
 * Example payload:
 * ```json
 * {
 *   "roomfavchanged_event": [{ "playerid": 14, "count": 3 }]
 * }
 * ```
 */
export function notifyRoomFavoritesChanged(zoneId: number, count: number): void {
  const payload = {
    roomfavchanged_event: [
      {
        playerid: Number(zoneId),
        count: Number(count),
      },
    ],
  };

  try {
    broadcastMessage(JSON.stringify(payload));
    logger.debug(`[WebSocketNotifier] Favorites changed for zone ${zoneId} (${count} items)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[WebSocketNotifier] Failed to notify favorites for zone ${zoneId}: ${msg}`);
  }
}

/**
 * Broadcasts an `alert_event` indicating that a system alert
 * (doorbell, alarm, etc.) was triggered.
 *
 * @param type - Alert type identifier (e.g. "doorbell" | "alarm")
 *
 * Example payload:
 * ```json
 * {
 *   "alert_event": [{ "type": "doorbell", "ts": 1730000000000 }]
 * }
 * ```
 */
export function notifyAlertTriggered(type: string): void {
  const payload = {
    alert_event: [
      {
        type,
        ts: Date.now(),
      },
    ],
  };

  try {
    broadcastMessage(JSON.stringify(payload));
    logger.debug(`[WebSocketNotifier] Alert triggered (${type})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[WebSocketNotifier] Failed to notify alert (${type}): ${msg}`);
  }
}

/**
 * Broadcasts an `audio_queue_event` when a zone's playback queue changes.
 * Mirrors the AudioServer's native message format.
 *
 * @param zoneId - Numeric zone ID (playerid)
 * @param queueSize - Total number of items currently in the queue
 *
 * Example payload:
 * ```json
 * {
 *   "audio_queue_event": [
 *     { "playerid": 14, "queuesize": 5, "restrictions": 1 }
 *   ]
 * }
 * ```
 */
export function notifyQueueUpdated(zoneId: number, queueSize: number): void {
  const payload = {
    audio_queue_event: [
      {
        playerid: Number(zoneId),
        queuesize: Number(queueSize),
        restrictions: 1,
      },
    ],
  };

  try {
    broadcastMessage(JSON.stringify(payload));
    logger.debug(`[WebSocketNotifier] Queue updated for zone ${zoneId} (${queueSize} items)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[WebSocketNotifier] Failed to notify queue update for zone ${zoneId}: ${msg}`);
  }
}

/**
 * Broadcasts an `audio_event` when a zone's playback state changes.
 * Mirrors the AudioServer's native message format.
 *
 * @param zoneId - Numeric zone ID (playerid)
 * @param state - Sanitized {@link ZoneState} representing the current player state
 *
 * Example payload:
 * ```json
 * {
 *   "audio_event": [
 *     {
 *       "playerid": 14,
 *       "state": "playing",
 *       "volume": 35,
 *       "title": "Song Title"
 *     }
 *   ]
 * }
 * ```
 */
export function notifyZoneStateChanged(zoneId: number, state: ZoneStatePatch): void {
  const payload = {
    audio_event: [state],
  };

  try {
    broadcastMessage(JSON.stringify(payload));
    //logger.debug(`[WebSocketNotifier] Zone state update sent for zone ${zoneId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[WebSocketNotifier] Failed to notify zone update for zone ${zoneId}: ${msg}`);
  }
}

export function notifyGlobalSearchResult(
  result: Record<string, any>,
  providerId: string,
  unique: string,
): void {
  // --- Handle TuneIn (radio) search separately ---
  if (providerId.toLowerCase() === 'tunein' && result.station) {
    const payload = {
      globalsearch_result: {
        station: {
          caption: 'Zender',
          items: result.station,
          link: `audio/cfg/search/radio/nouser/station/arr/0/${result.station.length}`,
          totalitems: result.station.length,
        },
        custom: {
          caption: 'Eigen radiostations',
          items: result.custom ?? [],
          link: 'audio/cfg/search/radio/nouser/custom/arr/0/0',
          totalitems: result.custom?.length ?? 0,
        },
      },
      type: providerId,
      unique,
    };

    broadcastMessage(JSON.stringify(payload));
    return;
  }

  // --- Default behavior for music providers ---
  const userId = result.user ?? 'nouser';
  const query = result.query ?? '';

  const payload = {
    globalsearch_result: {
      error: 0,
      result: {
        tracks: buildCategory('Titoli', result.tracks, providerId, userId, 'track', query),
        albums: buildCategory('Albums', result.albums, providerId, userId, 'album', query),
        artists: buildCategory('Artiesten', result.artists, providerId, userId, 'artist', query),
        playlists: buildCategory('Playlists', result.playlists, providerId, userId, 'playlist', query),
        shows: buildCategory('Podcasts', result.shows, providerId, userId, 'show', query),
        episodes: buildCategory('Volgen', result.episodes, providerId, userId, 'episode', query),
        topresults: buildTopResults(result),
        user: userId,
      },
    },
    type: providerId,
    unique,
  };

  broadcastMessage(JSON.stringify(payload));
}

/**
 * Broadcasts an error response matching AudioServer format.
 */
export function notifyGlobalSearchError(providerId: string, unique: string): void {
  const payload = {
    globalsearch_result: {
      error: 1,
      type: providerId,
      unique,
    },
  };

  try {
    broadcastMessage(JSON.stringify(payload));
    logger.debug(`[WebSocketNotifier] Global search error (${providerId})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[WebSocketNotifier] Failed to broadcast global search error: ${msg}`);
  }
}

/**
 * Builds a standard search category.
 * Ensures the client always receives all expected fields.
 */
function buildCategory(
  caption: string,
  items: any[] | undefined,
  providerId: string,
  userId: string,
  type: string,
  query: string,
) {
  const list = Array.isArray(items) ? items : [];
  return {
    caption,
    count: list.length, // optional but present in real responses
    items: list,
    link: `audio/cfg/search/${providerId}/${userId}/${type}/${encodeURIComponent(query)}/0/50`,
    totalitems: list.length,
  };
}

/**
 * Builds the "Top results" section.
 */
function buildTopResults(result: Record<string, any>) {
  const top = {
    caption: 'Top resultaten',
    count: 0,
    tracks: result.tracks?.slice(0, 1) ?? [],
    albums: result.albums?.slice(0, 1) ?? [],
    artists: result.artists?.slice(0, 1) ?? [],
    playlists: result.playlists?.slice(0, 1) ?? [],
  };

  top.count =
    top.tracks.length + top.albums.length + top.artists.length + top.playlists.length;

  return top;
}
