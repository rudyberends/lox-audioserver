import { CommandResult, emptyCommand, response } from './commandTypes';
import { parseNumberPart, splitUrl } from './commandUtils';
import { applyStoredVolumePreset, getZoneById, sendCommandToZone } from '../../backend/zone/zonemanager';
import { getMediaProvider } from '../../backend/provider/factory';
import { toPlaylistCommandUri } from '../../backend/provider/musicAssistant/utils';
import {
  addRoomFavorite,
  copyRoomFavorites,
  deleteRoomFavorite,
  setRoomFavoritesID,
  getRoomFavorites,
  getRoomFavoriteForPlayback,
  reorderRoomFavorites,
} from '../../backend/local/favorites/favoritesService';
import logger from '../../utils/troxorlogger';
import { MediaFolderItem, PlaylistItem, FavoriteResponse, RecentResponse } from '../../backend/provider/types';
import { FileType } from '../../backend/zone/loxoneTypes';
import {
  parseFadeOptions,
  clampFadeDuration,
  clampVolume,
  cancelFade,
  scheduleFade,
  DEFAULT_FADE_DURATION_MS,
  FadeController,
  FadeSnapshot,
} from '../utils/fade';

const favoriteFadeState = new Map<number, FadeSnapshot>();
const favoriteFadeControllers = new Map<string, FadeController>();

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

  const statusData = [zone.playerEntry];
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
 * Load room favorites for the active media provider.
 */
