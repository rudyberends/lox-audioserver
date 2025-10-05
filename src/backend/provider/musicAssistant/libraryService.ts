import logger from '../../../utils/troxorlogger';
import { MediaFolderItem, MediaFolderResponse } from '../types';
import { MusicAssistantProviderClient } from './providerClient';

const DEFAULT_LIMIT = 50;

/**
 * Maps Music Assistant library endpoints to the Loxone media folder contract,
 * translating ids and caching lookups so navigation stays snappy.
 */
export class MusicAssistantLibraryService {
  private readonly folderCache = new Map<string, Map<string, MediaFolderItem>>();

  constructor(private readonly client: MusicAssistantProviderClient) {}

  /** Normalize incoming folder ids (from service or UI) to Music Assistant aliases. */
  resolveFolderAlias(folderId: string): string {
    const decoded = decodeURIComponent(folderId ?? '').trim();
    const lower = decoded.toLowerCase();
    const aliasMap: Record<string, string> = {
      '5': 'albums',
      albums: 'albums',
      '6': 'artists',
      artists: 'artists',
      '7': 'tracks',
      tracks: 'tracks',
    };
    if (aliasMap[lower]) {
      return aliasMap[lower];
    }

    const segments = decoded
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .filter(Boolean);
    if (segments.length > 1) {
      const pairs: string[] = [];
      for (let i = 0; i < segments.length; i += 2) {
        const base = segments[i];
        const value = segments[i + 1];
        if (value !== undefined) {
          pairs.push(`${base}:${value}`);
        } else {
          pairs.push(base);
        }
      }
      return pairs[pairs.length - 1];
    }

    return decoded;
  }

  /** Try resolving service folders that should surface library detail nodes. */
  async getServiceFolder(
    _service: string,
    folderId: string,
    _user: string,
    offset: number,
    limit: number,
  ): Promise<MediaFolderResponse | undefined> {
    const alias = this.resolveFolderAlias(folderId);
    const normalized = alias.toLowerCase();
    if (!normalized || normalized === 'start' || normalized === 'root') return undefined;

    const isArtistId =
      normalized.includes(':artist:') ||
      normalized.startsWith('artists:') ||
      (normalized && /^[0-9]+$/.test(normalized) && this.lookupItem('artists', normalized));
    if (isArtistId) {
      const artistFolder = await this.getArtistByDirectId(alias, offset, limit);
      if (artistFolder.items.length > 0 || artistFolder.totalitems > 0) {
        return artistFolder;
      }
    }

    if (normalized.includes(':album:')) {
      return await this.getAlbumByDirectId(alias, offset, limit);
    }

    if (normalized.includes(':track:')) {
      const track = await this.resolveItem('', normalized);
      if (!track) return this.emptyResponse(folderId, offset);
      return {
        id: folderId,
        name: track.name,
        tag: 'track',
        type: track.type,
        thumbnail: track.thumbnail ?? track.coverurl,
        coverurl: track.coverurl,
        artist: track.artist,
        totalitems: 1,
        start: 0,
        items: [track],
      };
    }

    const albumAttempt = await this.getAlbumByDirectId(alias, offset, limit);
    if (albumAttempt.items.length > 0 || albumAttempt.totalitems > 0) {
      return albumAttempt;
    }

    if (!isArtistId) {
      const artistAttempt = await this.getArtistByDirectId(alias, offset, limit);
      if (artistAttempt.items.length > 0 || artistAttempt.totalitems > 0) {
        return artistAttempt;
      }
    }

    return undefined;
  }

