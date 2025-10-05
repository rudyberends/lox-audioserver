import { CommandResult, emptyCommand, response } from './requesthandler';
import { parseNumberPart, splitUrl } from './commandUtils';
import { getZoneById, sendCommandToZone } from '../../backend/zone/zonemanager';
import { getMediaProvider } from '../../backend/provider/factory';
import logger from '../../utils/troxorlogger';

/**
 * Return the current status payload for a zone, or an error if the zone is unknown.
 */
export function audioGetStatus(url: string): CommandResult {
  const parts = splitUrl(url);
  const zoneId = parseNumberPart(parts[1], 0);
  const zone = getZoneById(zoneId);

  if (!zone) {
    return emptyCommand(url, { error: 'Zone not found' });
  }

  logger.debug(
    `[audioGetStatus] zone=${zone.player.playerid} backend=${zone.player.backend} ip=${zone.player.ip}`,
  );

  const statusData = [zone.track];
  return response(url, 'status', statusData);
}

/**
 * Provide the queue contents for a zone, defaulting to an empty payload when unknown.
 */
export function audioCfgGetQueue(url: string): CommandResult {
  const parts = splitUrl(url);
  const zoneId = parseNumberPart(parts[1], 0);
  const zone = getZoneById(zoneId);
  if (!zone) {
    return buildEmptyQueue(url, zoneId);
  }

  const queue = (zone as { queue?: unknown }).queue;
  if (!queue) {
    return buildEmptyQueue(url, zoneId);
  }
  return response(url, 'getqueue', [queue]);
}

/**
 * Placeholder endpoint for room favourites; returns an empty structure per zone.
 */
export function audioCfgGetRoomFavs(url: string): CommandResult {
  const parts = splitUrl(url);
  const zoneId = parseNumberPart(parts[3], 0);

  logger.debug(`[audioCfgGetRoomFavs] zone=${zoneId}`);

  return response(url, 'getroomfavs', [
    {
      id: zoneId,
      totalitems: 0,
      start: 0,
      items: [],
    },
  ]);
}

/**
 * Report that no players are currently synced with the requested zone.
 */
export function audioCfgGetSyncedPlayers(url: string): CommandResult {
  logger.debug('[audioCfgGetSyncedPlayers] requested');
  return response(url, 'getsyncedplayers', [{ items: [] }]);
}

/**
 * Handle service play requests by resolving provider metadata and forwarding to the zone.
 */
export async function audioServicePlay(url: string): Promise<CommandResult> {
  const match = url.match(/^audio\/(\d+)\/serviceplay\/([^/]+)\/[^/]+\/(.+)$/);
  const playerId = match ? Number(match[1]) : 0;
  const service = match ? decodeURIComponent(match[2]) : 'local';
  const stationId = match ? decodeURIComponent(match[3]) : '';

  const provider = getMediaProvider();
  logger.debug(
    `[audioServicePlay] provider=${provider.constructor.name} zone=${playerId} service=${service} station=${stationId}`,
  );
  const resolved = provider.resolveStation
    ? await provider.resolveStation(service, stationId)
    : undefined;

  const audiopath = resolved?.audiopath || stationId;

  const payload = resolved || {
    id: stationId,
    name: stationId,
    station: stationId,
    audiopath,
    coverurl: '',
    contentType: 'Playlists',
    sort: '',
    type: 2,
    provider: service,
  };

  const commandPayload = {
    ...payload,
    service,
  };

  if (!Number.isNaN(playerId) && playerId > 0) {
    sendCommandToZone(playerId, 'serviceplay', JSON.stringify(commandPayload));
  }

  return response(url, 'serviceplay', [payload]);
}

/**
 * Resolve playlist information and instruct the zone to start playback.
 */
export async function audioPlaylistPlay(url: string): Promise<CommandResult> {
  const match = url.match(/^audio\/(\d+)\/playlist\/play\/(.+)$/);
  const playerId = match ? Number(match[1]) : 0;
  const playlistId = match ? decodeURIComponent(match[2]) : '';

  const provider = getMediaProvider();
  logger.debug(
    `[audioPlaylistPlay] provider=${provider.constructor.name} zone=${playerId} playlist=${playlistId}`,
  );
  const resolved = provider.resolvePlaylist
    ? await provider.resolvePlaylist('lms', playlistId)
    : undefined;

  const audiopath = resolved?.audiopath || playlistId;

  const payload = resolved || {
    id: playlistId,
    name: playlistId,
    audiopath,
    coverurl: '',
    items: 0,
    type: 11,
    provider: 'lms',
  };

  if (!Number.isNaN(playerId) && playerId > 0) {
    sendCommandToZone(playerId, 'playlistplay', JSON.stringify(payload));
  }

  return response(url, 'playlistplay', [payload]);
}

/**
 * Handle media library playback, delegating item resolution to the provider when available.
 */