export async function audioCfgGetRoomFavs(url: string): Promise<CommandResult> {
  const parts = splitUrl(url);
  const zoneId = parseNumberPart(parts[3], 0);
  const start = parseNumberPart(parts[4], 0);
  const limit = parseNumberPart(parts[5], 50);

  logger.debug(`[audioCfgGetRoomFavs] zone=${zoneId} offset=${start} limit=${limit}`);

  try {
    const favorites = await getRoomFavorites(zoneId, start, limit);
    const normalized = normalizeFavoriteResponse(favorites, zoneId, start);
    return response(url, 'getroomfavs', [normalized]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[audioCfgGetRoomFavs] Failed to load favorites: ${message}`);
  }

  return response(url, 'getroomfavs', [
    normalizeFavoriteResponse(undefined, zoneId, start),
  ]);
}

/**
 * Handle room favorite mutations (add, delete, reorder, copy, setplus).
 */
export async function audioCfgRoomFavs(url: string): Promise<CommandResult> {
  const [,,, zoneStr, actionRaw, ...rest] = splitUrl(url);
  const zoneId = parseNumberPart(zoneStr, 0);
  const action = (actionRaw ?? '').toLowerCase();

  try {
    switch (action) {
      case 'add': {
        const title = decodeSegment(rest[0]);
        const encodedId = rest.slice(1).join('/');
        const id = await addRoomFavorite(zoneId, title, encodedId);
        return response(url, 'roomfavs_add', { id, name: title });
      }

      case 'delete': {
        if (!rest[0]) return response(url, 'roomfavs_delete_result', { error: 'missing-id' });
        await deleteRoomFavorite(zoneId, rest[0]);
        const id = Number(rest[0]);
        return response(url, 'roomfavs_delete', { delete_id: id });
      }

      case 'reorder': {
        const order = (rest[0] ?? '')
          .split(',')
          .map(v => v.trim())
          .filter(Boolean)
          .join(',');
        await reorderRoomFavorites(zoneId, order.split(',').map(Number));
        return response(url, 'roomfavs_reorder', order);
      }

      case 'copy': {
        const destinations = (rest[0] ?? '')
          .split(',')
          .map(Number)
          .filter(v => v > 0);
        await copyRoomFavorites(zoneId, destinations);
        return response(url, 'roomfavs_copy', 'ok');
      }
      case 'setid': {
        const oldId = Number(rest[0]);
        const newId = Number(rest[1]);
        await setRoomFavoritesID(zoneId, oldId, newId);
        return response(url, 'roomfavs_set', 'ok');
      }

      default:
        return response(url, 'roomfavs_error', {});
    }
  } catch (e) {
    return response(url, 'roomfavs_error', {});
  }
}

/**
 * Report that no players are currently synced with the requested zone.
 */
export function audioCfgGetSyncedPlayers(url: string): CommandResult {
  logger.debug('[audioCfgGetSyncedPlayers] requested');
  return response(url, 'getsyncedplayers', [{ items: [] }]);
}

/**
 * Retrieve or clear the recently played list for a zone.
 */
export async function audioRecent(url: string): Promise<CommandResult> {
  const segments = splitUrl(url);
  const zoneId = parseNumberPart(segments[1], 0);
  const action = (segments[2] ?? '').toLowerCase();
  const maybeParam = segments[3];
  const isClear = (maybeParam ?? '').toLowerCase() === 'clear';
  const limit = !isClear && maybeParam !== undefined ? parseNumberPart(maybeParam, 50) : 50;

  logger.debug(
    `[audioRecent] zone=${zoneId} action=${action}${isClear ? ' clear' : ''} limit=${limit}`,
  );

  const provider = getMediaProvider();

  if (isClear && typeof provider.clearRecentlyPlayed === 'function') {
    try {
      await provider.clearRecentlyPlayed(zoneId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[audioRecent] Failed to clear recently played items: ${message}`);
    }
  }

  let payload: RecentResponse | undefined;
  if (typeof provider.getRecentlyPlayed === 'function') {
    try {
      payload = await provider.getRecentlyPlayed(zoneId, limit);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[audioRecent] Failed to load recently played items: ${message}`);
    }
  }

  return response(url, 'recent', normalizeRecentResponse(payload));
}

/**
 * Handle service play requests by resolving provider metadata and forwarding to the zone.
 */
export async function audioServicePlay(url: string): Promise<CommandResult> {
  const match = url.match(/^audio\/(\d+)\/serviceplay\/([^/]+)\/[^/]+\/(.+)$/);
  const playerId = match ? Number(match[1]) : 0;
  const service = match ? decodeURIComponent(match[2]) : 'local';
  const stationId = match ? decodeURIComponent(match[3]) : '';
  const cleanStationId = stationId.replace(/\/(?:no)?shuffle$/i, '');

  const provider = getMediaProvider();
  logger.debug(
    `[audioServicePlay] provider=${provider.constructor.name} zone=${playerId} service=${service} station=${stationId}`,
  );
  const resolved = provider.resolveStation
    ? await provider.resolveStation(service, stationId)
    : undefined;

  const audiopath = resolved?.audiopath || cleanStationId;

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
  const rawPlaylist = match ? match[2] : '';
  const [pathWithoutQuery, queryString = ''] = rawPlaylist.split('?', 2);
  const { base: basePlaylist, meta } = splitCommandPath(pathWithoutQuery);
  const canonicalPlaylist = decodeURIComponent(basePlaylist);
  const queryParams = new URLSearchParams(queryString);
  const startItemFromQuery = queryParams.get('item') ?? queryParams.get('track');
  const playlistIdFromQuery = queryParams.get('playlistId');
  const shuffleToken = meta.find((segment) => {
    const lower = segment.toLowerCase();
    return lower === 'shuffle' || lower === 'noshuffle';
  });

  const syntheticLocalMatch = canonicalPlaylist.match(/^library:local:track:([^:]+):(.+)$/i);
  if (syntheticLocalMatch) {
    const providerKey = syntheticLocalMatch[1];
    const trackId = syntheticLocalMatch[2];
    const commandPayload: Record<string, unknown> = {
      id: trackId,
      name: trackId,
      audiopath: canonicalPlaylist,
      coverurl: '',
      provider: providerKey,
      providerInstanceId: providerKey,
      playlistCommandUri: canonicalPlaylist,
      playlistId: canonicalPlaylist,
    };
    if (startItemFromQuery) {
      commandPayload.start_item = startItemFromQuery;
    }

    await sendCommandToZone(playerId, 'playlistplay', JSON.stringify(commandPayload));

    const responsePayload: Record<string, unknown> = {
      id: trackId,
      name: trackId,
      audiopath: canonicalPlaylist,
      coverurl: '',
      items: 1,
      type: FileType.Playlist,
      provider: providerKey,
      playlistId: canonicalPlaylist,
    };
    if (shuffleToken) {
      responsePayload.shuffle = shuffleToken.toLowerCase() === 'shuffle' ? 1 : 0;
    }
    return response(url, 'playlistplay', [responsePayload]);
  }

  const provider = getMediaProvider();
  logger.debug(
    `[audioPlaylistPlay] provider=${provider.constructor.name} zone=${playerId} playlist=${canonicalPlaylist}`,
  );
  const hostArg = (() => {
    if (canonicalPlaylist.includes('://')) {
      return canonicalPlaylist.split('://', 1)[0];
    }
    if (canonicalPlaylist.includes(':')) {
      return canonicalPlaylist.split(':', 1)[0];
    }
    return 'musicassistant';
  })();
  const resolved = provider.resolvePlaylist
    ? await provider.resolvePlaylist(hostArg, canonicalPlaylist)
    : undefined;

  const cover =
    resolved?.coverurlHighRes ??
    resolved?.coverurl ??
    resolved?.thumbnail ??
    '';
  const providerHint = resolved?.provider ?? hostArg;

  const responseAudiopath = queryString ? `${canonicalPlaylist}?${queryString}` : canonicalPlaylist;

  const responsePayload: Record<string, unknown> = {
    id: resolved?.id ?? canonicalPlaylist,
    name: resolved?.name ?? canonicalPlaylist,
    audiopath: responseAudiopath,
    coverurl: cover,
    items: resolved?.items ?? 0,
    type: resolved?.type ?? FileType.PlaylistEditable,
    provider: providerHint,
  };
  if (resolved?.providerInstanceId) responsePayload.providerInstanceId = resolved.providerInstanceId;
  if (resolved?.rawId) responsePayload.rawId = resolved.rawId;
  if (resolved?.playlistCover) responsePayload.playlistCover = resolved.playlistCover;

  const playlistRawId = resolved?.playlistCommandUri ?? resolved?.playlistId ?? resolved?.rawId ?? playlistIdFromQuery;
  if (playlistRawId) {
    responsePayload.playlistId = playlistRawId;
  }
  if (shuffleToken) {
    responsePayload.shuffle = shuffleToken.toLowerCase() === 'shuffle' ? 1 : 0;
  }

  if (playlistRawId) {
    const friendlyPlaylistPath = buildFriendlyPlaylistPath(playlistRawId);
    const commandPlaylistId = ensurePlaylistCommandUri(playlistRawId);
    const commandParams = new URLSearchParams();
    commandParams.set('playlistId', commandPlaylistId);
    if (startItemFromQuery) commandParams.set('item', startItemFromQuery);
    const friendlyAudiopath = startItemFromQuery
      ? `${friendlyPlaylistPath}?${commandParams.toString()}`
      : friendlyPlaylistPath;

    responsePayload.audiopath = friendlyAudiopath;
    responsePayload.playlistId = commandPlaylistId;

    const commandPayload: Record<string, unknown> = {
      id: resolved?.name ?? playlistRawId,
      name: resolved?.name ?? playlistRawId,
      audiopath: commandPlaylistId,
      coverurl: cover,
      provider: resolved?.playlistProviderInstanceId ?? resolved?.provider ?? providerHint,
      providerInstanceId: resolved?.playlistProviderInstanceId ?? resolved?.providerInstanceId,
      playlistCommandUri: resolved?.playlistCommandUri ?? resolved?.playlistId ?? playlistRawId,
      playlistId: resolved?.playlistId ?? playlistRawId,
      rawId: resolved?.rawId ?? playlistRawId,
      option: 'replace',
    };

    const startItem = resolved?.playlistStartItem ?? startItemFromQuery;
    if (startItem) {
      commandPayload.start_item = startItem;
    }

    if (shuffleToken) {
      responsePayload.shuffle = shuffleToken.toLowerCase() === 'shuffle' ? 1 : 0;
      commandPayload.shuffle = responsePayload.shuffle;
    }

    if (!Number.isNaN(playerId) && playerId > 0) {
      sendCommandToZone(playerId, 'playlistplay', JSON.stringify(commandPayload));
    }
  } else {
    if (!Number.isNaN(playerId) && playerId > 0) {
      sendCommandToZone(playerId, 'playlistplay', JSON.stringify(responsePayload));
    }
  }

  return response(url, 'playlistplay', [responsePayload]);
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
  const metaTokens = new Set(['parentid', 'parentpath', 'shuffle', 'noshuffle']);

  const itemParts: string[] = [];
  let metaStart = 0;
  while (metaStart < segments.length) {
    const segment = segments[metaStart];
    const lower = segment.toLowerCase();
    if (metaTokens.has(lower)) {
      break;
    }
    itemParts.push(segment);
    metaStart += 1;
  }

  const itemId =
    itemParts.length > 0 ? itemParts.map((part) => decodeURIComponent(part)).join('/') : '';

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

  for (let i = metaStart; i < segments.length; i++) {
    const segment = segments[i].toLowerCase();
    if (segment === 'parentid' || segment === 'parentpath') {
      const collected: string[] = [];
      let j = i + 1;
      while (j < segments.length) {
        const next = segments[j];
        const lowerNext = next.toLowerCase();
        if (metaTokens.has(lowerNext)) {
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

  const syntheticParts = itemId.split(':');
  const isSyntheticStream =
    syntheticParts.length > 4 &&
    syntheticParts[0].toLowerCase() === 'library' &&
    syntheticParts[1].toLowerCase() === 'local' &&
    syntheticParts[2].toLowerCase() === 'track';

  if (isSyntheticStream) {
    const providerKey = syntheticParts[3];
    const trackId = syntheticParts.slice(4).join(':') || syntheticParts[3];

    const zone = getZoneById(playerId);
    const queueItem = Array.isArray(zone?.queue?.items)
      ? zone!.queue!.items.find(
        (entry: any) =>
          entry?.audiopath?.toLowerCase() === itemId.toLowerCase() ||
          entry?.unique_id?.toLowerCase() === trackId.toLowerCase(),
      )
      : undefined;

    if (queueItem && typeof queueItem.qindex === 'number') {
      logger.debug(
        `[audioLibraryPlay] Redirecting synthetic stream to queue play. zone=${playerId} audiopath=${itemId} qindex=${queueItem.qindex}`,
      );
      await sendCommandToZone(playerId, 'queue', ['play', String(queueItem.qindex)]);

      const responsePayload: Record<string, unknown> = {
        ...queueItem,
        provider: providerKey,
      };
      if (shuffle !== undefined) {
        responsePayload.shuffle = shuffle ? 1 : 0;
      }

      return response(url, 'libraryplay', [responsePayload]);
    }

    const commandPayload: Record<string, unknown> = {
      id: trackId,
      name: trackId,
      audiopath: itemId,
      coverurl: '',
      provider: providerKey,
      providerInstanceId: providerKey,
      playlistCommandUri: itemId,
      playlistId: itemId,
      rawId: trackId,
      option: 'replace',
    };

    if (shuffle !== undefined) {
      commandPayload.shuffle = shuffle ? 1 : 0;
    }

    if (!Number.isNaN(playerId) && playerId > 0) {
      await sendCommandToZone(playerId, 'playlistplay', JSON.stringify(commandPayload));
    }

    const responsePayload: Record<string, unknown> = {
      id: trackId,
      name: trackId,
      audiopath: itemId,
      coverurl: '',
      items: 1,
      type: FileType.File,
      provider: providerKey,
      rawId: trackId,
    };
    if (shuffle !== undefined) {
      responsePayload.shuffle = shuffle ? 1 : 0;
    }

    return response(url, 'libraryplay', [responsePayload]);
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
    coverurl:
      resolved.coverurlHighRes ??
      resolved.coverurl ??
      resolved.thumbnail ??
      '',
    items: resolved.items ?? 0,
    type: resolved.type ?? 3,
    provider: resolved.provider ?? 'library',
    rawId: resolved.rawId ?? resolved.id,
  };

  if (shuffle !== undefined) {
    payload['shuffle'] = shuffle ? 1 : 0;
  }

  const isTrack = resolved.tag === 'track' || resolved.contentType === 'Track';

  if (!isTrack) {
    if (resolved.tag === 'album') {
      const rawId = resolved.rawId || resolved.id;
      payload.audiopath = resolved.audiopath || rawId;
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

  if (isTrack) {
    let playlistUri = resolved.playlistCommandUri ?? resolved.playlistId;
    const startItem = resolved.playlistStartItem ?? resolved.audiopath ?? resolved.id;
    if (!playlistUri && parentId) {
      const decodedParent = decodeURIComponent(parentId);
      if (decodedParent.startsWith('library://')) {
        playlistUri = decodedParent;
      } else if (decodedParent.startsWith('library:')) {
        const parts = decodedParent.split(':').filter(Boolean);
        if (parts.length >= 3) {
          const kind = parts[2];
          // Remaining segments may include path separators or positional metadata; keep only the first meaningful token.
          const remainder = parts.slice(3);
          const firstToken = remainder.length > 0 ? remainder[0].replace(/[\\/]/g, '') : '';
          playlistUri = firstToken ? `library://${kind}/${firstToken}` : `library://${kind}`;
        }
      }
    }
    if (playlistUri) {
      payload.audiopath = playlistUri;
      payload.playlistCommandUri = playlistUri;
      payload.playlistId = playlistUri;
      if (resolved.playlistName) {
        payload.playlistName = resolved.playlistName;
      }
      if (resolved.playlistCover) {
        payload.playlistCover = resolved.playlistCover;
      }
      if (resolved.playlistProviderInstanceId) {
        payload.playlistProviderInstanceId = resolved.playlistProviderInstanceId;
      }
      if (startItem) {
        payload.start_item = startItem;
      }
      payload.option = payload.option ?? 'replace';
    }
    if (!Number.isNaN(playerId) && playerId > 0) {
      sendCommandToZone(playerId, 'playlistplay', JSON.stringify(payload));
    }
  } else if (!isTrack && resolved.tag === 'album' && payload.audiopath && !Number.isNaN(playerId) && playerId > 0) {
    sendCommandToZone(playerId, 'serviceplay', JSON.stringify(payload));
  } else if (!isTrack && resolved.tag === 'artist' && payload.audiopath && !Number.isNaN(playerId) && playerId > 0) {
    sendCommandToZone(playerId, 'serviceplay', JSON.stringify(payload));
  }

  return response(url, 'libraryplay', [payload]);
}

