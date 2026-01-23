import type { ContentFolder, ContentFolderItem, ContentServiceAccount, PlaylistEntry } from '@/ports/ContentTypes';
import { createLogger } from '@/shared/logging/logger';
import { DEFAULT_MIN_SEARCH_LIMIT } from '@/adapters/content/utils/searchLimits';

const enum FileType {
  Folder = 1,
  File = 2,
  PlaylistBrowsable = 7,
}

const APPLE_MUSIC_API_BASE = 'https://amp-api.music.apple.com/v1';
const BEARER_TOKEN_TTL_MS = 30 * 60 * 1000;

type SearchResult = {
  tracks?: ContentFolderItem[];
  albums?: ContentFolderItem[];
  artists?: ContentFolderItem[];
  playlists?: ContentFolderItem[];
};

interface AppleMusicProviderOptions {
  providerId: string;
  label?: string;
  storefront?: string;
  developerToken?: string;
  userToken?: string;
}

/**
 * Lightweight Apple Music provider that mirrors the Spotify facade shape.
 * Uses the iTunes/Apple Music APIs for metadata (no playback).
 */
export class AppleMusicProvider {
  public readonly providerId: string;
  private readonly log = createLogger('Content', 'AppleMusic');
  private readonly label: string;
  private storefront: string;
  private readonly developerToken?: string;
  private readonly userToken?: string;
  private bearerToken?: string;
  private bearerTokenFetchedAt = 0;
  private bearerTokenPromise: Promise<string | null> | null = null;
  private storefrontResolved = false;
  private storefrontPromise: Promise<string> | null = null;

  constructor(options: AppleMusicProviderOptions) {
    this.providerId = options.providerId;
    this.label = options.label || 'Apple Music';
    this.storefront = (options.storefront || 'us').toLowerCase();
    this.developerToken = options.developerToken;
    this.userToken = options.userToken;
  }

  public get accountId(): string {
    return 'applemusic';
  }

  public get displayLabel(): string {
    return this.label;
  }

  public getServiceAccount(): ContentServiceAccount {
    return {
      id: this.providerId,
      label: this.displayLabel,
      provider: 'applemusic',
      fake: true,
    };
  }

  public async fetchAccessToken(): Promise<string | null> {
    // Apple Music uses developer/user tokens; no runtime fetch.
    return this.developerToken ?? null;
  }

  public async getPlaylists(_offset: number, _limit: number): Promise<PlaylistEntry[]> {
    // Catalog playlists are not enumerated here; search returns playlists.
    return [];
  }