  /** Fetch paginated content for the UI library browser, falling back to empty sets. */
  async getFolder(folderId: string, offset: number, limit: number): Promise<MediaFolderResponse> {
    const alias = this.resolveFolderAlias(folderId);
    const normalized = alias.toLowerCase();
    const effectiveLimit = limit > 0 ? limit : DEFAULT_LIMIT;

    if (!normalized) {
      return this.emptyResponse(folderId, offset);
    }

    if (normalized === 'albums') {
      const result = await this.getAlbums(alias, offset, effectiveLimit);
      this.storeFolderItems(normalized, result.items);
      return result;
    }

    if (normalized.startsWith('albums:')) {
      const albumId = alias.substring('albums:'.length);
      const result = await this.getAlbumTracks(alias, albumId, offset, effectiveLimit);
      this.storeFolderItems(normalized, result.items);
      return result;
    }

    if (normalized.includes(':album:')) {
      return this.getAlbumByDirectId(alias, offset, effectiveLimit);
    }

    if (normalized === 'artists') {
      const result = await this.getArtists(alias, offset, effectiveLimit);
      this.storeFolderItems(normalized, result.items);
      return result;
    }

    if (normalized.startsWith('artists:')) {
      const artistId = alias.substring('artists:'.length);
      const result = await this.getArtistAlbums(alias, artistId, offset, effectiveLimit);
      this.storeFolderItems(normalized, result.items);
      return result;
    }

    if (
      normalized.includes(':artist:') ||
      normalized.startsWith('artists:') ||
      (/^[0-9]+$/.test(normalized) && this.lookupItem('artists', normalized))
    ) {
      return this.getArtistByDirectId(alias, offset, effectiveLimit);
    }

    if (/^[0-9]+$/.test(normalized) && this.lookupItem('albums', normalized)) {
      return this.getAlbumByDirectId(alias, offset, effectiveLimit);
    }

    if (normalized === 'tracks') {
      const result = await this.getTracks(alias, offset, effectiveLimit);
      this.storeFolderItems(normalized, result.items);
      return result;
    }

    if (normalized.includes(':track:')) {
      const track = await this.resolveItem('', alias);
      if (!track) return this.emptyResponse(alias, offset);
      return {
        id: alias,
        name: track.name,
        tag: 'track',
        type: track.type,
        thumbnail: track.thumbnail ?? track.coverurl,
        coverurl: track.coverurl,
        artist: track.artist,
        totalitems: 1,
        start: 0,
        items: [track],
      };
    }

    const numericId = /^[0-9]+$/.test(normalized);
    if (!numericId) {
      logger.debug(`[MusicAssistantLibrary] Unknown folder id ${normalized}`);
    }
    return this.emptyResponse(folderId, offset);
  }

  /** Loads paginated album results from Music Assistant and caches them. */
  private async getAlbums(folderId: string, offset: number, limit: number): Promise<MediaFolderResponse> {
    try {
      const response = await this.client.rpc('music/albums/library_items', {
        search: '',
        limit,
        offset,
        order_by: 'name',
      });

      const { items, total } = normalizePagedResponse(response);
      const mapped = items.map((album: any) => this.mapAlbumToFolderItem(album));

      this.storeFolderItems('albums', mapped);

      return {
        id: folderId,
        name: 'Albums',
        tag: 'albums',
        type: 7,
        totalitems: total ?? mapped.length,
        start: offset,
        items: mapped,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[MusicAssistantLibrary] Failed to load albums: ${message}`);
      return this.emptyResponse(folderId, offset);
    }
  }

  /** Fetches the tracks belonging to a given album, preferring API data over cached metadata. */
  private async getAlbumTracks(
    folderId: string,
    albumId: string,
    offset: number,
    limit: number,
  ): Promise<MediaFolderResponse> {
    try {
      const parentAlbum = this.lookupItem('albums', albumId);
      const providerInstance = parentAlbum?.providerInstanceId || parentAlbum?.provider || 'library';
      const album = await this.fetchAlbumMetadata(albumId, providerInstance);
      const tracksFromApi = await this.fetchAlbumTracks(albumId, providerInstance);
      const tracks = tracksFromApi ?? (Array.isArray(album?.tracks) ? album.tracks : []);
      const sliced = tracks.slice(offset, offset + limit);
      const albumName = toStringValue(album?.name ?? album?.title ?? albumId);
      const artistName = toStringValue(
        album?.artist ??
          (Array.isArray(album?.artists) && album.artists.length > 0 ? album.artists[0]?.name : undefined) ??
          album?.album_artist ??
          '',
      );
      const coverurl = extractImage(album);
      const mapped = sliced.map((track: any) =>
        this.mapTrackToFolderItem(track, providerInstance, albumName, artistName, coverurl),
      );

      this.storeFolderItems('tracks', mapped);
      this.storeFolderItems(`albums:${albumId}`, mapped);
      if (album) {
        this.storeFolderItems('albums', [this.mapAlbumToFolderItem(album)]);
      }

      return {
        id: folderId,
        name: albumName,
        tag: 'album',
        type: 7,
        thumbnail: coverurl,
        coverurl,
        artist: artistName,
        totalitems: tracks.length,
        start: offset,
        items: mapped,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[MusicAssistantLibrary] Failed to load tracks for album ${albumId}: ${message}`);
      return this.emptyResponse(folderId, offset);
    }
  }

