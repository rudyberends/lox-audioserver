import logger from '@/utils/troxorLogger';
import type { EventMessage } from './types';
import MusicAssistantClient from './client';

/**
 * -----------------------------------------------------------------------------
 * MusicAssistantApi
 * -----------------------------------------------------------------------------
 * High-level, type-safe wrapper around MusicAssistantClient.
 *
 * Provides:
 *  - Player control (play, pause, stop, next, previous, setVolume, repeat, shuffle)
 *  - Queue operations (getAllQueues, getQueue, getQueueItems)
 *  - Player info (getAllPlayers, getPlayer)
 *  - Group sync (syncToPlayer, unsyncPlayer)
 *  - Event subscription (onEvent)
 *
 * Design goals:
 *  - Shared singleton per server (ip:port)
 *  - Fail-safe RPC calls with logging and fallbacks
 *  - Easy to extend and reuse by both CommandMapper and StateMapper
 * -----------------------------------------------------------------------------
 */
export class MusicAssistantApi {
  private static readonly instances = new Map<
    string,
    { api: MusicAssistantApi; refCount: number }
  >();

  private readonly ip: string;
  private readonly port: number;
  private readonly client: MusicAssistantClient;
  private readonly instanceKey: string;
  private isConnected = false;

  private constructor(ip: string, port = 8095) {
    this.ip = ip;
    this.port = port;
    this.client = new MusicAssistantClient(ip, port);
    this.instanceKey = MusicAssistantApi.toKey(ip, port);
  }

  /* -------------------------------------------------------------------------- */
  /* Singleton Factory                                                          */
  /* -------------------------------------------------------------------------- */

  private static toKey(ip: string, port: number): string {
    return `${ip}:${port}`;
  }

  /** Acquire (and reference count) a shared instance for the given server. */
  public static acquire(ip: string, port = 8095): MusicAssistantApi {
    const key = this.toKey(ip, port);
    let entry = this.instances.get(key);
    if (!entry) {
      entry = { api: new MusicAssistantApi(ip, port), refCount: 0 };
      this.instances.set(key, entry);
    }
    entry.refCount += 1;
    return entry.api;
  }

  /** Returns an existing instance without modifying reference counts. */
  public static getInstance(ip: string, port = 8095): MusicAssistantApi {
    const key = this.toKey(ip, port);
    let entry = this.instances.get(key);
    if (!entry) {
      entry = { api: new MusicAssistantApi(ip, port), refCount: 0 };
      this.instances.set(key, entry);
    }
    return entry.api;
  }

  /* -------------------------------------------------------------------------- */
  /* Connection Lifecycle                                                       */
  /* -------------------------------------------------------------------------- */

