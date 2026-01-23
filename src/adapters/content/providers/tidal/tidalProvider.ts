import type { ContentFolder, ContentFolderItem, ContentServiceAccount, PlaylistEntry } from '@/ports/ContentTypes';
import { createLogger } from '@/shared/logging/logger';
import { DEFAULT_MIN_SEARCH_LIMIT } from '@/adapters/content/utils/searchLimits';

const enum FileType {
  Folder = 1,
  File = 2,
  PlaylistBrowsable = 7,
}

const TIDAL_API_BASE = 'https://api.tidal.com/v1';

type SearchResult = {
  tracks?: ContentFolderItem[];
  albums?: ContentFolderItem[];
  artists?: ContentFolderItem[];
  playlists?: ContentFolderItem[];
};

interface TidalProviderOptions {
  providerId: string;
  label?: string;
  accessToken?: string;
  countryCode?: string;
}

/**
 * Lightweight Tidal catalog provider that mirrors the Apple Music facade shape.
 * Uses the Tidal API for metadata (no playback).
 */
export class TidalProvider {
  public readonly providerId: string;
  private readonly log = createLogger('Content', 'Tidal');
  private readonly label: string;
  private readonly accessToken?: string;
  private readonly countryCode: string;

  constructor(options: TidalProviderOptions) {
    this.providerId = options.providerId;
    this.label = options.label || 'Tidal';
    this.accessToken = options.accessToken;
    this.countryCode = options.countryCode || 'US';
  }

  public get accountId(): string {
    return 'tidal';
  }

  public get displayLabel(): string {
    return this.label;
  }

  public getServiceAccount(): ContentServiceAccount {
    return {
      id: this.providerId,
      label: this.displayLabel,
      provider: 'tidal',
      fake: true,
    };
  }

  public async fetchAccessToken(): Promise<string | null> {
    return this.accessToken ?? null;
  }

  public async getPlaylists(_offset: number, _limit: number): Promise<PlaylistEntry[]> {
    // Tidal catalog playlists are not enumerated here; search returns playlists.
    return [];
  }

  public async getFolder(folderId: string, offset: number, limit: number): Promise<ContentFolder | null> {
    const normalized = this.normalizeFolderId(folderId);
    switch (normalized.type) {
      case 'root':
        return this.buildRootFolder(offset);
      case 'albumItem': {
        const result = await this.fetchAlbumTracks(normalized.id, limit || 50, offset);
        return {
          id: folderId,
          name: 'Album',
          service: 'tidal',
          start: offset,
          totalitems: typeof result.total === 'number' ? result.total : result.items.length,
          items: result.items,
        };
      }
      case 'artistItem': {
        const result = await this.fetchArtistAlbums(normalized.id, limit || 50, offset);
        return {
          id: folderId,
          name: 'Artist',
          service: 'tidal',
          start: offset,
          totalitems: typeof result.total === 'number' ? result.total : result.items.length,
          items: result.items,
        };
      }
      case 'playlistItem': {
        const result = await this.fetchPlaylistTracks(normalized.id, limit || 50, offset);
        return {
          id: folderId,
          name: 'Playlist',
          service: 'tidal',
          start: offset,
          totalitems: typeof result.total === 'number' ? result.total : result.items.length,
          items: result.items,
        };
      }
      default:
        return {
          id: folderId,
          name: this.displayLabel,
          service: 'tidal',
          start: offset,
          totalitems: 0,
          items: [],
        };
    }
  }

  public async getTrack(trackId: string): Promise<ContentFolderItem | null> {
    const normalized = this.normalizeItemId(trackId, 'track');
    if (!normalized.id) return null;
    const track = await this.fetchJson<any>(`${TIDAL_API_BASE}/tracks/${encodeURIComponent(normalized.id)}`);
    if (!track) return null;
    return this.mapTrack(track);
  }

