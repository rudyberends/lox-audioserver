import { CommandResult, response } from '../requestHandler';
import { splitUrl, parsePaging } from './utils/commandUtils';
import { providerRuntime } from '@/runtime/provider';
import logger from '@/utils/troxorLogger';

/* -------------------------------------------------------------------------- */
/*  Provider-driven content commands (thin HTTP → runtime layer)              */
/* -------------------------------------------------------------------------- */

/**
 * Return list of available external providers (e.g. Spotify, Apple Music).
 */
export async function audioCfgGetAvailableServices(url: string): Promise<CommandResult> {
  const services = await providerRuntime.getAvailableServices();
  return response(url, 'getavailableservices', services ?? []);
}

/**
 * Return active service sessions (user accounts per provider).
 */
export async function audioCfgGetServices(url: string): Promise<CommandResult> {
  const services = await providerRuntime.getServices();
  return response(url, 'getservices', services ?? []);
}

/**
 * Retrieve playlists from provider.
 * URL: audio/cfg/getplaylists2/{service}/{user}/{offset}/{limit}
 */
export async function audioCfgGetPlaylists(url: string): Promise<CommandResult> {
  const parts = splitUrl(url);
  const service = parts[3] ?? 'local';
  const user = parts[4] ?? 'nouser';
  const paging = parsePaging(parts, 5, 50);

  const playlists = await providerRuntime.getPlaylists(service, user, paging.offset, paging.limit);
  return response(url, 'getplaylists2', playlists ?? []);
}

/**
 * Retrieve radio stations from provider.
 */
export async function audioCfgGetRadios(url: string): Promise<CommandResult> {
  const radios = await providerRuntime.getRadios();
  return response(url, 'getradios', radios ?? []);
}

/**
 * Fetch contents of a specific provider folder (albums, artists, playlists, etc.).
 * URL: audio/cfg/getservicefolder/{service}/{user}/{folder}/{offset}/{limit}
 */
export async function audioCfgGetServiceFolder(url: string): Promise<CommandResult> {
  const parts = splitUrl(url);
  const service = parts[3] ?? 'local';
  const user = parts[4] ?? 'nouser';
  const folderId = parts.slice(5, -2).join('/') || 'root';
  const paging = parsePaging(parts, parts.length - 2, 50);

  logger.debug(`[getservicefolder] service=${service} folder=${folderId} offset=${paging.offset} limit=${paging.limit}`);

  const folder = await providerRuntime.getServiceFolder(service, user, folderId, paging.offset, paging.limit);
  return response(url, 'getservicefolder', folder ? [folder] : []);
}

/**
 * Return the logical media root folder (used by Loxone clients).
 * URL: audio/cfg/getmediafolder/{folderId}/{offset}/{limit}
 */
export async function audioCfgGetMediaFolder(url: string): Promise<CommandResult> {
  const parts = splitUrl(url);
  const folderId = parts[3] || 'root';
  const paging = parsePaging(parts, 4, 50);

  const folder = await providerRuntime.getMediaFolder(folderId, paging.offset, paging.limit);
  return response(url, 'getmediafolder', folder ? [folder] : []);
}

/**
 * Return a static “scan not in progress” response.
 */
export function audioCfgScanStatus(url: string): CommandResult {
  return response(url, 'scanstatus', [0]);
}