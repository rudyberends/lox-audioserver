import MusicAssistantProviderClient from './client';
import {
  MediaFolderItem,
  MediaFolderResponse,
} from '../types';
import {
  mapAlbumToFolderItem,
  mapArtistToFolderItem,
  mapTrackToMediaItem,
} from './mappers';
import {
  buildLibraryKey,
  buildLibraryUri,
  extractArtist,
  extractImage,
  extractItemId,
  extractName,
  extractUri,
  logError,
  normalizeItemKey,
  parseIdentifier,
  safeNumber,
} from './utils';
import { FileType } from '../../zone/loxoneTypes';

const STREAMING_LIBRARY_ONLY_PROVIDERS = new Set(['apple_music', 'applemusic']);
const LOCAL_LIBRARY_ORIGIN_NAS = 1;

function shouldLimitToLibrary(provider?: string): boolean {
  if (!provider) return false;
  return STREAMING_LIBRARY_ONLY_PROVIDERS.has(provider.toLowerCase());
}

export class LibraryController {
  constructor(
    private readonly getClient: () => MusicAssistantProviderClient | undefined,
    private readonly fallbackProvider: string,
    private readonly rootId: string,
    private readonly rootItems: MediaFolderItem[],
  ) {}

  async getMediaFolder(folderId: string, offset: number, limit: number): Promise<MediaFolderResponse> {
    const client = this.getClient();
    if (!client) {
      return this.buildEmptyResponse(folderId, offset);
    }

    if (!folderId || folderId === this.rootId || folderId === 'root') {
      const items = this.rootItems.slice(offset, offset + limit);
      return {
        id: this.rootId,
        name: 'Library',
        totalitems: this.rootItems.length,
        start: offset,
        items,
        type: FileType.Folder,
      };
    }

    switch (folderId) {
      case 'albums':
        return this.loadAlbums(offset, limit);
      case 'artists':
        return this.loadArtists(offset, limit);
      case 'tracks':
        return this.loadTracks(offset, limit);
      default:
        break;
    }

    const parsed = parseIdentifier(normalizeItemKey(folderId));
    if (parsed.kind === 'album' && parsed.provider && parsed.itemId) {
      return this.loadAlbumTracks(parsed.provider, parsed.itemId, offset, limit);
    }
    if (parsed.kind === 'artist' && parsed.provider && parsed.itemId) {
      return this.loadArtistTracks(parsed.provider, parsed.itemId, offset, limit);
    }

    return this.buildEmptyResponse(folderId, offset);
  }

  async resolveMediaItem(folderId: string, itemId: string): Promise<MediaFolderItem | undefined> {
    const client = this.getClient();
    if (!client) return undefined;

    const effectiveKey = normalizeItemKey(itemId || folderId);
    const parsed = parseIdentifier(effectiveKey);

    try {
      switch (parsed.kind) {
        case 'album':
          if (!parsed.provider || !parsed.itemId) return undefined;
          return this.resolveAlbum(parsed.provider, parsed.itemId);
        case 'artist':
          if (!parsed.provider || !parsed.itemId) return undefined;
          return this.resolveArtist(parsed.provider, parsed.itemId);
        case 'track':
          if (!parsed.provider || !parsed.itemId) return undefined;
          return this.resolveTrack(parsed.provider, parsed.itemId);
        default:
          break;
      }
    } catch (error) {
      logError(`resolveMediaItem:${parsed.kind}`, error);
    }

    return undefined;
  }

  private async loadAlbums(offset: number, limit: number): Promise<MediaFolderResponse> {
    const client = this.getClient();
    if (!client) {
      return this.buildEmptyResponse('albums', offset);
    }

    try {
      const [albums, totalitems] = await Promise.all([
        client.rpc<any[]>('music/albums/library_items', { offset, limit }),
        client.rpc<number>('music/albums/count').catch(() => undefined),
      ]);

      const items = Array.isArray(albums)
        ? albums.map((album) => mapAlbumToFolderItem(album, this.fallbackProvider))
        : [];

      return {
        id: 'albums',
        name: 'Albums',
        totalitems: totalitems ?? items.length,
        start: offset,
        items,
        type: FileType.Folder,
      };
    } catch (error) {
      logError('music/albums/library_items', error);
      return this.buildEmptyResponse('albums', offset);
    }
  }

