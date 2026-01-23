import { createLogger } from '@/shared/logging/logger';
import type { StorageConfig } from '@/adapters/content/storage/storageManager';
import type { LoxoneZoneState } from '@/domain/loxone/types';
import type { AudioSyncGroupPayload } from '@/application/groups/types/AudioSyncGroupPayload';
import type { ConnectionRegistry } from '@/adapters/loxone/ws/connectionRegistry';

export class LoxoneWsNotifier {
  private readonly log = createLogger('LoxoneHttp', 'Notifier');

  constructor(private readonly registry: ConnectionRegistry) {}

  private emit(payload: unknown, event: string, context?: Record<string, unknown>): void {
    try {
      this.registry.broadcastMessage(JSON.stringify(payload));
      this.log.spam(`${event} broadcast`, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`${event} broadcast failed`, { ...context, message });
    }
  }

  /**
   * Pushes the current zone state to all Loxone clients.
   */
  public notifyZoneStateChanged(state: LoxoneZoneState): void {
    this.log.spam('audio_event payload', { state });
    this.emit({ audio_event: [state] }, 'audio_event', { zoneId: state.playerid });
  }

  /**
   * Signals that a zone queue changed.
   */
  public notifyQueueUpdated(zoneId: number, queueSize: number): void {
    this.emit(
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
  public notifyRoomFavoritesChanged(zoneId: number, count: number): void {
    this.emit(
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
  public notifyRecentlyPlayedChanged(zoneId: number, timestamp: number): void {
    this.emit(
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
   * Signals that the line-in inputs list changed.
   */
  public notifyLineInChanged(): void {
    this.emit({ lineinchanged_event: [] }, 'lineinchanged_event');
  }

  /**
   * Emits a Loxone-compatible `rescan_event` for local library progress.
   */
  public notifyRescan(status: 0 | 1 | 2, folders?: number, files?: number): void {
    const event: Record<string, number> = { status };
    if (typeof folders === 'number') {
      event.folders = folders;
    }
    if (typeof files === 'number') {
      event.files = files;
    }
    this.emit({ rescan_event: [event] }, 'rescan_event', { status, folders, files });
  }

  /**
   * Broadcasts the full storage inventory to every connected client.
   */
  public notifyStorageListUpdated(storages: StorageConfig[]): void {
    this.emit({ storage: storages }, 'storage_list', { storages: storages.length });
  }

  /**
   * Notifies clients that a storage entry was created.
   */
  public notifyStorageAdded(storage: StorageConfig): void {
    this.emit({ storage_added: [storage] }, 'storage_added', { id: storage.id });
  }

  /**
   * Notifies clients that a storage entry was removed.
   */
  public notifyStorageRemoved(id: string): void {
    this.emit({ storage_removed: [{ id }] }, 'storage_removed', { id });
  }

  /**
   * Notify Loxone music apps to reload service/account state.
   */
  public notifyReloadMusicApp(action: 'useradd' | 'userdel', provider: string, userId: string): void {
    this.emit(
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

  public notifyGlobalSearchResult(result: Record<string, any>, providerId: string, unique: string): void {
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
      this.emit(payload, 'globalsearch_result', { providerId, unique });
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

    this.emit(payload, 'globalsearch_result', { providerId, unique });
  }

  public notifyGlobalSearchError(providerId: string, unique: string): void {
    const payload = {
      globalsearch_result: {
        error: 1,
        type: providerId,
        unique,
      },
    };
    this.emit(payload, 'globalsearch_error', { providerId, unique });
  }

  public notifyAudioSyncEvent(payload: AudioSyncGroupPayload[]): void {
    this.registry.broadcastMessage(JSON.stringify({ audio_sync_event: payload }));
  }
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