export async function audioLibraryPlay(url: string): Promise<CommandResult> {
  const match = url.match(/^audio\/(\d+)\/library\/play\/(.+)$/);
  if (!match) {
    return response(url, 'libraryplay', []);
  }

  const playerId = Number(match[1]);
  const remainder = match[2];
  const segments = remainder.split('/').filter(Boolean);
  const itemId = segments.length > 0 ? decodeURIComponent(segments[0]) : '';

  let parentId = '';
  let shuffle: boolean | undefined;

  const toAlias = (parts: string[]): string => {
    const decoded = parts.map((part) => decodeURIComponent(part)).filter(Boolean);
    if (decoded.length === 0) return '';
    if (decoded.length === 1) return decoded[0];
    const pairs: string[] = [];
    for (let idx = 0; idx < decoded.length; idx += 2) {
      const base = decoded[idx];
      const value = decoded[idx + 1];
      if (value !== undefined) {
        pairs.push(`${base}:${value}`);
      } else {
        pairs.push(base);
      }
    }
    const alias = pairs[pairs.length - 1] ?? decoded[decoded.length - 1];
    const lower = alias.toLowerCase();
    if (lower.startsWith('albums:') && lower !== 'albums:') return 'albums';
    if (lower.startsWith('artists:') && lower !== 'artists:') return 'artists';
    if (lower.startsWith('tracks:') && lower !== 'tracks:') return 'tracks';
    return alias;
  };

  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i].toLowerCase();
    if (segment === 'parentid') {
      const collected: string[] = [];
      let j = i + 1;
      while (j < segments.length) {
        const next = segments[j];
        const lowerNext = next.toLowerCase();
        if (lowerNext === 'shuffle' || lowerNext === 'noshuffle') {
          break;
        }
        collected.push(next);
        j += 1;
      }
      if (collected.length > 0) {
        parentId = toAlias(collected);
      }
      i = j - 1;
      continue;
    }
    if (segment === 'shuffle') {
      shuffle = true;
      continue;
    }
    if (segment === 'noshuffle') {
      shuffle = false;
      continue;
    }
  }

  const provider = getMediaProvider();
  logger.debug(
    `[audioLibraryPlay] provider=${provider.constructor.name} zone=${playerId} item=${itemId} parent=${parentId}`,
  );
  const resolved = provider.resolveMediaItem
    ? await provider.resolveMediaItem(parentId, itemId)
    : undefined;

  if (!resolved) {
    return response(url, 'libraryplay', []);
  }

  const audiopath = resolved.audiopath || resolved.id || itemId;

  if (!audiopath) {
    return response(url, 'libraryplay', []);
  }

  const payload: Record<string, unknown> = {
    id: resolved.id || itemId,
    name: resolved.name || resolved.id || itemId,
    audiopath,
    coverurl: resolved.coverurl ?? '',
    items: resolved.items ?? 0,
    type: resolved.type ?? 3,
    provider: resolved.provider ?? 'library',
  };

  if (shuffle !== undefined) {
    payload['shuffle'] = shuffle ? 1 : 0;
  }

  const isTrack = resolved.tag === 'track' || resolved.contentType === 'Track';

  if (!isTrack) {
    if (resolved.tag === 'album') {
      const rawId = resolved.rawId || resolved.id;
      payload.audiopath =
        resolved.audiopath || (rawId && rawId.startsWith('library://') ? rawId : rawId ? `library://album/${rawId}` : undefined);
    } else if (resolved.tag === 'artist') {
      const rawId = resolved.rawId || resolved.id;
      if (resolved.audiopath) {
        payload.audiopath = resolved.audiopath;
      } else if (rawId) {
        payload.audiopath = rawId.startsWith('library://') ? rawId : `library://artist/${rawId}`;
      } else if (parentId) {
        const base = parentId.toLowerCase().startsWith('artists:') ? parentId.substring('artists:'.length) : parentId;
        payload.audiopath = `library://artist/${base}`;
      } else {
        payload.audiopath = undefined;
      }
    }
  }

  if (!isTrack) {
    logger.debug(
      `[LibraryPlay] Resolved ${resolved.tag} request item=${itemId} parent=${parentId} provider=${payload.provider || 'unknown'}`,
    );
  }

  if (isTrack && !Number.isNaN(playerId) && playerId > 0) {
    sendCommandToZone(playerId, 'playlistplay', JSON.stringify(payload));
  } else if (!isTrack && resolved.tag === 'album' && payload.audiopath && !Number.isNaN(playerId) && playerId > 0) {
    sendCommandToZone(playerId, 'serviceplay', JSON.stringify(payload));
  } else if (!isTrack && resolved.tag === 'artist' && payload.audiopath && !Number.isNaN(playerId) && playerId > 0) {
    sendCommandToZone(playerId, 'serviceplay', JSON.stringify(payload));
  }

  return response(url, 'libraryplay', [payload]);
}

function buildEmptyQueue(url: string, zoneId: number): CommandResult {
  return response(url, 'getqueue', [
    {
      id: zoneId,
      items: [],
      shuffle: false,
      start: 0,
      totalitems: 0,
    },
  ]);
}