  private async loadArtists(offset: number, limit: number): Promise<MediaFolderResponse> {
    const client = this.getClient();
    if (!client) {
      return this.buildEmptyResponse('artists', offset);
    }

    try {
      const [artists, totalitems] = await Promise.all([
        client.rpc<any[]>('music/artists/library_items', { offset, limit }),
        client.rpc<number>('music/artists/count').catch(() => undefined),
      ]);

      const items = Array.isArray(artists)
        ? artists.map((artist) => mapArtistToFolderItem(artist, this.fallbackProvider))
        : [];

      return {
        id: 'artists',
        name: 'Artists',
        totalitems: totalitems ?? items.length,
        start: offset,
        items,
        type: FileType.Folder,
      };
    } catch (error) {
      logError('music/artists/library_items', error);
      return this.buildEmptyResponse('artists', offset);
    }
  }

  private async loadTracks(offset: number, limit: number): Promise<MediaFolderResponse> {
    const client = this.getClient();
    if (!client) {
      return this.buildEmptyResponse('tracks', offset);
    }

    try {
      const [tracks, totalitems] = await Promise.all([
        client.rpc<any[]>('music/tracks/library_items', { offset, limit }),
        client.rpc<number>('music/tracks/count').catch(() => undefined),
      ]);

      const items = Array.isArray(tracks)
        ? tracks.map((track) => mapTrackToMediaItem(track, this.fallbackProvider))
        : [];

      return {
        id: 'tracks',
        name: 'Tracks',
        totalitems: totalitems ?? items.length,
        start: offset,
        items,
        type: FileType.Folder,
      };
    } catch (error) {
      logError('music/tracks/library_items', error);
      return this.buildEmptyResponse('tracks', offset);
    }
  }

  private async loadAlbumTracks(
    provider: string,
    albumId: string,
    offset: number,
    limit: number,
  ): Promise<MediaFolderResponse> {
    const client = this.getClient();
    if (!client) {
      return this.buildEmptyResponse(buildLibraryKey('album', provider, albumId), offset);
    }

    try {
      const inLibraryOnly = shouldLimitToLibrary(provider);
      const [album, tracks] = await Promise.all([
        client.rpc<any>('music/albums/get_album', {
          item_id: albumId,
          provider_instance_id_or_domain: provider,
        }),
        client.rpc<any[]>('music/albums/album_tracks', {
          item_id: albumId,
          provider_instance_id_or_domain: provider,
          limit,
          offset,
          in_library_only: inLibraryOnly || undefined,
        }),
      ]);

      const items = Array.isArray(tracks)
        ? tracks.map((track) => mapTrackToMediaItem(track, this.fallbackProvider, provider, album))
        : [];

      const totalitems = safeNumber(album?.track_count ?? tracks?.length ?? items.length, items.length);
      const id = buildLibraryKey('album', provider, albumId);

      return {
        id,
        name: extractName(album),
        totalitems: totalitems ?? items.length,
        start: offset,
        items,
        coverurl: extractImage(album) ?? undefined,
        artist: extractArtist(album) ?? undefined,
        type: FileType.Folder,
      };
    } catch (error) {
      logError('music/albums/album_tracks', error);
      return this.buildEmptyResponse(buildLibraryKey('album', provider, albumId), offset);
    }
  }

  private async loadArtistTracks(
    provider: string,
    artistId: string,
    offset: number,
    limit: number,
  ): Promise<MediaFolderResponse> {
    const client = this.getClient();
    if (!client) {
      return this.buildEmptyResponse(buildLibraryKey('artist', provider, artistId), offset);
    }

    try {
      const inLibraryOnly = shouldLimitToLibrary(provider);
      const [artist, tracks] = await Promise.all([
        client.rpc<any>('music/artists/get_artist', {
          item_id: artistId,
          provider_instance_id_or_domain: provider,
        }),
        client.rpc<any[]>('music/artists/artist_tracks', {
          item_id: artistId,
          provider_instance_id_or_domain: provider,
          limit,
          offset,
          in_library_only: inLibraryOnly || undefined,
        }),
      ]);

      const items = Array.isArray(tracks)
        ? tracks.map((track) => mapTrackToMediaItem(track, this.fallbackProvider, provider))
        : [];

      const totalitems = safeNumber(tracks?.length ?? items.length, items.length);
      const id = buildLibraryKey('artist', provider, artistId);

      return {
        id,
        name: extractName(artist),
        totalitems: totalitems ?? items.length,
        start: offset,
        items,
        coverurl: extractImage(artist) ?? undefined,
        artist: extractArtist(artist) ?? undefined,
        type: FileType.Folder,
      };
    } catch (error) {
      logError('music/artists/artist_tracks', error);
      return this.buildEmptyResponse(buildLibraryKey('artist', provider, artistId), offset);
    }
  }