  /** Loads artists from the library and stores them in the folder cache for quick lookup. */
  private async getArtists(folderId: string, offset: number, limit: number): Promise<MediaFolderResponse> {
    try {
      const response = await this.client.rpc('music/artists/library_items', {
        search: '',
        limit,
        offset,
        order_by: 'name',
      });

      const { items, total } = normalizePagedResponse(response);
      const mapped = items.map((artist: any) => this.mapArtistToFolderItem(artist));

      this.storeFolderItems('artists', mapped);

      return {
        id: folderId,
        name: 'Artists',
        tag: 'artists',
        type: 6,
        totalitems: total ?? mapped.length,
        start: offset,
        items: mapped,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[MusicAssistantLibrary] Failed to load artists: ${message}`);
      return this.emptyResponse(folderId, offset);
    }
  }

  /** Fetches albums for a specific artist and keeps both artist and album caches warm. */
  private async getArtistAlbums(
    folderId: string,
    artistId: string,
    offset: number,
    limit: number,
  ): Promise<MediaFolderResponse> {
    try {
      const parentArtist = this.lookupItem('artists', artistId);
      const providerInstance = parentArtist?.providerInstanceId || parentArtist?.provider || 'library';
      const artist = await this.fetchArtistMetadata(artistId, providerInstance);
      const albumsFromApi = await this.fetchArtistAlbums(artistId, providerInstance);
      const albums = albumsFromApi ?? (Array.isArray(artist?.albums) ? artist.albums : []);
      const sliced = albums.slice(offset, offset + limit);
      const mapped = sliced.map((album: any) => this.mapAlbumToFolderItem(album));

      this.storeFolderItems('albums', mapped);
      this.storeFolderItems(`artists:${artistId}`, mapped);

      const artistName = toStringValue(artist?.name ?? artistId);
      const coverurl = extractImage(artist);

      return {
        id: folderId,
        name: artistName,
        tag: 'artist',
        type: 6,
        thumbnail: coverurl,
        coverurl,
        artist: artistName,
        totalitems: albums.length,
        start: offset,
        items: mapped,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[MusicAssistantLibrary] Failed to load albums for artist ${artistId}: ${message}`);
      return this.emptyResponse(folderId, offset);
    }
  }

