import { createLogger } from '@/core/logging/logger';
import type { StorageConfig } from '@/modules/content/storage/storageManager';
import type { LoxoneZoneState } from '@/modules/zones/types/loxoneZoneState';
import { broadcastMessage } from '@/modules/loxone/ws/connectionRegistry';

const log = createLogger('LoxoneHttp', 'Notifier');

function emit(
  payload: unknown,
  event: string,
  context?: Record<string, unknown>,
): void {
  try {
    broadcastMessage(JSON.stringify(payload));
    log.spam(`${event} broadcast`, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`${event} broadcast failed`, { ...context, message });
  }
}

/**
 * Pushes the current zone state to all Loxone clients.
 */
export function notifyZoneStateChanged(state: LoxoneZoneState): void {
  log.spam('audio_event payload', { state });
  emit({ audio_event: [state] }, 'audio_event', { zoneId: state.playerid });
}

/**
 * Signals that a zone queue changed.
 */
export function notifyQueueUpdated(zoneId: number, queueSize: number): void {
  emit(
    {
      audio_queue_event: [
        {
          playerid: Number(zoneId),
          queuesize: Number(queueSize),
          restrictions: 1,
        },
      ],
    },
    'audio_queue_event',
    { zoneId, queueSize },
  );
}

/**
 * Signals that the favorites collection of a zone changed.
 */
export function notifyRoomFavoritesChanged(zoneId: number, count: number): void {
  emit(
    {
      roomfavchanged_event: [
        {
          playerid: Number(zoneId),
          count: Number(count),
        },
      ],
    },
    'roomfavchanged_event',
    { zoneId, count },
  );
}

/**
 * Signals that the "recently played" history changed.
 */
export function notifyRecentlyPlayedChanged(zoneId: number, timestamp: number): void {
  emit(
    {
      recentlyplayedchanged_event: [
        {
          playerid: Number(zoneId),
          ts: Number(timestamp),
        },
      ],
    },
    'recentlyplayedchanged_event',
    { zoneId, timestamp },
  );
}

/**
 * Emits a Loxone-compatible `rescan_event` for local library progress.
 */
export function notifyRescan(status: 0 | 1 | 2, folders?: number, files?: number): void {
  const event: Record<string, number> = { status };
  if (typeof folders === 'number') {
    event.folders = folders;
  }
  if (typeof files === 'number') {
    event.files = files;
  }
  emit({ rescan_event: [event] }, 'rescan_event', { status, folders, files });
}

/**
 * Broadcasts the full storage inventory to every connected client.
 */
export function notifyStorageListUpdated(storages: StorageConfig[]): void {
  emit({ storage: storages }, 'storage_list', { storages: storages.length });
}

/**
 * Notifies clients that a storage entry was created.
 */
export function notifyStorageAdded(storage: StorageConfig): void {
  emit({ storage_added: [storage] }, 'storage_added', { id: storage.id });
}

/**
 * Notifies clients that a storage entry was removed.
 */
export function notifyStorageRemoved(id: string): void {
  emit({ storage_removed: [{ id }] }, 'storage_removed', { id });
}

/**
 * Notify Loxone music apps to reload service/account state.
 */
export function notifyReloadMusicApp(
  action: 'useradd' | 'userdel',
  provider: string,
  userId: string,
): void {
  emit(
    {
      reloadmusicapp_event: [
        {
          action,
          cause: provider,
          reload: 1,
          user: userId,
        },
      ],
    },
    'reloadmusicapp_event',
    { action, provider, userId },
  );
}

export function notifyGlobalSearchResult(
  result: Record<string, any>,
  providerId: string,
  unique: string,
): void {
  // TuneIn special-case payload
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
    emit(payload, 'globalsearch_result', { providerId, unique });
    return;
  }

  const userId = result.user ?? 'nouser';
  const query = result.query ?? '';
  const totals = (result as any)?._totals;

  const payload = {
    globalsearch_result: {
      error: 0,
      result: {
        tracks: buildCategory('Titoli', result.tracks, providerId, userId, 'track', query, totals),
        albums: buildCategory('Albums', result.albums, providerId, userId, 'album', query, totals),
        artists: buildCategory('Artiesten', result.artists, providerId, userId, 'artist', query, totals),
        playlists: buildCategory(
          'Playlists',
          result.playlists,
          providerId,
          userId,
          'playlist',
          query,
          totals,
        ),
        shows: buildCategory('Podcasts', result.shows, providerId, userId, 'show', query, totals),
        episodes: buildCategory(
          'Volgen',
          result.episodes,
          providerId,
          userId,
          'episode',
          query,
          totals,
        ),
        topresults: buildTopResults(result),
        user: userId,
      },
    },
    type: providerId,
    unique,
  };

  emit(payload, 'globalsearch_result', { providerId, unique });
}

export function notifyGlobalSearchError(providerId: string, unique: string): void {
  const payload = {
    globalsearch_result: {
      error: 1,
      type: providerId,
      unique,
    },
  };
  emit(payload, 'globalsearch_error', { providerId, unique });
}

function buildCategory(
  caption: string,
  items: any[] | undefined,
  providerId: string,
  userId: string,
  type: string,
  query: string,
  totals?: Record<string, number>,
) {
  const list = Array.isArray(items) ? items : [];
  const totalsKey = `${type}s`;
  return {
    caption,
    count: list.length,
    items: list,
    link: `audio/cfg/search/${providerId}/${userId}/${type}/${encodeURIComponent(query)}/0/50`,
    totalitems: totals?.[totalsKey] ?? list.length,
  };
}

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