  private async resolveAlbum(provider: string, albumId: string): Promise<MediaFolderItem | undefined> {
    const client = this.getClient();
    if (!client) return undefined;

    const album = await client.rpc<any>('music/albums/get_album', {
      item_id: albumId,
      provider_instance_id_or_domain: provider,
    });
    if (!album) return undefined;

    const name = extractName(album) ?? albumId;
    const rawId = extractItemId(album) ?? albumId;
    const uri = extractUri(album, 'album', rawId, provider) ?? buildLibraryUri('album', rawId, provider);
    const key = buildLibraryKey('album', provider, rawId);

    return {
      id: key,
      name,
      cmd: key,
      type: FileType.PlaylistEditable,
      contentType: 'Album',
      sort: 'alpha',
      coverurl: extractImage(album) ?? '',
      audiopath: uri,
      provider,
      rawId,
      items: safeNumber(album?.track_count),
      album: name,
      artist: extractArtist(album) ?? undefined,
      tag: 'album',
      nas: true,
      origin: LOCAL_LIBRARY_ORIGIN_NAS,
    };
  }

  private async resolveArtist(provider: string, artistId: string): Promise<MediaFolderItem | undefined> {
    const client = this.getClient();
    if (!client) return undefined;

    const artist = await client.rpc<any>('music/artists/get_artist', {
      item_id: artistId,
      provider_instance_id_or_domain: provider,
    });
    if (!artist) return undefined;

    const name = extractName(artist) ?? artistId;
    const rawId = extractItemId(artist) ?? artistId;
    const uri = extractUri(artist, 'artist', rawId, provider) ?? buildLibraryUri('artist', rawId, provider);
    const key = buildLibraryKey('artist', provider, rawId);

    return {
      id: key,
      name,
      cmd: key,
      type: FileType.PlaylistBrowsable,
      contentType: 'Artist',
      sort: 'alpha',
      coverurl: extractImage(artist) ?? '',
      audiopath: uri,
      provider,
      rawId,
      artist: name,
      tag: 'artist',
      nas: true,
      origin: LOCAL_LIBRARY_ORIGIN_NAS,
    };
  }

  private async resolveTrack(provider: string, trackId: string): Promise<MediaFolderItem | undefined> {
    const client = this.getClient();
    if (!client) return undefined;

    try {
      const track = await client.rpc<any>('music/tracks/get_track', {
        item_id: trackId,
        provider_instance_id_or_domain: provider,
        in_library_only: shouldLimitToLibrary(provider) || undefined,
      });
      if (!track) return undefined;

      return mapTrackToMediaItem(track, this.fallbackProvider, provider);
    } catch (error) {
      logError('music/tracks/get_track', error);
      const fallbackKey = buildLibraryKey('track', provider, trackId);
      const fallbackUri = buildLibraryUri('track', trackId, provider);
      return {
        id: fallbackKey,
        name: trackId,
        cmd: fallbackKey,
        type: FileType.File,
        contentType: 'Track',
      audiopath: fallbackUri,
      provider,
      rawId: trackId,
      title: trackId,
      tag: 'track',
      nas: true,
      origin: LOCAL_LIBRARY_ORIGIN_NAS,
    };
  }
}

  private buildEmptyResponse(id: string, offset: number): MediaFolderResponse {
    return {
      id,
      totalitems: 0,
      start: offset,
      items: [],
      type: FileType.Folder,
    };
  }
}

export default LibraryController;