  public async search(
    query: string,
    limits: Record<string, number>,
    maxLimit: number,
  ): Promise<{ result: SearchResult; providerId: string; user: string }> {
    const limit = Math.min(
      Math.max(...(Object.values(limits).length ? Object.values(limits) : [maxLimit]), DEFAULT_MIN_SEARCH_LIMIT),
      maxLimit,
    );
    const result: SearchResult = {};

    const requestedTypes = Object.keys(limits);
    const activeTypes =
      requestedTypes.length > 0 ? new Set(requestedTypes) : new Set(['track', 'album', 'artist', 'playlist']);

    if (activeTypes.has('track')) {
      const tracks = await this.fetchSearchResults('tracks', query, limits.track ?? limit);
      result.tracks = tracks.map((track) => this.mapTrack(track));
    }
    if (activeTypes.has('album')) {
      const albums = await this.fetchSearchResults('albums', query, limits.album ?? limit);
      result.albums = albums.map((album) => this.mapAlbum(album));
    }
    if (activeTypes.has('artist')) {
      const artists = await this.fetchSearchResults('artists', query, limits.artist ?? limit);
      result.artists = artists.map((artist) => this.mapArtist(artist));
    }
    if (activeTypes.has('playlist')) {
      const playlists = await this.fetchSearchResults('playlists', query, limits.playlist ?? limit);
      result.playlists = playlists.map((playlist) => this.mapPlaylist(playlist));
    }

    return { result, providerId: this.providerId, user: 'tidal' };
  }

  public dispose(): void {
    /* nothing to clean up */
  }

  /* ------------------------------------------------------------------------ */
  /* Mapping helpers                                                          */
  /* ------------------------------------------------------------------------ */

  private buildRootFolder(offset: number): ContentFolder {
    return {
      id: 'root',
      name: this.displayLabel,
      service: 'tidal',
      start: offset,
      totalitems: 0,
      items: [],
    };
  }

  private makeUri(type: string, id: string): string {
    return `${this.providerId}:${type}:${id}`;
  }

  private stripProviderPrefix(value: string): string {
    const raw = value || '';
    const lower = raw.toLowerCase();
    const providerLower = this.providerId.toLowerCase();
    const direct = `${providerLower}:`;
    if (lower.startsWith(direct)) {
      return raw.slice(direct.length);
    }
    const at = `@${providerLower}:`;
    if (lower.startsWith(at)) {
      return raw.slice(at.length);
    }
    return raw;
  }

  private normalizeItemId(
    value: string,
    kind: 'track' | 'album' | 'artist' | 'playlist',
  ): { id: string } {
    const raw = this.stripProviderPrefix(value || '').trim();
    const match = raw.match(new RegExp(`(?:^|:)${kind}:(.+)$`, 'i'));
    const id = match ? match[1] : raw;
    return { id };
  }

  private normalizeFolderId(
    folderId: string,
  ):
    | { type: 'root' }
    | { type: 'albumItem'; id: string }
    | { type: 'artistItem'; id: string }
    | { type: 'playlistItem'; id: string }
    | { type: 'unknown' } {
    const raw = this.stripProviderPrefix(folderId || 'root').trim();
    const lower = raw.toLowerCase();
    if (lower === 'root' || lower === 'start') {
      return { type: 'root' };
    }
    const albumMatch = raw.match(/(?:^|:)album:(.+)$/i);
    if (albumMatch) {
      return { type: 'albumItem', id: albumMatch[1] };
    }
    const artistMatch = raw.match(/(?:^|:)artist:(.+)$/i);
    if (artistMatch) {
      return { type: 'artistItem', id: artistMatch[1] };
    }
    const playlistMatch = raw.match(/(?:^|:)playlist:(.+)$/i);
    if (playlistMatch) {
      return { type: 'playlistItem', id: playlistMatch[1] };
    }
    return { type: 'unknown' };
  }

  private mapTrack(track: any): ContentFolderItem {
    const id = String(track?.id ?? '');
    const name = String(track?.title ?? 'Track');
    const artist = track?.artist?.name ?? '';
    const album = track?.album?.title ?? '';
    const cover = buildImageUrl(track?.album?.cover, 320);
    return {
      id: this.makeUri('track', id),
      audiopath: this.makeUri('track', id),
      name,
      title: name,
      artist,
      album,
      coverurl: cover,
      thumbnail: cover,
      type: FileType.File,
      tag: 'track',
      duration: typeof track?.duration === 'number' ? track.duration : undefined,
      hasCover: !!cover,
      provider: 'tidal',
    };
  }