  public async getFolder(folderId: string, offset: number, limit: number): Promise<ContentFolder | null> {
    const normalized = this.normalizeFolderId(folderId);
    switch (normalized.type) {
      case 'root':
        return this.buildRootFolder(offset);
      case 'albums': {
        const albumResult = await this.fetchLibraryAlbums(limit || 50, offset);
        return {
          id: folderId,
          name: 'Albums',
          service: 'applemusic',
          start: offset,
          totalitems: typeof albumResult.total === 'number' ? albumResult.total : albumResult.items.length,
          items: albumResult.items,
        };
      }
      case 'artists': {
        const artistResult = await this.fetchLibraryArtists(limit || 50, offset);
        return {
          id: folderId,
          name: 'Artists',
          service: 'applemusic',
          start: offset,
          totalitems: typeof artistResult.total === 'number' ? artistResult.total : artistResult.items.length,
          items: artistResult.items,
        };
      }
      case 'playlists': {
        const playlistResult = await this.fetchLibraryPlaylists(limit || 50, offset);
        return {
          id: folderId,
          name: 'Playlists',
          service: 'applemusic',
          start: offset,
          totalitems: typeof playlistResult.total === 'number' ? playlistResult.total : playlistResult.items.length,
          items: playlistResult.items,
        };
      }
      case 'newReleases': {
        const newResult = await this.fetchNewReleases(limit || 50, offset);
        return {
          id: folderId,
          name: 'New Releases',
          service: 'applemusic',
          start: offset,
          totalitems: typeof newResult.total === 'number' ? newResult.total : newResult.items.length,
          items: newResult.items,
        };
      }
      case 'recommendationsPlaylists': {
        const recResult = await this.fetchRecommendations(limit || 50, offset, new Set(['playlists']));
        return {
          id: folderId,
          name: 'Recommended Playlists',
          service: 'applemusic',
          start: offset,
          totalitems: typeof recResult.total === 'number' ? recResult.total : recResult.items.length,
          items: recResult.items,
        };
      }
      case 'recommendationsAlbums': {
        const recResult = await this.fetchRecommendations(limit || 50, offset, new Set(['albums']));
        return {
          id: folderId,
          name: 'Recommended Albums',
          service: 'applemusic',
          start: offset,
          totalitems: typeof recResult.total === 'number' ? recResult.total : recResult.items.length,
          items: recResult.items,
        };
      }
      case 'songs': {
        const songsResult = await this.fetchLibrarySongs(limit || 50, offset);
        return {
          id: folderId,
          name: 'Songs',
          service: 'applemusic',
          start: offset,
          totalitems: typeof songsResult.total === 'number' ? songsResult.total : songsResult.items.length,
          items: songsResult.items,
        };
      }
      case 'recent': {
        const recentResult = await this.fetchLibraryRecentAlbums(limit || 50, offset);
        return {
          id: folderId,
          name: 'Recently Added',
          service: 'applemusic',
          start: offset,
          totalitems: typeof recentResult.total === 'number' ? recentResult.total : recentResult.items.length,
          items: recentResult.items,
        };
      }
      case 'albumItem': {
        const result = normalized.source === 'library'
          ? await this.fetchLibraryAlbumTracks(normalized.id, limit || 50, offset)
          : await this.fetchAlbumTracks(normalized.id, limit || 50, offset);
        return {
          id: folderId,
          name: 'Album',
          service: 'applemusic',
          start: offset,
          totalitems: typeof result.total === 'number' ? result.total : result.items.length,
          items: result.items,
        };
      }
      case 'artistItem': {
        const result = normalized.source === 'library'
          ? await this.fetchLibraryArtistAlbums(normalized.id, limit || 50, offset)
          : await this.fetchArtistTopTracks(normalized.id, limit || 50, offset);
        return {
          id: folderId,
          name: 'Artist',
          service: 'applemusic',
          start: offset,
          totalitems: typeof result.total === 'number' ? result.total : result.items.length,
          items: result.items,
        };
      }
      case 'playlistItem': {
        const result = normalized.source === 'library'
          ? await this.fetchLibraryPlaylistTracks(normalized.id, limit || 50, offset)
          : await this.fetchPlaylistTracks(normalized.id, limit || 50, offset);
        return {
          id: folderId,
          name: 'Playlist',
          service: 'applemusic',
          start: offset,
          totalitems: typeof result.total === 'number' ? result.total : result.items.length,
          items: result.items,
        };
      }
      default:
        return {
          id: folderId,
          name: this.displayLabel,
          service: 'applemusic',
          start: offset,
          totalitems: 0,
          items: [],
        };
    }
  }

  public async getTrack(trackId: string): Promise<ContentFolderItem | null> {
    const normalized = this.normalizeItemId(trackId, 'track');
    const id = normalized.id;
    if (!id) {
      return null;
    }
    const item = normalized.source === 'library'
      ? await this.lookup(`${APPLE_MUSIC_API_BASE}/me/library/songs/${encodeURIComponent(id)}`)
      : await this.lookup(`${APPLE_MUSIC_API_BASE}/catalog/${await this.ensureStorefront()}/songs/${encodeURIComponent(id)}`);
    if (!item) {
      return null;
    }
    return normalized.source === 'library' ? this.mapLibraryTrack(item) : this.mapTrack(item);
  }