  /** Connects (if not already connected) to the Music Assistant backend. */
  public async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    try {
      await this.client.connect();
      this.isConnected = true;
      logger.info(`[MusicAssistantApi] Connected to ${this.ip}:${this.port}`);
    } catch (err) {
      this.isConnected = false;
      logger.warn(`[MusicAssistantApi] Connection failed: ${String(err)}`);
      throw err;
    }
  }

  /** Registers a global event listener for WebSocket messages. */
  public onEvent(callback: (evt: EventMessage) => void): () => void {
    return this.client.onEvent(callback);
  }

  /** Closes the client connection (if no zones need it anymore). */
  public dispose(): void {
    this.release();
  }

  /** Decrement reference count and dispose underlying connection when idle. */
  public release(): void {
    const entry = MusicAssistantApi.instances.get(this.instanceKey);
    if (!entry || entry.api !== this) {
      return;
    }
    entry.refCount = Math.max(0, entry.refCount - 1);
    if (entry.refCount === 0) {
      this.teardown();
      MusicAssistantApi.instances.delete(this.instanceKey);
    }
  }

  private teardown(): void {
    this.isConnected = false;
    this.client.dispose();
    logger.debug(`[MusicAssistantApi] Disposed connection to ${this.ip}:${this.port}`);
  }

  /* -------------------------------------------------------------------------- */
  /* Player Control Commands                                                    */
  /* -------------------------------------------------------------------------- */

  public async play(playerId: string): Promise<void> {
    await this.safeRpc('players/cmd/play', { player_id: playerId });
  }

  public async pause(playerId: string): Promise<void> {
    await this.safeRpc('players/cmd/pause', { player_id: playerId });
  }

  public async stop(playerId: string): Promise<void> {
    await this.safeRpc('players/cmd/stop', { player_id: playerId });
  }

  public async next(playerId: string): Promise<void> {
    await this.safeRpc('players/cmd/next', { player_id: playerId });
  }

  public async previous(playerId: string): Promise<void> {
    await this.safeRpc('players/cmd/previous', { player_id: playerId });
  }

  public async setVolume(playerId: string, volume: number): Promise<void> {
    await this.safeRpc('players/cmd/volume_set', {
      player_id: playerId,
      volume_level: Math.max(0, Math.min(100, volume)),
    });
  }

  public async repeat(playerId: string, mode: string | number): Promise<void> {
    await this.safeRpc('player_queues/repeat', {
      queue_id: playerId,
      repeat_mode: mode,
    });
  }

  public async position(playerId: string, position: string): Promise<void> {
    await this.safeRpc('players/cmd/seek', {
      player_id: playerId,
      position: position,
    });
  }

  public async shuffle(playerId: string, enabled: boolean): Promise<void> {
    await this.safeRpc('player_queues/shuffle', {
      queue_id: playerId,
      shuffle_enabled: enabled,
    });
  }

  //search
  public async search(query: string, limit = 10): Promise<any> {
    return this.safeRpc('music/search', { search_query: query, limit });
  }

  /* -------------------------------------------------------------------------- */
  /* Queue Operations                                                           */
  /* -------------------------------------------------------------------------- */

  public async getAllQueues(): Promise<any[]> {
    return this.safeRpc('player_queues/all', undefined, []);
  }

  public async getQueue(queueId: string): Promise<any | null> {
    if (!queueId) {
      return null;
    }
    return this.safeRpc('player_queues/get', { queue_id: queueId }, null);
  }

  public async getQueueItems(queueId: string, limit = 250): Promise<any[]> {
    if (!queueId) {
      return [];
    }
    return this.safeRpc('player_queues/items', { queue_id: queueId, offset: 0, limit }, []);
  }

  public async playMedia(
    queueId: string,
    media: string | string[] | Record<string, unknown> | Record<string, unknown>[],
    options?: {
      option?: string;
      radio_mode?: boolean;
      start_item?: string;
      shuffle?: boolean;
      extraArgs?: Record<string, unknown>;
    },
  ): Promise<void> {

    const mediaList = Array.isArray(media) ? media.filter(Boolean) : [media].filter(Boolean);
    if (!queueId || mediaList.length === 0) {
      return;
    }

    const payloadMedia = mediaList.length === 1 ? mediaList[0] : mediaList;

    const payload: Record<string, unknown> = {
      queue_id: queueId,
      media: payloadMedia,
      option: options?.option || 'replace',
    };

    if (options?.start_item) {
      payload.start_item = options.start_item;
    }

    if (options?.extraArgs) {
      Object.assign(payload, options.extraArgs);
    }

    await this.safeRpc('player_queues/play_media', payload);

    if (typeof options?.shuffle === 'boolean') {
      await this.safeRpc('player_queues/shuffle', {
        queue_id: queueId,
        shuffle_enabled: options.shuffle,
      });
    }
  }

  public async playAnnouncement(
    playerId: string,
    payload: {
      url: string;
      preAnnounce?: boolean;
      preAnnounceUrl?: string;
      volumeLevel?: number;
      playerGroup?: boolean;
      expirationSecs?: number;
      extraArgs?: Record<string, unknown>;
    },
  ): Promise<void> {
    if (!playerId || !payload?.url) {
      return;
    }

    const args: Record<string, unknown> = {
      player_id: playerId,
      url: payload.url,
    };

    if (typeof payload.preAnnounce === 'boolean') {
      args.pre_announce = payload.preAnnounce;
    }
    if (payload.preAnnounceUrl) {
      args.pre_announce_url = payload.preAnnounceUrl;
    }
    if (typeof payload.volumeLevel === 'number') {
      args.volume_level = payload.volumeLevel;
    }
    if (typeof payload.playerGroup === 'boolean') {
      args.player_group = payload.playerGroup;
    }
    if (typeof payload.expirationSecs === 'number') {
      args.expiration_secs = payload.expirationSecs;
    }
    if (payload.extraArgs) {
      Object.assign(args, payload.extraArgs);
    }

    await this.safeRpc('players/cmd/play_announcement', args);
  }

  /* -------------------------------------------------------------------------- */
  /* Library & Playlist Operations                                              */
  /* -------------------------------------------------------------------------- */

  public async getRecentlyPlayedItems(limit = 50): Promise<any[]> {
    const payload = await this.safeRpc<any>(
      'music/recently_played_items',
      { limit },
      [],
    );

    if (Array.isArray(payload)) {
      return payload;
    }
    if (payload && Array.isArray(payload.items)) {
      return payload.items;
    }
    if (payload && Array.isArray(payload.results)) {
      return payload.results;
    }
    return [];
  }

  public async clearRecentlyPlayedItems(): Promise<void> {
    const sentinel = Symbol('ma-clear-recently-played-failure');
    const commands = ['music/recently_played_items/clear', 'music/clear_recently_played'];
    for (const endpoint of commands) {
      const result = await this.safeRpc<unknown>(endpoint, undefined, sentinel);
      if (result !== sentinel) {
        return;
      }
    }
  }

  public async getLibraryAlbums(limit = 50, offset = 0): Promise<{ items: any[]; total: number }> {
    const items = await this.safeRpc<any[]>('music/albums/library_items', { limit, offset }, []);
    const total = await this.safeRpc<number | null>('music/albums/count', undefined, null);
    return { items, total: typeof total === 'number' ? total : items.length };
  }

  public async getLibraryArtists(limit = 50, offset = 0): Promise<{ items: any[]; total: number }> {
    const items = await this.safeRpc<any[]>('music/artists/library_items', { limit, offset }, []);
    const total = await this.safeRpc<number | null>('music/artists/count', undefined, null);
    return { items, total: typeof total === 'number' ? total : items.length };
  }

  public async getLibraryTracks(limit = 50, offset = 0): Promise<{ items: any[]; total: number }> {
    const items = await this.safeRpc<any[]>('music/tracks/library_items', { limit, offset }, []);
    const total = await this.safeRpc<number | null>('music/tracks/count', undefined, null);
    return { items, total: typeof total === 'number' ? total : items.length };
  }

  public async getAlbum(provider: string, albumId: string): Promise<any | null> {
    return this.safeRpc('music/albums/get_album', { item_id: albumId, provider_instance_id_or_domain: 'library' }, null);
  }

  public async getAlbumTracks(
    provider: string,
    albumId: string,
    offset = 0,
    limit = 50,
    inLibraryOnly?: boolean,
  ): Promise<any[]> {
    return this.safeRpc('music/albums/album_tracks', {
      item_id: albumId,
      provider_instance_id_or_domain: 'library',
      offset,
      limit,
      in_library_only: inLibraryOnly || undefined,
    }, []);
  }

  public async getArtist(provider: string, artistId: string): Promise<any | null> {
    return this.safeRpc('music/artists/get_artist', { item_id: artistId, provider_instance_id_or_domain: provider }, null);
  }

  public async getArtistTracks(
    provider: string,
    artistId: string,
    offset = 0,
    limit = 50,
    inLibraryOnly?: boolean,
  ): Promise<any[]> {
    return this.safeRpc('music/artists/artist_tracks', {
      item_id: artistId,
      provider_instance_id_or_domain: provider,
      offset,
      limit,
      in_library_only: inLibraryOnly || undefined,
    }, []);
  }

  public async getTrack(provider: string, track: string, inLibraryOnly?: boolean): Promise<any | null> {
    const trackId = provider !== 'library' ? track.split('/').pop() ?? track : track;
    return this.safeRpc('music/tracks/get_track', {
      item_id: trackId,
      provider_instance_id_or_domain: provider,
      in_library_only: inLibraryOnly || undefined,
    }, null);
  }

  public async getRadio(provider: string, station: string, inLibraryOnly?: boolean): Promise<any | null> {
  // Expected format: radio://radio/1 or library://radio/1
    const stationId = station.split('/').pop() ?? station;
    return this.safeRpc('music/radios/get_radio', {
      item_id: stationId,
      provider_instance_id_or_domain: provider || 'library',
      in_library_only: inLibraryOnly || undefined,
    }, null);
  }

  public async getLibraryPlaylists(limit = 50, offset = 0): Promise<{ items: any[]; total: number }> {
    const items = await this.safeRpc<any[]>('music/playlists/library_items', { limit, offset }, []);
    const total = await this.safeRpc<number | null>('music/playlists/count', undefined, null);
    return { items, total: typeof total === 'number' ? total : items.length };
  }

  public async getPlaylist(provider: string, playlistId: string): Promise<any | null> {
    return this.safeRpc('music/playlists/get_playlist', {
      item_id: playlistId,
      provider_instance_id_or_domain: provider,
    }, null);
  }

  public async getPlaylistTracks(playlistId: string, provider = 'library'): Promise<{ items: any[]; total: number }> {
    const raw = await this.safeRpc<any[]>('music/playlists/playlist_tracks', {
      item_id: playlistId,
      provider_instance_id_or_domain: provider,
      in_library_only: false,
    }, []);

    const items = Array.isArray(raw) ? raw : [];
    return { items, total: items.length };
  }

  public async getLibraryRadios(limit = 200, offset = 0): Promise<{ items: any[]; total: number }> {
    const items = await this.safeRpc<any[]>('music/radios/library_items', { limit, offset }, []);
    const total = await this.safeRpc<number | null>('music/radios/count', undefined, null);
    return { items, total: typeof total === 'number' ? total : items.length };
  }

  /** Fetch recently played items via Music Assistant RPC */
  public async getRecentlyPlayed(limit = 50, offset = 0): Promise<{ items: any[]; total: number }> {
    // Dezelfde stijl als getLibraryRadios()
    const items = await this.safeRpc<any[]>(
      'music/recently_played_items',
      { limit, offset },
      [],
    );

    // Als de backend geen aparte 'count' RPC heeft, berekenen we de total locally
    const total = Array.isArray(items) ? items.length : 0;

    return { items, total };
  }

  /** Clear recently played list via Music Assistant RPC */
  public async clearRecentlyPlayed(): Promise<void> {
    try {
      await this.safeRpc('music/recently_played_items/clear', undefined, null);
    } catch (err) {
      await this.safeRpc('music/clear_recently_played', undefined, null);
      logger.error(err);
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Player Info                                                                */
  /* -------------------------------------------------------------------------- */

  public async refreshFullState(): Promise<null> {
    // Todo: refresh full state. MusicAssistant never pushes initial state on connect
    //this.safeRpc('players/all', undefined, []);
    return null;
    // Todo: refresh full state. MusicAssistant never pushes initial state on connect
  }

  public async getAllPlayers(): Promise<any[]> {
    return this.safeRpc('players/all', undefined, []);
  }

  public async getPlayer(playerId: string): Promise<any | null> {
    if (!playerId) {
      return null;
    }
    return this.safeRpc('players/get', { player_id: playerId }, null);
  }

  /* -------------------------------------------------------------------------- */
  /* Grouping (Current MA build, via RPC commands)                               */
  /* -------------------------------------------------------------------------- */

  /**
 * Join another player as a follower (child).
 * Equivalent to: players/cmd/group
 */
  public async groupJoin(playerId: string, leaderId: string): Promise<void> {
    try {
      await this.safeRpc('players/cmd/group', {
        player_id: playerId,
        target_player: leaderId,
      });
      logger.debug(`[MusicAssistantApi] ${playerId} joined group led by ${leaderId}`);
    } catch (err) {
      logger.warn(`[MusicAssistantApi] groupJoin failed: ${String(err)}`);
    }
  }

  /**
 * Make this player the leader and attach multiple members.
 * Equivalent to: players/cmd/group_many
 */
  public async groupJoinMany(leaderId: string, childIds: string[]): Promise<void> {
    if (!childIds.length) {
      return;
    }
    try {
      await this.safeRpc('players/cmd/group_many', {
        target_player: leaderId,
        child_player_ids: childIds,
      });
      logger.debug(`[MusicAssistantApi] Leader ${leaderId} grouped members: ${childIds.join(',')}`);
    } catch (err) {
      logger.warn(`[MusicAssistantApi] groupJoinMany failed: ${String(err)}`);
    }
  }

  /**
 * Detach a single player from any group.
 * Equivalent to: players/cmd/ungroup
 */
  public async groupLeave(playerId: string): Promise<void> {
    try {
      await this.safeRpc('players/cmd/ungroup', { player_id: playerId });
      logger.debug(`[MusicAssistantApi] Player ${playerId} left its group`);
    } catch (err) {
      logger.warn(`[MusicAssistantApi] groupLeave failed: ${String(err)}`);
    }
  }

  /**
 * Detach multiple players from their groups.
 * Equivalent to: players/cmd/ungroup_many
 */
  public async groupLeaveMany(playerIds: string[]): Promise<void> {
    if (!playerIds.length) {
      return;
    }
    try {
      await this.safeRpc('players/cmd/ungroup_many', { player_ids: playerIds });
      logger.debug(`[MusicAssistantApi] Ungrouped players: ${playerIds.join(',')}`);
    } catch (err) {
      logger.warn(`[MusicAssistantApi] groupLeaveMany failed: ${String(err)}`);
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Internal RPC Helper                                                        */
  /* -------------------------------------------------------------------------- */

  /**
   * Wrapper around MusicAssistantClient.rpc() with safe logging and fallback.
   */
  private async safeRpc<T = any>(
    endpoint: string,
    params?: Record<string, any>,
    fallback?: T,
  ): Promise<T> {
    try {
      const snapshot = (() => {
        try {
          return params ? JSON.stringify(params) : '{}';
        } catch {
          return '[unserializable]';
        }
      })();
      logger.debug(`[MusicAssistantApi] RPC request ${endpoint} → params=${snapshot}`);
      const result = await this.client.rpc(endpoint, params);
      return result as T;
    } catch (err) {
      logger.error(`[MusicAssistantApi] RPC failed for ${endpoint}: ${String(err)}`);
      return fallback as T;
    }
  }
}

