import { CommandResult, response } from './requesthandler';
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
  const offset = parseNumberPart(parts[5], 0);
  const start = parseNumberPart(parts[6], 0);
  const limit = parseNumberPart(parts[7], 10);

  const provider = getMediaProvider();
  logger.debug(
    `[audioCfgGetPlaylists] provider=${provider.constructor.name} service=${service} user=${user} offset=${offset} limit=${limit}`,
  );
  const playlist = await provider.getPlaylists(offset, limit);

  const payload = {
    id: playlist.id,
    items: playlist.items,
    service,
    start,
    totalitems: playlist.totalitems,
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
  const folder = await provider.getServiceFolder(service, folderId, user, paging.offset, paging.limit);

  return response(url, 'getservicefolder', [{ ...folder, service }]);
}