  /** Retrieves standalone track listings from the library view. */
  private async getTracks(folderId: string, offset: number, limit: number): Promise<MediaFolderResponse> {
    try {
      const response = await this.client.rpc('music/tracks/library_items', {
        search: '',
        limit,
        offset,
        order_by: 'name',
      });

      const { items, total } = normalizePagedResponse(response);
      const mapped = items.map((track: any) => this.mapTrackToFolderItem(track));

      this.storeFolderItems('tracks', mapped);

      return {
        id: folderId,
        name: 'Tracks',
        tag: 'tracks',
        type: 5,
        totalitems: total ?? mapped.length,
        start: offset,
        items: mapped,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[MusicAssistantLibrary] Failed to load tracks: ${message}`);
      return this.emptyResponse(folderId, offset);
    }
  }

  /** Resolve a single item so playback commands can load full metadata. */
  async resolveItem(folderId: string, itemId: string): Promise<MediaFolderItem | undefined> {
    const normalizedFolder = decodeURIComponent(folderId ?? '').trim();
    const normalizedItem = decodeURIComponent(itemId ?? '').trim();
    if (!normalizedItem) return undefined;

    try {
      const cached = this.lookupItem(normalizedFolder, normalizedItem);
      if (cached) return cached;

      if (!normalizedFolder) {
        return this.resolveItemByGuess(normalizedItem);
      }

      if (/^[0-9]+$/.test(normalizedFolder)) {
        const albumMeta = this.lookupItem('albums', normalizedFolder);
        const providerInstance = albumMeta?.providerInstanceId || albumMeta?.provider || 'library';
        const track = await this.resolveTrackFromAlbum(normalizedFolder, normalizedItem);
        if (track) return track;
        const album = await this.fetchAlbumMetadata(normalizedFolder, providerInstance);
        return album ? this.mapAlbumToFolderItem(album) : undefined;
      }

      if (normalizedFolder === 'albums') {
        const providerInstance = this.lookupItem('albums', normalizedItem)?.providerInstanceId || 'library';
        const album = await this.fetchAlbumMetadata(normalizedItem, providerInstance);
        const mapped = album ? this.mapAlbumToFolderItem(album) : undefined;
        if (mapped) this.storeFolderItems('albums', [mapped]);
        return mapped;
      }

      if (normalizedFolder.startsWith('albums:')) {
        const albumId = normalizedFolder.substring('albums:'.length);
        return this.resolveTrackFromAlbum(albumId, normalizedItem);
      }

      if (normalizedFolder === 'artists') {
        const providerInstance = this.lookupItem('artists', normalizedItem)?.providerInstanceId || 'library';
        const artist = await this.client.rpc('music/artists/get_artist', {
          item_id: normalizedItem,
          provider_instance_id_or_domain: providerInstance,
        });
        const mapped = artist ? this.mapArtistToFolderItem(artist) : undefined;
        if (mapped) this.storeFolderItems('artists', [mapped]);
        return mapped;
      }

      if (normalizedFolder.startsWith('artists:')) {
        const providerInstance = this.lookupItem('albums', normalizedItem)?.providerInstanceId || 'library';
        const album = await this.fetchAlbumMetadata(normalizedItem, providerInstance);
        const mapped = album ? this.mapAlbumToFolderItem(album) : undefined;
        if (mapped) {
          this.storeFolderItems(normalizedFolder, [mapped]);
          this.storeFolderItems('albums', [mapped]);
        }
        return mapped;
      }

      if (normalizedFolder === 'tracks') {
        const providerInstance = this.lookupItem('tracks', normalizedItem)?.providerInstanceId || 'library';
        const track = await this.client.rpc('music/tracks/get_track', {
          item_id: normalizedItem,
          provider_instance_id_or_domain: providerInstance,
        });
        const mapped = track ? this.mapTrackToFolderItem(track, providerInstance) : undefined;
        if (mapped) this.storeFolderItems('tracks', [mapped]);
        return mapped;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `[MusicAssistantLibrary] Failed to resolve media item ${normalizedItem} in folder ${normalizedFolder}: ${message}`,
      );
    }

    return undefined;
  }

  /**
   * Attempts to locate an item by interpreting library URIs or fuzzy prefixes when no folder context exists.
   */
  private async resolveItemByGuess(itemId: string): Promise<MediaFolderItem | undefined> {
    const cached = this.lookupItem('', itemId);
    if (cached) return cached;

    if (itemId.startsWith('library://')) {
      const rest = itemId.substring('library://'.length);
      const [kind, rawId] = rest.split('/', 2);
      const decodedId = rawId ? decodeURIComponent(rawId) : '';
      switch (kind) {
        case 'album':
          return this.resolveItem('albums', decodedId);
        case 'artist':
          return this.resolveItem('artists', decodedId);
        case 'track':
          return this.resolveItem('tracks', decodedId);
        default:
          return undefined;
      }
    }

    if (/^albums:?/.test(itemId)) {
      const [, rawId] = itemId.split(':', 2);
      return rawId ? this.resolveItem('albums', rawId) : undefined;
    }

    if (/^artists:?/.test(itemId)) {
      const [, rawId] = itemId.split(':', 2);
      return rawId ? this.resolveItem('artists', rawId) : undefined;
    }

    return undefined;
  }

  /**
   * Fetches album metadata to locate a track by ID or name, caching the match when found.
   */
  private async resolveTrackFromAlbum(albumId: string, trackId: string): Promise<MediaFolderItem | undefined> {
    try {
      const albumMeta = this.lookupItem('albums', albumId);
      const providerInstance = albumMeta?.providerInstanceId || albumMeta?.provider || 'library';
      const album = await this.fetchAlbumMetadata(albumId, providerInstance);
      const tracksFromApi = await this.fetchAlbumTracks(albumId, providerInstance);
      const tracks = tracksFromApi ?? (Array.isArray(album?.tracks) ? album.tracks : []);
      const normalizedTarget = trackId;
      const match = tracks.find((track: any) => {
        const id = toStringValue(track?.item_id ?? track?.uri ?? track?.track_id ?? '');
        if (id === normalizedTarget) return true;
        const fallback = toStringValue(track?.name ?? track?.title ?? '');
        return fallback === normalizedTarget;
      });
      const albumName = toStringValue(album?.name ?? albumId);
      const artistName = toStringValue(
        album?.artist ??
          (Array.isArray(album?.artists) && album.artists.length > 0 ? album.artists[0]?.name : undefined) ??
          album?.album_artist ??
          '',
      );
      const coverurl = extractImage(album);
      const mapped = match
        ? this.mapTrackToFolderItem(match, providerInstance, albumName, artistName, coverurl)
        : undefined;
      if (mapped) {
        this.storeFolderItems(`albums:${albumId}`, [mapped]);
        this.storeFolderItems('tracks', [mapped]);
      }
      return mapped;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[MusicAssistantLibrary] Failed to resolve track ${trackId} from album ${albumId}: ${message}`);
      return undefined;
    }
  }