  public async search(query: string, limits: Record<string, number>, maxLimit: number): Promise<{ result: SearchResult; providerId: string; user: string }> {
    const limit = Math.min(
      Math.max(...(Object.values(limits).length ? Object.values(limits) : [maxLimit]), DEFAULT_MIN_SEARCH_LIMIT),
      maxLimit,
    );
    const storefront = await this.ensureStorefront();
    const url = new URL(`${APPLE_MUSIC_API_BASE}/catalog/${storefront}/search`);
    url.searchParams.set('term', query);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('types', ['songs', 'albums', 'artists', 'playlists'].join(','));

    const data = await this.fetchJson<any>(url.toString());
    const result: SearchResult = {};
    if (data?.results?.songs?.data) {
      result.tracks = (data.results.songs.data as any[]).map((t) => this.mapTrack(t));
    }
    if (data?.results?.albums?.data) {
      result.albums = (data.results.albums.data as any[]).map((a) => this.mapAlbum(a));
    }
    if (data?.results?.artists?.data) {
      result.artists = (data.results.artists.data as any[]).map((a) => this.mapArtist(a));
    }
    if (data?.results?.playlists?.data) {
      result.playlists = (data.results.playlists.data as any[]).map((p) => this.mapPlaylist(p));
    }
    return { result, providerId: this.providerId, user: 'applemusic' };
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
      service: 'applemusic',
      start: offset,
      totalitems: 6,
      items: [
        this.folderLink('0', 'New Releases'),
        this.folderLink('1', 'Recommended Playlists'),
        this.folderLink('2', 'Recommended Albums'),
        this.folderLink('albums', 'Albums'),
        this.folderLink('artists', 'Artists'),
        this.folderLink('playlists', 'Playlists'),
      ],
    };
  }

  private folderLink(id: string, name: string): ContentFolderItem {
    return {
      id,
      name,
      type: FileType.Folder,
      items: 0,
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
  ): { id: string; source: 'catalog' | 'library' } {
    const raw = this.stripProviderPrefix(value || '').trim();
    const libraryMatch = raw.match(new RegExp(`(?:^|:)library-${kind}:(.+)$`, 'i'));
    if (libraryMatch) {
      return { id: this.decodeId(libraryMatch[1]), source: 'library' };
    }
    const match = raw.match(new RegExp(`(?:^|:)${kind}:(.+)$`, 'i'));
    const id = match ? match[1] : raw;
    return { id: this.decodeId(id), source: 'catalog' };
  }

  private normalizeFolderId(folderId: string):
    | { type: 'root' }
    | { type: 'albums' }
    | { type: 'artists' }
    | { type: 'playlists' }
    | { type: 'newReleases' }
    | { type: 'recommendationsPlaylists' }
    | { type: 'recommendationsAlbums' }
    | { type: 'songs' }
    | { type: 'recent' }
    | { type: 'albumItem'; id: string; source: 'catalog' | 'library' }
    | { type: 'artistItem'; id: string; source: 'catalog' | 'library' }
    | { type: 'playlistItem'; id: string; source: 'catalog' | 'library' }
    | { type: 'unknown' } {
    const raw = this.stripProviderPrefix(folderId || 'root').trim();
    const lower = raw.toLowerCase();
    if (lower === 'root' || lower === 'start') {
      return { type: 'root' };
    }
    if (lower === 'albums' || lower === 'album' || lower === '5') {
      return { type: 'albums' };
    }
    if (lower === 'artists' || lower === 'artist' || lower === '6') {
      return { type: 'artists' };
    }
    if (lower === 'playlists' || lower === 'playlist' || lower === '3') {
      return { type: 'playlists' };
    }
    if (lower === 'new-releases' || lower === 'new' || lower === '0') {
      return { type: 'newReleases' };
    }
    if (lower === 'recommendations-playlists' || lower === 'recommended-playlists' || lower === '1') {
      return { type: 'recommendationsPlaylists' };
    }
    if (lower === 'recommendations-albums' || lower === 'recommended-albums' || lower === '2') {
      return { type: 'recommendationsAlbums' };
    }
    if (lower === 'songs' || lower === 'tracks') {
      return { type: 'songs' };
    }
    if (lower === 'recent' || lower === 'recently-added') {
      return { type: 'recent' };
    }

    const libraryAlbumMatch = raw.match(/(?:^|:)library-album:(.+)$/i);
    if (libraryAlbumMatch) {
      return { type: 'albumItem', id: this.decodeId(libraryAlbumMatch[1]), source: 'library' };
    }
    const libraryArtistMatch = raw.match(/(?:^|:)library-artist:(.+)$/i);
    if (libraryArtistMatch) {
      return { type: 'artistItem', id: this.decodeId(libraryArtistMatch[1]), source: 'library' };
    }
    const libraryPlaylistMatch = raw.match(/(?:^|:)library-playlist:(.+)$/i);
    if (libraryPlaylistMatch) {
      return { type: 'playlistItem', id: this.decodeId(libraryPlaylistMatch[1]), source: 'library' };
    }

    const albumMatch = raw.match(/(?:^|:)album:(.+)$/i);
    if (albumMatch) {
      return { type: 'albumItem', id: this.decodeId(albumMatch[1]), source: 'catalog' };
    }
    const artistMatch = raw.match(/(?:^|:)artist:(.+)$/i);
    if (artistMatch) {
      return { type: 'artistItem', id: this.decodeId(artistMatch[1]), source: 'catalog' };
    }
    const playlistMatch = raw.match(/(?:^|:)playlist:(.+)$/i);
    if (playlistMatch) {
      return { type: 'playlistItem', id: this.decodeId(playlistMatch[1]), source: 'catalog' };
    }
    return { type: 'unknown' };
  }

  private mapTrack(track: any): ContentFolderItem {
    const attrs = track?.attributes ?? track;
    const id = this.encodeId(track?.id ?? attrs?.id ?? '');
    const name = attrs?.name ?? 'Track';
    const artist = attrs?.artistName ?? '';
    const album = attrs?.albumName ?? '';
    const cover = this.extractArtwork(attrs);
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
      duration: typeof attrs?.durationInMillis === 'number'
        ? Math.round(attrs.durationInMillis / 1000)
        : undefined,
      hasCover: !!cover,
      provider: 'applemusic',
    };
  }

  private mapLibraryTrack(track: any): ContentFolderItem {
    const attrs = track?.attributes ?? track;
    const id = this.encodeId(track?.id ?? attrs?.id ?? '');
    const name = attrs?.name ?? 'Track';
    const artist = attrs?.artistName ?? '';
    const album = attrs?.albumName ?? '';
    const cover = this.extractArtwork(attrs);
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
      duration: typeof attrs?.durationInMillis === 'number'
        ? Math.round(attrs.durationInMillis / 1000)
        : undefined,
      hasCover: !!cover,
      provider: 'applemusic',
    };
  }

  private mapAlbum(album: any): ContentFolderItem {
    const attrs = album?.attributes ?? album;
    const id = this.encodeId(album?.id ?? attrs?.id ?? '');
    const name = attrs?.name ?? 'Album';
    const artist = attrs?.artistName ?? '';
    const cover = this.extractArtwork(attrs);
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
      provider: 'applemusic',
    };
  }

  private mapLibraryAlbum(album: any): ContentFolderItem {
    const attrs = album?.attributes ?? album;
    const id = this.encodeId(album?.id ?? attrs?.id ?? '');
    const name = attrs?.name ?? 'Album';
    const artist = attrs?.artistName ?? '';
    const cover = this.extractArtwork(attrs);
    return {
      id: this.makeUri('library-album', id),
      audiopath: this.makeUri('library-album', id),
      name,
      title: name,
      artist,
      coverurl: cover,
      thumbnail: cover,
      type: FileType.PlaylistBrowsable,
      tag: 'album',
      provider: 'applemusic',
    };
  }

  private mapArtist(artistObj: any): ContentFolderItem {
    const attrs = artistObj?.attributes ?? artistObj;
    const id = this.encodeId(artistObj?.id ?? attrs?.id ?? '');
    const name = attrs?.name ?? 'Artist';
    const cover = this.extractArtwork(attrs);
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
      provider: 'applemusic',
    };
  }

  private mapLibraryArtist(artistObj: any): ContentFolderItem {
    const relCatalogAttrs =
      artistObj?.relationships?.catalog?.data?.[0]?.attributes ??
      artistObj?.relationships?.catalog?.data?.[0];
    const attrs = relCatalogAttrs ?? artistObj?.attributes ?? artistObj;
    const id = this.encodeId(artistObj?.id ?? attrs?.id ?? '');
    const name = attrs?.name ?? 'Artist';
    const cover = this.extractArtwork(attrs);
    return {
      id: this.makeUri('library-artist', id),
      audiopath: this.makeUri('library-artist', id),
      name,
      title: name,
      artist: name,
      coverurl: cover,
      thumbnail: cover,
      type: FileType.PlaylistBrowsable,
      tag: 'artist',
      provider: 'applemusic',
    };
  }

  private mapPlaylist(playlist: any): ContentFolderItem {
    const attrs = playlist?.attributes ?? playlist;
    const id = this.encodeId(playlist?.id ?? attrs?.id ?? '');
    const name = attrs?.name ?? 'Playlist';
    const cover = this.extractArtwork(attrs);
    return {
      id: this.makeUri('playlist', id),
      audiopath: this.makeUri('playlist', id),
      name,
      title: name,
      owner: attrs?.curatorName || '',
      owner_id: attrs?.curatorName || '',
      coverurl: cover,
      thumbnail: cover,
      type: FileType.PlaylistBrowsable,
      tag: 'playlist',
      provider: 'applemusic',
    };
  }

  private mapLibraryPlaylist(playlist: any): ContentFolderItem {
    const attrs = playlist?.attributes ?? playlist;
    const id = this.encodeId(playlist?.id ?? attrs?.id ?? '');
    const name = attrs?.name ?? 'Playlist';
    const cover = this.extractArtwork(attrs);
    return {
      id: this.makeUri('library-playlist', id),
      audiopath: this.makeUri('library-playlist', id),
      name,
      title: name,
      owner: attrs?.curatorName || attrs?.creatorName || '',
      owner_id: attrs?.curatorName || attrs?.creatorName || '',
      coverurl: cover,
      thumbnail: cover,
      type: FileType.PlaylistBrowsable,
      tag: 'playlist',
      provider: 'applemusic',
    };
  }

  private mapRecommendationItem(item: any): ContentFolderItem | null {
    switch (item?.type) {
      case 'albums':
        return this.mapAlbum(item);
      case 'playlists':
        return this.mapPlaylist(item);
      case 'artists':
        return this.mapArtist(item);
      case 'songs':
        return this.mapTrack(item);
      default:
        return null;
    }
  }

  private encodeId(raw: string): string {
    if (!raw) {
      return '';
    }
    if (raw.startsWith('b64_')) {
      return raw;
    }
    return `b64_${Buffer.from(raw, 'utf-8').toString('base64')}`;
  }

  private decodeId(raw: string): string {
    if (!raw) {
      return '';
    }
    if (raw.startsWith('b64_')) {
      try {
        return Buffer.from(raw.slice(4), 'base64').toString('utf-8');
      } catch {
        return raw.slice(4);
      }
    }
    return raw;
  }

  private extractArtwork(attrs: any): string {
    const fromTemplate = (tmpl?: string): string | null => {
      if (typeof tmpl === 'string' && tmpl.includes('{w}') && tmpl.includes('{h}')) {
        return tmpl.replace('{w}', '256').replace('{h}', '256');
      }
      if (typeof tmpl === 'string' && tmpl.startsWith('http')) {
        return tmpl;
      }
      return null;
    };

    const direct = fromTemplate(attrs?.artwork?.url);
    if (direct) {
      return direct;
    }

    if (typeof attrs?.artworkUrl100 === 'string') {
      return attrs.artworkUrl100.replace(/\/\d+x\d+bb\.jpg/i, '/256x256bb.jpg');
    }

    const editorial = attrs?.editorialArtwork;
    if (editorial && typeof editorial === 'object') {
      for (const key of Object.keys(editorial)) {
        const entry = editorial[key];
        const candidate = fromTemplate(entry?.url);
        if (candidate) {
          return candidate;
        }
      }
    }

    return '';
  }

  private extractCatalogArtistId(attrs: any): string {
    const url = typeof attrs?.url === 'string' ? attrs.url : '';
    const match = url.match(/\/artist\/[^/]+\/(\d+)/i);
    if (match) {
      return match[1];
    }
    return '';
  }

  private extractCatalogIdFromPlayParams(playParams: any): string {
    if (playParams && typeof playParams.catalogId === 'string') {
      return playParams.catalogId;
    }
    return '';
  }

  /* ------------------------------------------------------------------------ */
  /* Apple Music fetch helpers                                                */
  /* ------------------------------------------------------------------------ */

  private async fetchJson<T>(url: string, retryAuth = true): Promise<T | null> {
    try {
      const headers = await this.buildAuthHeaders();
      let res = await fetch(url, { headers });
      if ((res.status === 401 || res.status === 403) && retryAuth) {
        await this.refreshBearerToken();
        const retryHeaders = await this.buildAuthHeaders();
        res = await fetch(url, { headers: retryHeaders });
      }
      if (!res.ok) {
        return null;
      }
      const data = (await res.json()) as T;
      return data;
    } catch (err) {
      this.log.warn('apple music request failed', { url, message: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  private async lookup(url: string): Promise<any | null> {
    const data = await this.fetchJson<any>(url);
    const items = data?.data;
    if (Array.isArray(items) && items.length) {
      return items[0];
    }
    return null;
  }

  private async fetchAlbumTracks(
    albumId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const storefront = await this.ensureStorefront();
    const url = `${APPLE_MUSIC_API_BASE}/catalog/${storefront}/albums/${encodeURIComponent(albumId)}/tracks?limit=${limit}&offset=${offset}`;
    const data = await this.fetchJson<any>(url);
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((t: any) => this.mapTrack(t)),
      total: typeof data?.meta?.total === 'number' ? data.meta.total : undefined,
    };
  }

  private async fetchArtistTopTracks(
    artistId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const storefront = await this.ensureStorefront();
    const url = `${APPLE_MUSIC_API_BASE}/catalog/${storefront}/artists/${encodeURIComponent(artistId)}/view/top-songs?limit=${limit}&offset=${offset}`;
    const data = await this.fetchJson<any>(url);
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((t: any) => this.mapTrack(t)),
      total: typeof data?.meta?.total === 'number' ? data.meta.total : undefined,
    };
  }

  private async fetchPlaylistTracks(
    playlistId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const storefront = await this.ensureStorefront();
    const url = `${APPLE_MUSIC_API_BASE}/catalog/${storefront}/playlists/${encodeURIComponent(playlistId)}/tracks?limit=${limit}&offset=${offset}`;
    const data = await this.fetchJson<any>(url);
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((t: any) => this.mapTrack(t)),
      total: typeof data?.meta?.total === 'number' ? data.meta.total : undefined,
    };
  }

  private async fetchLibraryAlbums(
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const url = `${APPLE_MUSIC_API_BASE}/me/library/albums?limit=${limit}&offset=${offset}`;
    const data = await this.fetchJson<any>(url);
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((entry: any) => this.mapLibraryAlbum(entry)),
      total: typeof data?.meta?.total === 'number' ? data.meta.total : undefined,
    };
  }

  private async fetchLibraryArtists(
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    // Request catalog relationship so we can reuse catalog artwork without extra calls.
    const url = `${APPLE_MUSIC_API_BASE}/me/library/artists?limit=${limit}&offset=${offset}&include=catalog`;
    const data = await this.fetchJson<any>(url);
    const items = Array.isArray(data?.data) ? data.data : [];
    const mapped: ContentFolderItem[] = items.map((entry: any) => this.mapLibraryArtist(entry));
    return {
      items: mapped,
      total: typeof data?.meta?.total === 'number' ? data.meta.total : undefined,
    };
  }

  private async fetchLibraryPlaylists(
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const url = `${APPLE_MUSIC_API_BASE}/me/library/playlists?limit=${limit}&offset=${offset}`;
    const data = await this.fetchJson<any>(url);
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((entry: any) => this.mapLibraryPlaylist(entry)),
      total: typeof data?.meta?.total === 'number' ? data.meta.total : undefined,
    };
  }

  private async fetchLibrarySongs(
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const url = `${APPLE_MUSIC_API_BASE}/me/library/songs?limit=${limit}&offset=${offset}`;
    const data = await this.fetchJson<any>(url);
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((entry: any) => this.mapLibraryTrack(entry)),
      total: typeof data?.meta?.total === 'number' ? data.meta.total : undefined,
    };
  }

  private async fetchLibraryRecentAlbums(
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const url = `${APPLE_MUSIC_API_BASE}/me/library/albums?limit=${limit}&offset=${offset}&sort=recent`;
    const data = await this.fetchJson<any>(url);
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((entry: any) => this.mapLibraryAlbum(entry)),
      total: typeof data?.meta?.total === 'number' ? data.meta.total : undefined,
    };
  }

  private async fetchLibraryAlbumTracks(
    albumId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const url = `${APPLE_MUSIC_API_BASE}/me/library/albums/${encodeURIComponent(albumId)}/tracks?limit=${limit}&offset=${offset}`;
    const data = await this.fetchJson<any>(url);
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((t: any) => this.mapLibraryTrack(t)),
      total: typeof data?.meta?.total === 'number' ? data.meta.total : undefined,
    };
  }

  private async fetchLibraryPlaylistTracks(
    playlistId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const url = `${APPLE_MUSIC_API_BASE}/me/library/playlists/${encodeURIComponent(playlistId)}/tracks?limit=${limit}&offset=${offset}`;
    const data = await this.fetchJson<any>(url);
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((t: any) => this.mapLibraryTrack(t)),
      total: typeof data?.meta?.total === 'number' ? data.meta.total : undefined,
    };
  }

  private async fetchLibraryArtistAlbums(
    artistId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const url = `${APPLE_MUSIC_API_BASE}/me/library/artists/${encodeURIComponent(artistId)}/albums?limit=${limit}&offset=${offset}`;
    const data = await this.fetchJson<any>(url);
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((entry: any) => this.mapLibraryAlbum(entry)),
      total: typeof data?.meta?.total === 'number' ? data.meta.total : undefined,
    };
  }

  private async fetchRecommendations(
    limit: number,
    offset: number,
    allowedTypes?: Set<string>,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const url = new URL(`${APPLE_MUSIC_API_BASE}/me/recommendations`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    const data = await this.fetchJson<any>(url.toString());
    const groups = Array.isArray(data?.data) ? data.data : [];
    const items: ContentFolderItem[] = [];
    for (const group of groups) {
      const contents = group?.relationships?.contents?.data;
      if (!Array.isArray(contents)) {
        continue;
      }
      for (const entry of contents) {
        const type = entry?.type;
        if (allowedTypes && (!type || !allowedTypes.has(type))) {
          continue;
        }
        const mapped = this.mapRecommendationItem(entry);
        if (mapped) {
          items.push(mapped);
        }
      }
    }
    return {
      items,
      total: items.length,
    };
  }

  private async fetchNewReleases(
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const storefront = await this.ensureStorefront();
    const url = new URL(`${APPLE_MUSIC_API_BASE}/catalog/${storefront}/new-releases`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    const data = await this.fetchJson<any>(url.toString());
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((entry: any) => this.mapAlbum(entry)),
      total: typeof data?.meta?.total === 'number' ? data.meta.total : undefined,
    };
  }

  private baseHeaders(): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:95.0) Gecko/20100101 Firefox/95.0',
      Accept: 'application/json',
      'Accept-Language': 'en-US',
      'Accept-Encoding': 'utf-8',
      'content-type': 'application/json',
      'Media-User-Token': this.userToken || '',
      'x-apple-renewal': 'true',
      DNT: '1',
      Connection: 'keep-alive',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
      origin: 'https://music.apple.com',
      referer: 'https://music.apple.com/',
    };
  }

  private async buildAuthHeaders(): Promise<Record<string, string>> {
    const headers = this.baseHeaders();
    if (this.userToken) {
      headers['Music-User-Token'] = this.userToken;
      headers['Media-User-Token'] = this.userToken;
    } else {
      delete headers['Media-User-Token'];
    }
    let bearer = await this.ensureBearerToken();
    if (!bearer && this.developerToken) {
      bearer = this.developerToken;
    }
    if (bearer) {
      headers.authorization = `Bearer ${bearer}`;
    }
    return headers;
  }

  private async ensureBearerToken(): Promise<string | null> {
    if (!this.userToken) {
      return null;
    }
    if (this.bearerToken && Date.now() - this.bearerTokenFetchedAt < BEARER_TOKEN_TTL_MS) {
      return this.bearerToken;
    }
    if (this.bearerTokenPromise) {
      return this.bearerTokenPromise;
    }
    this.bearerTokenPromise = (async () => {
      try {
        const homeRes = await fetch('https://music.apple.com', { headers: this.baseHeaders() });
        const homeText = await homeRes.text();
        const match = homeText.match(/\/(assets\/index-legacy[~-][^/\"]+\.js)/i);
        if (!match) {
          this.log.warn('apple music token fetch failed: index js not found');
          return null;
        }
        const jsRes = await fetch(`https://music.apple.com/${match[1]}`, { headers: this.baseHeaders() });
        const jsText = await jsRes.text();
        const tokenMatch = jsText.match(/eyJh[^"]+/);
        if (!tokenMatch) {
          this.log.warn('apple music token fetch failed: bearer token not found');
          return null;
        }
        this.bearerToken = tokenMatch[0];
        this.bearerTokenFetchedAt = Date.now();
        return this.bearerToken;
      } catch (err) {
        this.log.warn('apple music token fetch failed', { message: err instanceof Error ? err.message : String(err) });
        return null;
      }
    })();
    try {
      return await this.bearerTokenPromise;
    } finally {
      this.bearerTokenPromise = null;
    }
  }

  private async refreshBearerToken(): Promise<void> {
    this.bearerToken = undefined;
    this.bearerTokenFetchedAt = 0;
    await this.ensureBearerToken();
  }

  private async ensureStorefront(): Promise<string> {
    if (this.storefrontResolved) {
      return this.storefront;
    }
    if (this.storefrontPromise) {
      return this.storefrontPromise;
    }
    this.storefrontPromise = (async () => {
      if (!this.userToken) {
        this.storefrontResolved = true;
        return this.storefront;
      }
      const account = await this.fetchJson<any>(`${APPLE_MUSIC_API_BASE}/me/account?meta=subscription`);
      const storefront = account?.meta?.subscription?.storefront;
      if (storefront) {
        this.storefront = String(storefront).toLowerCase();
      }
      this.storefrontResolved = true;
      return this.storefront;
    })();
    try {
      return await this.storefrontPromise;
    } finally {
      this.storefrontPromise = null;
    }
  }
}