/**
 * Handle Favorite play commands.
 */
export async function audioFavoritePlay(url: string): Promise<CommandResult> {
  const segments = splitUrl(url);
  const zoneId = parseNumberPart(segments[1], 0);
  const favoriteId = parseNumberPart(segments[4], 0);
  const providerSegment = segments[5] ?? '';
  const shuffle = /shuffle$/i.test(url) && !/noshuffle$/i.test(url);
  const [, rawQuery = ''] = url.split('?', 2);
  const fadeOptions = parseFadeOptions(rawQuery ? `?${rawQuery}` : '');

  if (zoneId <= 0 || favoriteId <= 0) {
    logger.warn(`[audioFavoritePlay] Invalid zone (${zoneId}) or favorite id (${favoriteId}) in URL: ${url}`);
    return response(url, 'libraryplay', []);
  }

  const favorite = await getRoomFavoriteForPlayback(zoneId, favoriteId);

  logger.info(
    `[audioFavoritePlay] zone=${zoneId} favoriteId=${favoriteId} provider=${favorite?.provider ?? 'unknown'}`,
  );

  if (!favorite) {
    logger.warn(`[audioFavoritePlay] No favorite found for id ${favoriteId} in zone ${zoneId}`);
    return response(url, 'libraryplay', []);
  }

  const audiopath = favorite.audiopath ?? favorite.rawId;
  if (!audiopath) {
    logger.warn(`[audioFavoritePlay] Favorite ${favorite.name} has no audiopath`);
    return response(url, 'libraryplay', []);
  }

  const commandPayload: Record<string, unknown> = {
    id: favorite.rawId ?? audiopath,
    name: favorite.name ?? favorite.title ?? audiopath,
    audiopath,
    coverurl: favorite.coverurl ?? '',
    provider: favorite.provider ?? (providerSegment && !/shuffle$/i.test(providerSegment) ? providerSegment : undefined),
    providerInstanceId:
      favorite.providerInstanceId ??
      favorite.provider ??
      (providerSegment && !/shuffle$/i.test(providerSegment) ? providerSegment : undefined),
    service: favorite.service ?? 'library',
    type: favorite.type ?? 'library_track',
    option: 'replace',
  };

  if (shuffle) {
    commandPayload.shuffle = 1;
  }

  logger.info(`[audioFavoritePlay] Playing favorite: ${favorite.name} → ${audiopath}`);

  const enableFade = fadeOptions.fade === true;
  const fadeDuration = clampFadeDuration(fadeOptions.fadeDurationMs ?? DEFAULT_FADE_DURATION_MS);
  const zone = getZoneById(zoneId);
  const fadeKey = String(zoneId);
  if (enableFade && fadeDuration > 0 && zone) {
    const originalVolume = clampVolume(zone.playerEntry?.volume ?? 0);
    favoriteFadeState.set(zoneId, { originalVolume, fadeDurationMs: fadeDuration });
    cancelFade(fadeKey, favoriteFadeControllers);

    const dropDelta = -Math.max(Math.round(originalVolume), 100);
    try {
      await sendCommandToZone(zoneId, 'volume', String(dropDelta));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[audioFavoritePlay] Failed to prime fade for zone ${zoneId}: ${message}`);
    }
    zone.playerEntry.volume = 0;
  } else {
    favoriteFadeState.delete(zoneId);
    cancelFade(fadeKey, favoriteFadeControllers);
  }

  await sendCommandToZone(zoneId, 'playlistplay', JSON.stringify(commandPayload));

  if (enableFade && fadeDuration > 0 && zone) {
    try {
      await sendCommandToZone(zoneId, 'volume', '-100');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[audioFavoritePlay] Failed to enforce fade start volume for zone ${zoneId}: ${message}`);
    }
    zone.playerEntry.volume = 0;
  }

  if (enableFade && fadeDuration > 0 && zone) {
    const snapshot = favoriteFadeState.get(zoneId);
    const presetApplied = applyStoredVolumePreset(zoneId, false);
    const targetVolume = presetApplied?.buzzer ?? presetApplied?.default ?? snapshot?.originalVolume ?? clampVolume(zone.playerEntry?.volume ?? 0);
    if (targetVolume > 0) {
      let lastVolumeInt = 0;
      zone.playerEntry.volume = lastVolumeInt;
      zone.fadeTargetVolume = targetVolume;
      scheduleFade(
        zoneId,
        fadeKey,
        favoriteFadeControllers,
        0,
        targetVolume,
        fadeDuration,
        (value) => {
          const next = Math.round(clampVolume(value));
          const delta = next - lastVolumeInt;
          lastVolumeInt = next;
          zone.playerEntry.volume = next;
          if (delta === 0) return Promise.resolve();
          return sendCommandToZone(zoneId, 'volume', String(delta));
        },
        () => {
          favoriteFadeState.delete(zoneId);
        },
      );
    } else {
      favoriteFadeState.delete(zoneId);
    }
  }

  return response(url, 'libraryplay', [commandPayload]);
}