  /** Thin RPC wrapper around `music/albums/get_album`. */
  private async fetchAlbumMetadata(albumId: string, providerInstance: string): Promise<any | undefined> {
    try {
      return await this.client.rpc('music/albums/get_album', {
        item_id: albumId,
        provider_instance_id_or_domain: providerInstance,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.debug(`[MusicAssistantLibrary] get_album failed for ${albumId}: ${message}`);
      return undefined;
    }
  }

  /** Queries the Music Assistant API for album tracks, normalizing different response shapes. */
  private async fetchAlbumTracks(albumId: string, providerInstance: string): Promise<any[] | undefined> {
    try {
      logger.debug(
        `[MusicAssistantLibrary] album_tracks request albumId=${albumId} provider=${providerInstance || 'library'}`,
      );
      const response = await this.client.rpc('music/albums/album_tracks', {
        item_id: albumId,
        provider_instance_id_or_domain: providerInstance,
        in_library_only: true,
      });

      if (!response) return undefined;
      if (Array.isArray(response)) return response;
      if (Array.isArray(response.items)) return response.items;
      if (Array.isArray(response.tracks)) return response.tracks;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.debug(`[MusicAssistantLibrary] album_tracks failed for ${albumId}: ${message}`);
    }
    return undefined;
  }

  /**
   * Loads album metadata + tracks directly when the folder id already encodes provider/album information.
   */
  private async getAlbumByDirectId(albumItemId: string, offset: number, limit: number): Promise<MediaFolderResponse> {
    try {
      const providerInstance = this.extractProviderFromItemId(albumItemId) || 'library';
      const album = await this.fetchAlbumMetadata(albumItemId, providerInstance);

      if (!album) {
        return this.emptyResponse(albumItemId, offset);
      }

      const albumName = toStringValue(album?.name ?? album?.title ?? albumItemId);
      const artistName = toStringValue(
        album?.artist ??
          (Array.isArray(album?.artists) && album.artists.length > 0 ? album.artists[0]?.name : undefined) ??
          album?.album_artist ??
          '',
      );
      const coverurl = extractImage(album);
      const tracksFromApi = await this.fetchAlbumTracks(albumItemId, providerInstance);
      const tracks = tracksFromApi ?? (Array.isArray(album?.tracks) ? album.tracks : []);
      const sliced = tracks.slice(offset, offset + limit);
      const mapped = sliced.map((track: any) =>
        this.mapTrackToFolderItem(track, providerInstance, albumName, artistName, coverurl),
      );

      this.storeFolderItems('tracks', mapped);
      this.storeFolderItems(albumItemId, mapped);
      this.storeFolderItems('albums', [this.mapAlbumToFolderItem(album)]);

      return {
        id: albumItemId,
        name: albumName,
        tag: 'album',
        type: 7,
        thumbnail: coverurl,
        coverurl,
        artist: artistName,
        totalitems: tracks.length,
        start: offset,
        items: mapped,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[MusicAssistantLibrary] Failed to load album ${albumItemId}: ${message}`);
      return this.emptyResponse(albumItemId, offset);
    }
  }

  /** Thin RPC wrapper around `music/artists/get_artist`. */
  private async fetchArtistMetadata(artistId: string, providerInstance: string): Promise<any | undefined> {
    try {
      return await this.client.rpc('music/artists/get_artist', {
        item_id: artistId,
        provider_instance_id_or_domain: providerInstance,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.debug(`[MusicAssistantLibrary] get_artist failed for ${artistId}: ${message}`);
      return undefined;
    }
  }

  /**
   * Queries Music Assistant for albums owned by an artist, handling both array and object responses.
   */
  private async fetchArtistAlbums(artistId: string, providerInstance: string): Promise<any[] | undefined> {
    try {
      logger.debug(
        `[MusicAssistantLibrary] artist_albums request artistId=${artistId} provider=${providerInstance || 'library'}`,
      );
      const response = await this.client.rpc('music/artists/artist_albums', {
        item_id: artistId,
        provider_instance_id_or_domain: providerInstance,
        in_library_only: true,
      });

      if (!response) return undefined;
      if (Array.isArray(response)) return response;
      if (Array.isArray(response.items)) return response.items;
      if (Array.isArray(response.albums)) return response.albums;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.debug(`[MusicAssistantLibrary] artist_albums failed for ${artistId}: ${message}`);
    }
    return undefined;
  }

  /**
   * Loads artist metadata and albums using a direct item id, seeding caches for follow-up requests.
   */
  private async getArtistByDirectId(artistItemId: string, offset: number, limit: number): Promise<MediaFolderResponse> {
    try {
      const providerInstance = this.extractProviderFromItemId(artistItemId) || 'library';
      const artist = await this.fetchArtistMetadata(artistItemId, providerInstance);

      if (!artist) {
        return this.emptyResponse(artistItemId, offset);
      }

      const albumsFromApi = await this.fetchArtistAlbums(artistItemId, providerInstance);
      const albums = albumsFromApi ?? (Array.isArray(artist?.albums) ? artist.albums : []);
      const sliced = albums.slice(offset, offset + limit);
      const mapped = sliced.map((album: any) => this.mapAlbumToFolderItem(album));

      this.storeFolderItems('albums', mapped);
      this.storeFolderItems(artistItemId, mapped);

      const artistName = toStringValue(artist?.name ?? artistItemId);
      const coverurl = extractImage(artist);

      return {
        id: artistItemId,
        name: artistName,
        tag: 'artist',
        type: 6,
        thumbnail: coverurl,
        coverurl,
        artist: artistName,
        totalitems: albums.length,
        start: offset,
        items: mapped,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[MusicAssistantLibrary] Failed to load artist ${artistItemId}: ${message}`);
      return this.emptyResponse(artistItemId, offset);
    }
  }

  /** Adds media items to the folder cache under multiple lookup keys. */
  private storeFolderItems(folderId: string, items: MediaFolderItem[]): void {
    if (!items || items.length === 0) return;
    const folderKey = this.normalizeFolderKey(folderId);
    const bucket = this.folderCache.get(folderKey) ?? new Map<string, MediaFolderItem>();
    for (const item of items) {
      this.registerItem(bucket, item);
    }
    this.folderCache.set(folderKey, bucket);
  }

  /** Retrieves a cached media item by checking folder scoping and several id variants. */
  private lookupItem(folderId: string, itemId: string): MediaFolderItem | undefined {
    if (!itemId) return undefined;
    const folderKeys = [this.normalizeFolderKey(folderId)];
    if (!folderId) {
      folderKeys.push(...Array.from(this.folderCache.keys()));
    }
    for (const key of folderKeys) {
      const bucket = this.folderCache.get(key);
      if (!bucket) continue;
      const trimmed = itemId.trim();
      const lowercase = trimmed.toLowerCase();
      const encoded = encodeURIComponent(trimmed);
      const direct =
        bucket.get(trimmed) ||
        bucket.get(lowercase) ||
        bucket.get(encoded) ||
        bucket.get(encoded.toLowerCase());
      if (direct) return direct;
    }
    return undefined;
  }

  /** Registers an item under the supplied cache bucket with encoded and decoded keys. */
  private registerItem(bucket: Map<string, MediaFolderItem>, item: MediaFolderItem): void {
    const keys = this.collectCacheKeys(item);
    for (const key of keys) {
      bucket.set(key, item);
      bucket.set(key.toLowerCase(), item);
      const encoded = encodeURIComponent(key);
      bucket.set(encoded, item);
      bucket.set(encoded.toLowerCase(), item);
      try {
        const decoded = decodeURIComponent(key);
        if (decoded) {
          bucket.set(decoded, item);
          bucket.set(decoded.toLowerCase(), item);
        }
      } catch {
        // ignore malformed URI sequences
      }
    }
  }

  /** Gathers identifiers that should map back to a cached media item. */
  private collectCacheKeys(item: MediaFolderItem): string[] {
    const keys = new Set<string>();
    const push = (value?: string) => {
      if (!value) return;
      const trimmed = value.trim();
      if (!trimmed) return;
      keys.add(trimmed);
    };
    push(item.id);
    push(item.rawId);
    push(item.cmd);
    push(item.audiopath);
    return Array.from(keys).filter(Boolean);
  }

  /** Produces a normalized folder key (lowercase + decoded) for cache lookups. */
  private normalizeFolderKey(value: string): string {
    return decodeURIComponent(value ?? '').trim().toLowerCase();
  }

  /** Pulls the provider instance prefix from an item id (e.g. `spotify:album:...`). */
  private extractProviderFromItemId(itemId: string): string | undefined {
    const markers = [':album:', ':artist:', ':track:'];
    for (const marker of markers) {
      const idx = itemId.indexOf(marker);
      if (idx > 0) {
        return itemId.substring(0, idx);
      }
    }
    const first = itemId.indexOf(':');
    if (first > 0) {
      return itemId.substring(0, first);
    }
    return undefined;
  }

  /**
   * Transforms Music Assistant album metadata into the media folder item format expected by the UI.
   */
  private mapAlbumToFolderItem(album: any): MediaFolderItem {
    const rawId = toStringValue(album?.item_id ?? album?.album_id ?? '');
    const uri = toStringValue(album?.uri ?? '');
    let { baseId, listId } = normalizeEntityId(rawId, 'albums', 'album');
    if (!baseId || !listId) {
      const uriNorm = normalizeEntityId(uri, 'albums', 'album');
      baseId = baseId || uriNorm.baseId;
      listId = listId || uriNorm.listId;
    }
    if (!listId) {
      const fallbackName = toStringValue(album?.name ?? '');
      if (fallbackName) {
        listId = normalizeEntityId(fallbackName, 'albums', 'album').listId || `albums:${fallbackName}`;
      } else {
        listId = baseId ? `albums:${baseId}` : 'albums:';
      }
    }
    const sanitizedBaseId = baseId || extractBaseIdFromList(listId, 'albums');
    const name = toStringValue(album?.name ?? album?.title ?? sanitizedBaseId ?? listId);
    const sort = toStringValue(album?.sort_name ?? name);
    const coverurl = extractImage(album);
    const trackCount = Number(album?.track_count ?? album?.tracks?.length ?? 0);
    const providerInstance = resolveProviderInstance(album);
    const audiopath = uri || buildLibraryUri('album', sanitizedBaseId || listId, providerInstance);
    const artistName = toStringValue(
      album?.artist ??
        (Array.isArray(album?.artists) && album.artists.length > 0 ? album.artists[0]?.name : undefined) ??
        album?.album_artist ??
        '',
    );

    return {
      id: listId,
      name,
      cmd: listId,
      type: 12,
      contentType: 'Album',
      sort: sort || 'alpha',
      coverurl,
      items: trackCount,
      provider: providerInstance,
      providerInstanceId: providerInstance,
      audiopath,
      rawId: sanitizedBaseId,
      tag: 'album',
      thumbnail: coverurl,
      artist: artistName,
      owner: artistName,
      title: name,
      followed: Boolean(album?.favorite ?? album?.followed ?? false),
    };
  }

  /** Maps an artist entity from Music Assistant to the common folder representation. */
  private mapArtistToFolderItem(artist: any): MediaFolderItem {
    const rawId = toStringValue(artist?.item_id ?? artist?.artist_id ?? '');
    const uri = toStringValue(artist?.uri ?? '');
    let { baseId, listId } = normalizeEntityId(rawId, 'artists', 'artist');
    if (!baseId || !listId) {
      const uriNorm = normalizeEntityId(uri, 'artists', 'artist');
      baseId = baseId || uriNorm.baseId;
      listId = listId || uriNorm.listId;
    }
    if (!listId) {
      const fallbackName = toStringValue(artist?.name ?? '');
      if (fallbackName) {
        listId = normalizeEntityId(fallbackName, 'artists', 'artist').listId || `artists:${fallbackName}`;
      } else {
        listId = baseId ? `artists:${baseId}` : 'artists:';
      }
    }
    const sanitizedBaseId = baseId || extractBaseIdFromList(listId, 'artists');
    const name = toStringValue(artist?.name ?? artist?.title ?? sanitizedBaseId ?? listId);
    const sort = toStringValue(artist?.sort_name ?? name);
    const coverurl = extractImage(artist);
    const providerInstance = resolveProviderInstance(artist);
    const albumCount = Number(artist?.album_count ?? artist?.albums?.length ?? 0);
    const audiopath = buildLibraryUri('artist', sanitizedBaseId || listId, providerInstance);

    return {
      id: listId,
      name,
      cmd: listId,
      type: 12,
      contentType: 'Artist',
      sort: sort || 'alpha',
      coverurl,
      provider: providerInstance,
      providerInstanceId: providerInstance,
      items: albumCount,
      audiopath,
      rawId: sanitizedBaseId,
      tag: 'artist',
      thumbnail: coverurl,
      owner: name,
      title: name,
    };
  }

  /** Maps a track entity, optionally using fallback metadata when the API omits certain fields. */
  private mapTrackToFolderItem(
    track: any,
    fallbackProvider?: string,
    fallbackAlbum?: string,
    fallbackArtist?: string,
    fallbackCover?: string,
  ): MediaFolderItem {
    const rawId = toStringValue(track?.item_id ?? track?.track_id ?? '');
    const uri = toStringValue(track?.uri ?? '');
    const baseId = rawId || uri || toStringValue(track?.name ?? '');
    const listId = baseId.startsWith('tracks:') ? baseId : `tracks:${baseId}`;
    const name = toStringValue(track?.name ?? track?.title ?? baseId);
    const sort = toStringValue(track?.sort_name ?? name);
    const coverurl = extractImage(track) || fallbackCover || '';
    const providerInstanceCandidate = resolveProviderInstance(track);
    const providerInstance = providerInstanceCandidate || fallbackProvider || 'library';
    const audiopath = uri || buildLibraryUri('track', baseId, providerInstance);
    const albumName = toStringValue(track?.album?.name ?? fallbackAlbum ?? '');
    const artistName = toStringValue(
      track?.artist ??
        (Array.isArray(track?.artists) && track.artists.length > 0 ? track.artists[0]?.name : undefined) ??
        fallbackArtist ??
        '',
    );
    const durationSeconds = Number(
      track?.duration ?? track?.duration_seconds ?? (track?.duration_ms ? track.duration_ms / 1000 : 0),
    );
    const thumbnail = extractImage(track) || coverurl;

    return {
      id: listId,
      name,
      cmd: listId,
      type: 2,
      contentType: 'Track',
      sort: sort || 'alpha',
      coverurl,
      audiopath,
      provider: providerInstance,
      providerInstanceId: providerInstance,
      rawId: baseId,
      album: albumName,
      artist: artistName,
      duration: durationSeconds > 0 ? Math.round(durationSeconds) : undefined,
      tag: 'track',
      thumbnail,
      owner: artistName,
      title: name,
    };
  }

  /** Shared helper returning an empty folder payload. */
  private emptyResponse(folderId: string, offset: number): MediaFolderResponse {
    return {
      id: folderId,
      totalitems: 0,
      start: offset,
      items: [],
    };
  }
}

function normalizePagedResponse(response: any): { items: any[]; total?: number } {
  if (!response) return { items: [] };
  if (Array.isArray(response)) return { items: response };

  const items = Array.isArray(response.items) ? response.items : [];
  const total = typeof response.total === 'number' ? response.total : undefined;
  return { items, total };
}

function toStringValue(value: any): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return value.map((entry) => toStringValue(entry)).filter(Boolean).join(', ');
  }
  if (value && typeof value === 'object') {
    if ('value' in value) return toStringValue((value as any).value);
  }
  return '';
}

