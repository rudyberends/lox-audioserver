import MusicAssistantProviderClient from './client';
import {
  PlaylistItem,
  PlaylistResponse,
} from '../types';
import {
  mapPlaylistToItem,
  mapTrackToPlaylistItem,
} from './mappers';
import {
  extractImage,
  extractItemId,
  extractName,
  extractUri,
  logError,
  parseIdentifier,
  safeNumber,
  toPlaylistCommandUri,
} from './utils';

export class PlaylistController {
  constructor(
    private readonly getClient: () => MusicAssistantProviderClient | undefined,
    private readonly fallbackProvider: string,
    private readonly providerLabel: string,
  ) {}

  private shouldLimitToLibrary(provider?: string): boolean {
    if (!provider) return false;
    const normalized = provider.toLowerCase();
    return normalized === 'apple_music' || normalized === 'applemusic';
  }

  async getPlaylists(offset: number, limit: number): Promise<PlaylistResponse> {
    const client = this.getClient();
    if (!client) {
      return this.buildEmptyResponse(offset);
    }

    try {
      const [playlists, totalitems] = await Promise.all([
        client.rpc<any[]>('music/playlists/library_items', { offset, limit }),
        client.rpc<number>('music/playlists/count').catch(() => undefined),
      ]);

      const items = Array.isArray(playlists)
        ? await Promise.all(
            playlists.map(async (playlist) => {
              const mapped = mapPlaylistToItem(playlist, this.fallbackProvider);
              if (!mapped.coverurl) {
                const providerInstance = mapped.provider ?? this.fallbackProvider;
                const inLibraryOnly = this.shouldLimitToLibrary(providerInstance);
                try {
                  const firstTrack = await client.rpc<any[]>('music/playlists/playlist_tracks', {
                    item_id: mapped.rawId ?? mapped.id,
                    provider_instance_id_or_domain: providerInstance,
                    limit: 1,
                    offset: 0,
                    in_library_only: inLibraryOnly || undefined,
                  });
                  const cover = Array.isArray(firstTrack) && firstTrack.length > 0 ? extractImage(firstTrack[0]) ?? '' : '';
                  if (cover) {
                    mapped.coverurl = cover;
                    mapped.thumbnail = cover;
                    mapped.playlistCover = cover;
                  }
                } catch (error) {
                  logError('music/playlists/playlist_tracks', error);
                }
              }
              return mapped;
            }),
          )
        : [];

      return {
        id: 0,
        name: `${this.providerLabel} Playlists`,
        totalitems: totalitems ?? items.length,
        start: offset,
        items,
      };
    } catch (error) {
      logError('music/playlists/library_items', error);
      return this.buildEmptyResponse(offset);
    }
  }

  async getPlaylistItems(
    playlistKey: string,
    offset: number,
    limit: number,
  ): Promise<PlaylistResponse | undefined> {
    const client = this.getClient();
    if (!client) return undefined;

    const parsed = parseIdentifier(playlistKey);
    if (parsed.kind !== 'playlist' || !parsed.itemId) {
      return undefined;
    }

    const provider = parsed.provider ?? this.fallbackProvider;
    const itemId = parsed.itemId;

    try {
      const inLibraryOnly = this.shouldLimitToLibrary(provider);
      const [playlist, tracks] = await Promise.all([
        client.rpc<any>('music/playlists/get_playlist', {
          item_id: itemId,
          provider_instance_id_or_domain: provider,
        }),
        client.rpc<any[]>('music/playlists/playlist_tracks', {
          item_id: itemId,
          provider_instance_id_or_domain: provider,
          limit,
          offset,
          in_library_only: inLibraryOnly || undefined,
        }),
      ]);

      const mapped = Array.isArray(tracks)
        ? tracks.map((track) => mapTrackToPlaylistItem(track, this.fallbackProvider, provider, playlist))
        : [];

      const totalitems = safeNumber(
        playlist?.track_count ??
          playlist?.items?.length ??
          playlist?.tracks?.length ??
          tracks?.length,
        mapped.length,
      );

      const rawUri =
        extractUri(playlist, 'playlist', itemId, provider) ??
        `playlist:${itemId}`;
      const playlistUri = toPlaylistCommandUri(rawUri, provider, itemId);

      const playlistCover = extractImage(playlist) ?? mapped.find((item) => item.coverurl)?.coverurl ?? '';
      if (playlistCover) {
        mapped.forEach((item) => {
          if (!item.playlistCover) item.playlistCover = playlistCover;
          if (!item.coverurl) item.coverurl = playlistCover;
        });
      }

      return {
        id: playlistUri,
        name: extractName(playlist) ?? itemId,
        totalitems: totalitems ?? mapped.length,
        start: offset,
        items: mapped,
        coverurl: playlistCover,
        thumbnail: playlistCover,
      };
    } catch (error) {
      logError('music/playlists/playlist_tracks', error);
      return undefined;
    }
  }

  async resolvePlaylist(playlistId: string): Promise<PlaylistItem | undefined> {
    const client = this.getClient();
    if (!client) return undefined;

    const parsed = parseIdentifier(playlistId);
    if (parsed.kind !== 'playlist' || !parsed.itemId) {
      return undefined;
    }

    const provider = parsed.provider ?? this.fallbackProvider;
    const itemId = parsed.itemId;

    try {
      const playlist = await client.rpc<any>('music/playlists/get_playlist', {
        item_id: itemId,
        provider_instance_id_or_domain: provider,
      });

      if (!playlist) return undefined;

      const mapped = mapPlaylistToItem(playlist, this.fallbackProvider);
      const rawId = extractItemId(playlist) ?? itemId;
      const rawUri =
        extractUri(playlist, 'playlist', rawId, provider) ??
        `playlist:${rawId}`;
      const playlistUri = toPlaylistCommandUri(rawUri, provider, rawId);
      const totalitems = safeNumber(
        playlist?.track_count ??
          playlist?.items?.length ??
          playlist?.tracks?.length,
      );

      return {
        ...mapped,
        id: playlistUri,
        audiopath: playlistUri,
        provider: provider ?? mapped.provider,
        providerInstanceId: provider ?? mapped.providerInstanceId,
        playlistProviderInstanceId: provider ?? mapped.playlistProviderInstanceId,
        playlistCommandUri: playlistUri,
        playlistId: playlistUri,
        items: totalitems,
        coverurl: extractImage(playlist) ?? mapped.coverurl ?? '',
        rawId,
      };
    } catch (error) {
      logError('music/playlists/get_playlist', error);
      return undefined;
    }
  }

  private buildEmptyResponse(offset: number): PlaylistResponse {
    return {
      id: 0,
      name: `${this.providerLabel} Playlists`,
      totalitems: 0,
      start: offset,
      items: [],
    };
  }
}

export default PlaylistController;