/**
 * Handle direct playurl commands, resolving playlist metadata when available so playback continues.
 */
export async function audioPlayUrl(url: string): Promise<CommandResult> {
  const match = url.match(/^audio\/(\d+)\/playurl\/(.+)$/);
  if (!match) {
    return response(url, 'playurl', []);
  }

  const playerId = Number(match[1]);
  const rawRemainder = match[2];
  const [pathWithoutQuery, queryString = ''] = rawRemainder.split('?', 2);
  const { base: basePart, meta } = splitCommandPath(pathWithoutQuery);
  if (!basePart) {
    return response(url, 'playurl', []);
  }

  let shuffle: boolean | undefined;
  const shuffleToken = meta.find((segment) => {
    const lower = segment.toLowerCase();
    return lower === 'shuffle' || lower === 'noshuffle';
  });
  if (shuffleToken) {
    shuffle = shuffleToken.toLowerCase() === 'shuffle';
  }

  const decodedUri = decodeURIComponent(rawRemainder);
  const decodedBasePath = decodeURIComponent(basePart);
  const queryParams = new URLSearchParams(queryString);
  const playlistIdFromQuery = queryParams.get('playlistId') ?? undefined;
  let startItemParam = queryParams.get('item') ?? queryParams.get('track') ?? undefined;
  const originalStartItemParam = startItemParam ?? undefined;

  const parseShuffleDirective = (value: string): boolean | undefined => {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return undefined;
    if (trimmed === 'shuffle' || trimmed === '1' || trimmed === 'true') return true;
    if (trimmed === 'noshuffle' || trimmed === '0' || trimmed === 'false') return false;
    return undefined;
  };

  const shuffleParam = queryParams.get('shuffle');
  if (shuffleParam !== null && shuffle === undefined) {
    const parsedShuffle = parseShuffleDirective(shuffleParam);
    if (parsedShuffle !== undefined) {
      shuffle = parsedShuffle;
    }
  }

  if (startItemParam) {
    const segments = startItemParam.split('/');
    while (segments.length > 0) {
      const candidate = segments[segments.length - 1];
      const parsed = parseShuffleDirective(candidate);
      if (parsed === undefined) {
        break;
      }
      if (shuffle === undefined) {
        shuffle = parsed;
      }
      segments.pop();
    }
    startItemParam = segments.join('/');
    if (!startItemParam) {
      startItemParam = undefined;
    }
  }

  const provider = getMediaProvider();
  let resolved: MediaFolderItem | undefined;
  if (provider.resolveMediaItem) {
    resolved = await provider.resolveMediaItem('', decodedUri);
    if (!resolved && decodedUri.startsWith('library:')) {
      resolved = await provider.resolveMediaItem('tracks', decodedUri);
    }
  }

  const playlistCandidates = new Set<string>();
  const addPlaylistCandidate = (value: string | undefined) => {
    if (!value) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    playlistCandidates.add(trimmed);
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('playlist/')) {
      playlistCandidates.add(trimmed.slice('playlist/'.length));
    } else if (lower.startsWith('playlist:')) {
      playlistCandidates.add(trimmed.slice('playlist:'.length));
    } else if (lower.startsWith('library://playlist/')) {
      playlistCandidates.add(trimmed.slice('library://playlist/'.length));
    } else if (lower.startsWith('library:playlist:')) {
      playlistCandidates.add(trimmed.slice('library:playlist:'.length));
    } else if (lower.startsWith('library:')) {
      const rest = trimmed.slice('library:'.length);
      playlistCandidates.add(rest);
      const restLower = rest.toLowerCase();
      if (restLower.startsWith('playlist:')) {
        playlistCandidates.add(rest.slice('playlist:'.length));
      } else if (restLower.startsWith('playlist/')) {
        playlistCandidates.add(rest.slice('playlist/'.length));
      }
    }
  };
  addPlaylistCandidate(playlistIdFromQuery);
  addPlaylistCandidate(decodedBasePath);
  // LEGACY(current): older client encodes playlist info under /parentpath or /parentid.
  for (let i = 0; i < meta.length; i++) {
    const token = meta[i]?.toLowerCase();
    if (token === 'parentpath' || token === 'parentid') {
      const candidate = meta[i + 1];
      if (candidate) {
        addPlaylistCandidate(decodeURIComponent(candidate));
      }
      i++;
      continue;
    }
  }

  let resolvedPlaylist: PlaylistItem | undefined;
  if (provider.resolvePlaylist) {
    for (const candidate of playlistCandidates) {
      try {
        const maybe = await provider.resolvePlaylist('', candidate);
        if (maybe) {
          resolvedPlaylist = maybe;
          break;
        }
      } catch (error) {
        logger.debug(
          `[audioPlayUrl] resolvePlaylist failed for ${candidate}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  const playlistContext: (PlaylistItem & Partial<MediaFolderItem>) | undefined =
    resolvedPlaylist ??
    (resolved && (resolved.playlistCommandUri || resolved.playlistId || resolved.playlistName)
      ? (resolved as PlaylistItem & Partial<MediaFolderItem>)
      : undefined);

  const playlistRawCommand = playlistContext
    ? playlistContext.playlistCommandUri ??
    playlistContext.playlistId ??
    playlistContext.rawId ??
    playlistContext.id ??
    playlistIdFromQuery ??
    decodedBasePath
    : undefined;

  if (playlistContext && playlistRawCommand) {
    const commandPlaylistId = ensurePlaylistCommandUri(playlistRawCommand);
    const playlistName =
      playlistContext.playlistName ||
      playlistContext.name ||
      resolvedPlaylist?.name ||
      commandPlaylistId;
    const providerInstance =
      resolvedPlaylist?.playlistProviderInstanceId ??
      resolvedPlaylist?.providerInstanceId ??
      resolvedPlaylist?.provider ??
      playlistContext.playlistProviderInstanceId ??
      playlistContext.provider ??
      resolved?.provider ??
      'musicassistant';
    const cover =
      resolvedPlaylist?.coverurlHighRes ??
      resolvedPlaylist?.playlistCover ??
      resolvedPlaylist?.coverurl ??
      playlistContext.playlistCover ??
      playlistContext.coverurl ??
      playlistContext.coverurlHighRes ??
      '';
    const effectiveStartItem =
      startItemParam ??
      playlistContext.playlistStartItem ??
      resolvedPlaylist?.playlistStartItem ??
      originalStartItemParam;

    const friendlyPath = buildFriendlyPlaylistPath(commandPlaylistId);
    const friendlyParams = new URLSearchParams();
    friendlyParams.set('playlistId', commandPlaylistId);
    if (effectiveStartItem) {
      friendlyParams.set('item', effectiveStartItem);
    }
    const friendlyAudiopath = effectiveStartItem ? `${friendlyPath}?${friendlyParams.toString()}` : friendlyPath;

    const playlistPayload: Record<string, unknown> = {
      id: resolvedPlaylist?.id ?? friendlyPath,
      name: playlistName,
      audiopath: friendlyAudiopath,
      coverurl: cover,
      type: FileType.PlaylistEditable,
      provider: providerInstance,
      providerInstanceId: providerInstance,
      option: 'replace',
      playlistId: commandPlaylistId,
      playlistCommandUri: commandPlaylistId,
      rawId: resolvedPlaylist?.rawId ?? playlistContext.rawId ?? playlistContext.id,
    };

    if (playlistContext.rawId) {
      playlistPayload.rawId = playlistContext.rawId;
    }
    if (playlistContext.playlistCover) {
      playlistPayload.playlistCover = playlistContext.playlistCover;
    }

    if (effectiveStartItem) {
      playlistPayload.start_item = effectiveStartItem;
      playlistPayload.playlistStartItem = effectiveStartItem;
    }

    if (shuffle !== undefined) {
      playlistPayload.shuffle = shuffle ? 1 : 0;
    }

    if (!Number.isNaN(playerId) && playerId > 0) {
      const commandPayload: Record<string, unknown> = {
        id: playlistName,
        name: playlistName,
        audiopath: commandPlaylistId,
        coverurl: cover,
        provider: providerInstance,
        providerInstanceId: providerInstance,
        playlistCommandUri: resolvedPlaylist?.playlistCommandUri ?? playlistContext.playlistCommandUri ?? playlistRawCommand,
        playlistId: resolvedPlaylist?.playlistId ?? playlistContext.playlistId ?? playlistRawCommand,
        rawId: resolvedPlaylist?.rawId ?? playlistContext.rawId ?? playlistRawCommand,
        option: 'replace',
      };
      if (effectiveStartItem) {
        commandPayload.start_item = effectiveStartItem;
      }
      if (shuffle !== undefined) {
        commandPayload.shuffle = shuffle ? 1 : 0;
      }
      sendCommandToZone(playerId, 'playlistplay', JSON.stringify(commandPayload));
    }

    return response(url, 'playurl', [playlistPayload]);
  }

  const providerHint =
    resolved?.provider ?? (decodedUri.includes(':') ? decodedUri.split(':')[0] : undefined) ?? 'external';
  const sanitizedAudiopath = decodedBasePath.replace(/\/(?:no)?shuffle$/i, '');
  const localTrackMatch = decodedUri.match(/^library:local:track:([^:]+):/i);
  const providerFromPath = localTrackMatch ? localTrackMatch[1] : undefined;
  const trackPayload: Record<string, unknown> = {
    id: resolved?.id ?? decodedUri,
    name: resolved?.title ?? resolved?.name ?? decodedUri,
    audiopath: sanitizedAudiopath,
    coverurl:
      resolved?.coverurlHighRes ??
      resolved?.coverurl ??
      resolved?.thumbnail ??
      '',
    type: resolved?.type ?? FileType.File,
    provider: resolved?.provider ?? providerFromPath ?? providerHint,
    providerInstanceId: resolved?.providerInstanceId ?? providerFromPath,
    album: resolved?.album,
    artist: resolved?.artist,
    title: resolved?.title ?? resolved?.name,
    uniqueId: resolved?.id ?? decodedUri,
  };

  const playlistCommandUri =
    resolvedPlaylist?.playlistCommandUri ??
    playlistContext?.playlistCommandUri ??
    playlistRawCommand ??
    playlistIdFromQuery ??
    undefined;
  if (playlistCommandUri) {
    // LEGACY(current): queue UI requires playlist ids even when /playurl kicked off playback.
    const normalizedPlaylist = toPlaylistCommandUri(playlistCommandUri, playlistContext?.playlistProviderInstanceId, playlistContext?.rawId);
    trackPayload.playlistCommandUri = normalizedPlaylist;
    trackPayload.playlistId = normalizedPlaylist;
  }
  if (playlistContext?.playlistProviderInstanceId ?? resolvedPlaylist?.playlistProviderInstanceId ?? resolvedPlaylist?.providerInstanceId) {
    trackPayload.playlistProviderInstanceId =
      resolvedPlaylist?.playlistProviderInstanceId ??
      resolvedPlaylist?.providerInstanceId ??
      playlistContext?.playlistProviderInstanceId;
  }
  if (playlistContext?.playlistCover ?? resolvedPlaylist?.playlistCover) {
    trackPayload.playlistCover = resolvedPlaylist?.playlistCover ?? playlistContext?.playlistCover;
  }
  if (playlistContext?.playlistStartItem ?? resolvedPlaylist?.playlistStartItem ?? startItemParam ?? originalStartItemParam) {
    trackPayload.playlistStartItem =
      resolvedPlaylist?.playlistStartItem ??
      playlistContext?.playlistStartItem ??
      startItemParam ??
      originalStartItemParam;
  }
  if (playlistContext?.playlistName ?? resolvedPlaylist?.playlistName) {
    trackPayload.playlistName = resolvedPlaylist?.playlistName ?? playlistContext?.playlistName;
  }

  if (shuffle !== undefined) {
    trackPayload.shuffle = shuffle ? 1 : 0;
  }

  if (!Number.isNaN(playerId) && playerId > 0) {
    sendCommandToZone(playerId, 'serviceplay', JSON.stringify(trackPayload));
  }

  return response(url, 'playurl', [trackPayload]);
}

function splitCommandPath(path: string): { base: string; meta: string[] } {
  try {
    const decoded = decodeURIComponent(path);
    const parts = decoded.split('/').filter(Boolean);
    if (parts.length >= 2 && parts[0].toLowerCase() === 'playlist') {
      const base = `${parts[0]}/${parts[1]}`;
      const meta = parts.slice(2);
      return { base, meta };
    }
  } catch {
    // ignore decode issues and fall back to legacy handling
  }

  const metaMatch = path.match(/\/(parentid|parentpath|shuffle|noshuffle)\b/i);
  if (!metaMatch || metaMatch.index === undefined) {
    return { base: path, meta: [] };
  }

  const base = path.slice(0, metaMatch.index);
  const metaString = path.slice(metaMatch.index + 1);
  const meta = metaString.split('/').filter((segment) => segment.length > 0);
  return { base, meta };
}

/**
 * Handle play/pause/volume command set by forwarding the instruction to the zone backend.
 */
export function audioDynamicCommand(url: string): CommandResult {
  const parts = url.split('/');
  const playerID = Number(parts[1]);
  const command = parts[2];
  const extraSegments = parts.slice(3);
  const param: string | string[] | undefined = extraSegments.length > 1 ? extraSegments : extraSegments[0];

  sendCommandToZone(playerID, command, param);
  return emptyCommand(url, []);
}
function normalizeFavoriteResponse(
  responseData: FavoriteResponse | undefined,
  zoneId: number,
  fallbackStart: number,
): FavoriteResponse {
  const items = Array.isArray(responseData?.items) ? responseData.items : [];
  const totalitems = Number.isFinite(responseData?.totalitems)
    ? Number(responseData!.totalitems)
    : items.length;
  const start = Number.isFinite(responseData?.start) ? Number(responseData!.start) : fallbackStart;
  const id =
    responseData?.id !== undefined && responseData?.id !== null
      ? responseData.id
      : String(zoneId);
  const name =
    typeof responseData?.name === 'string' && responseData.name.trim()
      ? responseData.name
      : 'Favorites';

  return {
    id,
    name,
    start,
    totalitems,
    items,
    ts: responseData?.ts ?? Date.now(),
  };
}

function normalizeRecentResponse(responseData: RecentResponse | undefined): RecentResponse {
  const items = Array.isArray(responseData?.items) ? responseData.items : [];
  const totalitems = Number.isFinite(responseData?.totalitems)
    ? Number(responseData!.totalitems)
    : items.length;

  return {
    id: responseData?.id ?? 'recentlyPlayed',
    name: responseData?.name ?? 'Recently Played',
    start: Number.isFinite(responseData?.start) ? Number(responseData!.start) : 0,
    totalitems,
    items,
    ts: responseData?.ts ?? Date.now(),
  };
}

function decodeSegment(value: string | undefined): string {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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

function ensurePlaylistCommandUri(value: string): string {
  return toPlaylistCommandUri(value);
}

function buildFriendlyPlaylistPath(rawId: string): string {
  const trimmed = (rawId || '').trim();
  if (!trimmed) return 'playlist';
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('playlist/')) return trimmed;
  if (lower.startsWith('playlist:')) return `playlist/${trimmed.slice(9)}`;
  if (lower.includes('://')) {
    const slash = trimmed.lastIndexOf('/');
    if (slash >= 0 && slash < trimmed.length - 1) {
      return `playlist/${trimmed.slice(slash + 1)}`;
    }
  }
  return `playlist/${trimmed}`;
}
