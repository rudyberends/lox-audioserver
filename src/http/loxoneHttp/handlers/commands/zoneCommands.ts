/* -----------------------------------------------------------------------------
 * Zone Command Handlers
 * -----------------------------------------------------------------------------
 * These handlers implement the HTTP endpoints related to zones, playback,
 * queues, and favorites. They perform only lightweight request parsing and
 * delegate all logic to backend modules:
 *
 * Each function returns its response in the exact Loxone-compatible format
 * expected by the MiniServer.
 * -----------------------------------------------------------------------------
 */
import { CommandResult, response, emptyCommand } from '../requestHandler';
import { splitUrl, parseNumberPart, decodeSegment } from './utils/commandUtils';
import { zoneRuntime, zoneStateStore } from '@/runtime/zones';
import { providerRuntime } from '@/runtime/provider';
import { broadcastMessage } from '../../websocketManager';
import { RecentResponse } from '@/core/types/content';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */
async function play(url: string, cmd: string, getItem: (p: string[]) => string) {
  const parts = splitUrl(url);
  const zoneId = parseNumberPart(parts[1], 0);
  const item = getItem(parts);

  // façade geeft alleen item door → runtime bepaalt shuffle/start/skip
  await zoneRuntime.sendZoneCommand(zoneId, 'contentplay', [item]);

  return response(url, cmd, [{ zoneId, item }]);
}

/* -------------------------------------------------------------------------- */
/* Status & queue                                                             */
/* -------------------------------------------------------------------------- */
export function audioGetStatus(url: string): CommandResult {
  const zoneId = parseNumberPart(splitUrl(url)[1], 0);
  return response(url, 'status', [zoneRuntime.getZoneState(zoneId)]);
}

export function audioCfgGetQueue(url: string): CommandResult {
  const parts = splitUrl(url);
  const zoneId = parseNumberPart(parts[1], 0);
  const start = parseNumberPart(parts[3], 0);
  const limit = parseNumberPart(parts[4], 50);

  const q = zoneStateStore.get(zoneId).queue;
  if (!q?.items) {
    return response(url, 'getqueue', [{ id: zoneId, items: [], shuffle: false, start: 0, totalitems: 0 }]);
  }

  return response(url, 'getqueue', [{
    id: q.id,
    items: q.items.slice(start, start + limit),
    shuffle: q.shuffle,
    start,
    totalitems: q.totalitems ?? q.items.length,
  }]);
}

export function audioCfgGetSyncedPlayers(url: string): CommandResult {
  return response(url, 'getsyncedplayers', [{ items: [] }]);
}

/* -------------------------------------------------------------------------- */
/* Recently played                                                            */
/* -------------------------------------------------------------------------- */
export async function audioRecent(url: string): Promise<CommandResult> {
  const parts = splitUrl(url);
  const zoneId = parseNumberPart(parts[1], 0);
  const sub = parts[3]?.toLowerCase();

  const state = zoneStateStore.get(zoneId);
  if (state) {
    broadcastMessage(JSON.stringify({ audio_event: [state] }));
  }

  if (sub === 'clear' && providerRuntime.isActive()) {
    await providerRuntime.clearRecentlyPlayed(zoneId).catch(() => {});
  }

  const limit = sub === 'clear' ? 50 : parseNumberPart(sub, 50);
  const payload: RecentResponse | undefined =
    providerRuntime.isActive()
      ? await providerRuntime.getRecentlyPlayed(zoneId, limit).catch(() => undefined)
      : undefined;

  return response(url, 'recent', payload);
}

/* -------------------------------------------------------------------------- */
/* Unified content-play                                                        */
/* -------------------------------------------------------------------------- */
export const audioPlaylistPlay = (url: string) =>
  play(url, 'playlistplay', p => decodeSegment(p.slice(4).join('/')));

export const audioLibraryPlay = (url: string) =>
  play(url, 'libraryplay', p => decodeSegment(p.slice(4).join('/')));

export const audioServicePlay = (url: string) =>
  play(url, 'serviceplay', p => {
    const id = decodeSegment(p.slice(4).join('/'));
    return id.startsWith('nouser/') ? id.slice(7) : id;
  });

export const audioPlayUrl = (url: string) =>
  play(url, 'playurl', p => decodeSegment(p.slice(3).join('/')));

/* -------------------------------------------------------------------------- */
/* Dynamic control                                                             */
/* -------------------------------------------------------------------------- */
export function audioDynamicCommand(url: string): CommandResult {
  const parts = splitUrl(url);
  zoneRuntime.sendZoneCommand(
    parseNumberPart(parts[1], 0),
    parts[2],
    parts.slice(3).join('/'),
  );
  return emptyCommand(url, []);
}