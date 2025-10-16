import { CommandResult, response } from './commandTypes';
import { parseNumberPart, parsePaging, splitUrl } from './commandUtils';
import { getMediaProvider } from '../../backend/provider/factory';
import logger from '../../utils/troxorlogger';

/**
 * Delegate media folder lookups to the active provider, including the logical root folder.
 */
export async function audioCfgGetMediaFolder(url: string): Promise<CommandResult> {
  const parts = splitUrl(url);
  const requestId = parts[3] || 'root';
  const paging = parsePaging(parts, 4, 50);

  const provider = getMediaProvider();
  logger.debug(
    `[audioCfgGetMediaFolder] provider=${provider.constructor.name} requestId=${requestId} offset=${paging.offset} limit=${paging.limit}`,
  );
  const folder = provider.getMediaFolder
    ? await provider.getMediaFolder(requestId, paging.offset, paging.limit)
    : undefined;

  if (folder) {
    return response(url, 'getmediafolder', [folder]);
  }

  return response(url, 'getmediafolder', [
    {
      id: requestId,
      totalitems: 0,
      start: paging.offset,
      items: [],
    },
  ]);
}

/**
 * List radio sources supplied by the configured media provider.
 */
export async function audioCfgGetRadios(url: string): Promise<CommandResult> {
  const provider = getMediaProvider();
  const radios = await provider.getRadios();
  return response(url, 'getradios', radios);
}

/**
 * Report third-party streaming services supported by the current provider.
 * The Music Assistant backend exposes radio content directly, so return an empty list.
 */
export function audioCfgGetAvailableServices(url: string): CommandResult {
  return response(url, 'getavailableservices', []);
}

/**
 * Handles global search requests (e.g. "audio/cfg/globalsearch/local:track#5/Foo").
 * Delegates the search to the active media provider (e.g. MusicAssistantProvider).
 */
export async function audioCfgGlobalSearch(url: string) {
  const parts = splitUrl(url);
  // URL pattern: audio/cfg/globalsearch/{source}/{query}
  const rawSource = parts[3] || 'local:track';
  const query = decodeURIComponent(parts[4] || '').trim();

  const provider = getMediaProvider();
  logger.debug(`[audioCfgGlobalSearch] provider=${provider?.constructor?.name} source=${rawSource} query="${query}"`);

  if (!provider || !query) {
    logger.warn('[audioCfgGlobalSearch] No provider or empty query');
    return response(url, 'globalsearch', []);
  }

  try {
    // delegate to provider
    let results: Record<string, any> = {};

    if (provider.globalSearch) {
      results = await provider.globalSearch(rawSource, query);
    } else {
      logger.warn(`[audioCfgGlobalSearch] Provider ${provider.constructor.name} does not implement globalSearch()`);
    }
    return response('xx', 'dummy', []);
  } catch (err) {
    logger.warn(`[audioCfgGlobalSearch] Error during search: ${err}`);
    return response(url, 'dummy', []);
  }
}

/**
 * Describe the global search sources available to the client.
 * For now, expose only the radio source to keep the UI pathways happy.
 */
export function audioCfgGlobalSearchDescribe(url: string): CommandResult {
  const describePayload = {
    local: ['track', 'album', 'artist', 'playlist', 'folder'],
    tunein: ['station', 'custom'],
  };
  return response(url, 'globalsearch', describePayload);
}

/**
 * Report that no library scan is in progress.
 */
export function audioCfgScanStatus(url: string): CommandResult {
  logger.debug('[audioCfgScanStatus] requested');
  return response(url, 'scanstatus', [0]);
}

/**
 * List playlists supplied by the configured media provider.
 */
export async function audioCfgGetPlaylists(url: string): Promise<CommandResult> {
  const parts = splitUrl(url);
  const service = parts[3] || 'lms';
  const user = parts[4] || 'nouser';
  const prefix = ['audio', 'cfg', 'getplaylists2', service, user].join('/') + '/';
  const remainder = url.startsWith(prefix) ? url.slice(prefix.length) : '';

  let playlistId: string | undefined;
  let offset = 0;
  let start = 0;
  let limit = 10;

  const startsWithDigit = remainder === '' ? false : /^[0-9]/.test(remainder);

  if (!remainder || startsWithDigit) {
    const segments = remainder
      .split('/')
      .filter((segment) => segment !== undefined && segment !== '');
    if (segments.length >= 3 && segments[0] !== '0') {
      const [rawId, rawOffset, rawLimit] = segments;
      playlistId = decodeURIComponent(rawId);
      offset = parseNumberPart(rawOffset, 0);
      start = offset;
      limit = parseNumberPart(rawLimit, 10);
    } else {
      offset = parseNumberPart(segments[0], 0);
      switch (segments.length) {
        case 2:
          start = offset;
          limit = parseNumberPart(segments[1], 10);
          break;
        case 3:
          offset = parseNumberPart(segments[1], 0);
          start = offset;
          limit = parseNumberPart(segments[2], 10);
          break;
        default:
          start = offset;
          limit = 10;
          break;
      }
    }
  } else {
    const rawSegments = remainder.split('/');
    const numericTail: string[] = [];
    while (rawSegments.length > 0 && numericTail.length < 2) {
      const candidate = rawSegments[rawSegments.length - 1];
      if (candidate === '' || !/^-?\d+$/.test(candidate)) {
        break;
      }
      numericTail.push(rawSegments.pop()!);
    }
    numericTail.reverse();

    if (numericTail.length >= 1) {
      offset = parseNumberPart(numericTail[0], 0);
      start = offset;
    }
    if (numericTail.length >= 2) {
      limit = parseNumberPart(numericTail[1], 10);
    }

    const joinedId = rawSegments.join('/');
    playlistId = joinedId ? decodeURIComponent(joinedId) : undefined;
  }

  const provider = getMediaProvider();
  logger.debug(
    `[audioCfgGetPlaylists] provider=${provider.constructor.name} service=${service} user=${user} playlist=${playlistId ?? 'root'} offset=${offset} limit=${limit}`,
  );

  const playlistResponse =
    playlistId && provider.getPlaylistItems
      ? await provider.getPlaylistItems(playlistId, offset, limit)
      : await provider.getPlaylists(offset, limit);

  const playlist = playlistResponse ?? {
    id: 0,
    name: playlistId ?? '',
    totalitems: 0,
    start: offset,
    items: [],
  };

  const payload = {
    id: playlist.id,
    name: playlist.name,
    items: playlist.items ?? [],
    service,
    start,
    totalitems: playlist.totalitems ?? 0,
    type: 3,
    user,
  };

  return response(url, 'getplaylists2', [payload]);
}

/**
 * Delegate service folder lookup to the media provider.
 */
export async function audioCfgGetServiceFolder(url: string): Promise<CommandResult> {
  const parts = splitUrl(url);
  const service = parts[3] || 'local';
  const user = parts[4] || 'nouser';
  const folderId = parts[5] || 'start';
  const paging = parsePaging(parts, 6, 50);

  const provider = getMediaProvider();
  logger.debug(
    `[audioCfgGetServiceFolder] provider=${provider.constructor.name} service=${service} folder=${folderId} user=${user} offset=${paging.offset} limit=${paging.limit}`,
  );
  const folder = await provider.getServiceFolder(
    service,
    folderId,
    user,
    paging.offset,
    paging.limit,
  );

  return response(url, 'getservicefolder', [{ ...folder, service }]);
}