  private mapAlbum(album: any): ContentFolderItem {
    const id = String(album?.id ?? '');
    const name = String(album?.title ?? 'Album');
    const artist = album?.artist?.name ?? '';
    const cover = buildImageUrl(album?.cover, 320);
    return {
      id: this.makeUri('album', id),
      audiopath: this.makeUri('album', id),
      name,
      title: name,
      artist,
      coverurl: cover,
      thumbnail: cover,
      type: FileType.PlaylistBrowsable,
      tag: 'album',
      provider: 'tidal',
    };
  }

  private mapArtist(artistObj: any): ContentFolderItem {
    const id = String(artistObj?.id ?? '');
    const name = String(artistObj?.name ?? 'Artist');
    const cover = buildImageUrl(artistObj?.picture, 320);
    return {
      id: this.makeUri('artist', id),
      audiopath: this.makeUri('artist', id),
      name,
      title: name,
      artist: name,
      coverurl: cover,
      thumbnail: cover,
      type: FileType.PlaylistBrowsable,
      tag: 'artist',
      provider: 'tidal',
    };
  }

  private mapPlaylist(playlist: any): ContentFolderItem {
    const id = String(playlist?.uuid ?? playlist?.id ?? '');
    const name = String(playlist?.title ?? 'Playlist');
    const owner = playlist?.creator?.name ?? playlist?.creator?.username ?? '';
    const cover = buildImageUrl(playlist?.squareImage, 320);
    return {
      id: this.makeUri('playlist', id),
      audiopath: this.makeUri('playlist', id),
      name,
      title: name,
      owner,
      owner_id: owner,
      coverurl: cover,
      thumbnail: cover,
      type: FileType.PlaylistBrowsable,
      tag: 'playlist',
      provider: 'tidal',
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Tidal API helpers                                                        */
  /* ------------------------------------------------------------------------ */

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }
    return headers;
  }

  private async fetchJson<T>(url: string): Promise<T | null> {
    if (!this.accessToken) {
      return null;
    }
    try {
      const parsed = new URL(url);
      if (!parsed.searchParams.has('countryCode')) {
        parsed.searchParams.set('countryCode', this.countryCode);
      }
      const res = await fetch(parsed.toString(), { headers: this.buildHeaders() });
      if (!res.ok) {
        return null;
      }
      const data = (await res.json()) as T;
      return data;
    } catch (err) {
      this.log.warn('tidal request failed', { url, message: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  private async fetchSearchResults(kind: 'tracks' | 'albums' | 'artists' | 'playlists', query: string, limit: number): Promise<any[]> {
    const url = new URL(`${TIDAL_API_BASE}/search/${kind}`);
    url.searchParams.set('query', query);
    url.searchParams.set('limit', String(limit));
    const data = await this.fetchJson<any>(url.toString());
    return Array.isArray(data?.items) ? data.items : [];
  }

  private async fetchAlbumTracks(
    albumId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const url = new URL(`${TIDAL_API_BASE}/albums/${encodeURIComponent(albumId)}/tracks`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    const data = await this.fetchJson<any>(url.toString());
    const items = Array.isArray(data?.items) ? data.items : [];
    return {
      items: items.map((track: any) => this.mapTrack(track)),
      total: typeof data?.totalNumberOfItems === 'number' ? data.totalNumberOfItems : undefined,
    };
  }

  private async fetchArtistAlbums(
    artistId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const url = new URL(`${TIDAL_API_BASE}/artists/${encodeURIComponent(artistId)}/albums`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    const data = await this.fetchJson<any>(url.toString());
    const items = Array.isArray(data?.items) ? data.items : [];
    return {
      items: items.map((album: any) => this.mapAlbum(album)),
      total: typeof data?.totalNumberOfItems === 'number' ? data.totalNumberOfItems : undefined,
    };
  }

  private async fetchPlaylistTracks(
    playlistId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const url = new URL(`${TIDAL_API_BASE}/playlists/${encodeURIComponent(playlistId)}/tracks`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    const data = await this.fetchJson<any>(url.toString());
    const items = Array.isArray(data?.items) ? data.items : [];
    return {
      items: items.map((entry: any) => this.mapTrack(entry?.item ?? entry)),
      total: typeof data?.totalNumberOfItems === 'number' ? data.totalNumberOfItems : undefined,
    };
  }
}

function buildImageUrl(coverId: string | null | undefined, size = 320): string {
  if (!coverId) return '';
  const path = coverId.replace(/-/g, '/');
  return `https://resources.tidal.com/images/${path}/${size}x${size}.jpg`;
}