function extractImage(entity: any): string {
  const images = Array.isArray(entity?.metadata?.images) ? entity.metadata.images : [];
  if (images.length === 0) return '';
  const first = images[0];
  return toStringValue(first?.path ?? first?.url ?? '');
}

function normalizeEntityId(value: string, pluralPrefix: string, singular: string): {
  baseId: string;
  listId: string;
} {
  let base = toStringValue(value).trim();
  if (!base) return { baseId: '', listId: '' };

  const lower = base.toLowerCase();
  const libraryPrefix = `library://${singular}/`;
  if (lower.startsWith(libraryPrefix)) {
    base = base.substring(libraryPrefix.length);
  }

  const pluralPrefixLower = `${pluralPrefix.toLowerCase()}:`;
  if (base.toLowerCase().startsWith(pluralPrefixLower)) {
    base = base.substring(pluralPrefix.length + 1);
  }

  return {
    baseId: base,
    listId: base ? `${pluralPrefix}:${base}` : '',
  };
}

function extractBaseIdFromList(listId: string, pluralPrefix: string): string {
  if (!listId) return '';
  const lowerPrefix = `${pluralPrefix.toLowerCase()}:`;
  const lowerId = listId.toLowerCase();
  if (lowerId.startsWith(lowerPrefix)) {
    return listId.substring(pluralPrefix.length + 1);
  }
  return listId;
}

function buildLibraryUri(kind: string, rawId: string, provider?: string): string {
  if (!rawId) return '';
  if (rawId.startsWith('library://')) return rawId;
  const sanitized = rawId.replace(/^\//, '');
  const encodedId = encodeURIComponent(sanitized);
  const providerSegment = provider && provider !== 'library' ? `/${encodeURIComponent(provider)}` : '';
  return `library://${kind}${providerSegment}/${encodedId}`;
}

function resolveProviderInstance(entity: any): string {
  const direct = toStringValue(entity?.provider);
  if (direct) return direct;

  const mappings = Array.isArray(entity?.provider_mappings) ? entity.provider_mappings : [];
  for (const mapping of mappings) {
    const instance = toStringValue(mapping?.provider_instance ?? mapping?.provider_instance_id);
    if (instance) return instance;
    const domain = toStringValue(mapping?.provider_domain);
    if (domain) return domain;
  }

  return 'library';
}
