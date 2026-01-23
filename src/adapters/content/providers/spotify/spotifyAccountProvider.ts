import type { SpotifyAccountConfig } from '@/domain/config/types';
import type {
  ContentFolder,
  ContentFolderItem,
  ContentServiceAccount,
  PlaylistEntry,
} from '@/ports/ContentTypes';
import { createLogger, type ComponentLogger } from '@/shared/logging/logger';
import { safeReadText } from '@/shared/bestEffort';
import { resolveSpotifyClientId } from '@/adapters/content/providers/spotify/utils';

const enum FileType {
  Folder = 1,
  File = 2,
  PlaylistBrowsable = 7,
}

const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

export interface SpotifyAccountState extends SpotifyAccountConfig {
  id: string;
  refreshToken?: string;
}

export interface SpotifyConnectDevice {
  id: string;
  name: string;
  type?: string;
  isActive?: boolean;
  isPrivateSession?: boolean;
  isRestricted?: boolean;
  supportsVolume?: boolean;
  volumePercent?: number;
}

export type PersistAccountCallback = (
  accountId: string,
  patch: Partial<SpotifyAccountConfig>,
) => Promise<SpotifyAccountConfig | null>;

export type CredentialLoginCallback = (
  accountId: string,
  creds: { username: string; credentials: string },
) => Promise<void>;

export interface SpotifyAccountProviderOptions {
  providerId: string;
  account: SpotifyAccountState;
  clientId?: string;
  persistAccount: PersistAccountCallback;
  persistLibrespotCredentials?: CredentialLoginCallback;
}

interface SpotifyApiResult<T> {
  ok: boolean;
  status: number;
  body: T | null;
}

/**
 * Wraps Spotify API operations for a single configured account.
 */
export class SpotifyAccountProvider {
  public readonly providerId: string;

  private readonly log: ComponentLogger;
  private readonly persistAccountState: PersistAccountCallback;
  private readonly clientId: string;
  private readonly persistLibrespotCredentials?: CredentialLoginCallback;

  private account: SpotifyAccountState;
  private accessToken?: string;
  private tokenExpiresAt = 0;
  private authError = false;
  private refreshPromise: Promise<string | null> | null = null;

  constructor(options: SpotifyAccountProviderOptions) {
    this.providerId = options.providerId;
    this.account = { ...options.account };
    this.persistAccountState = options.persistAccount;
    this.persistLibrespotCredentials = options.persistLibrespotCredentials;
    this.clientId = resolveSpotifyClientId({ clientId: this.account.clientId ?? options.clientId });
    this.log = createLogger('Content', `Spotify:${this.account.id}`);
  }

  public get accountId(): string {
    return this.account.id;
  }

  public get displayLabel(): string {
    return (
      this.account.displayName ||
      this.account.user ||
      this.account.name ||
      this.account.email ||
      this.account.id
    );
  }

  public get serviceId(): string {
    return this.providerId;
  }

  public get hasAuthError(): boolean {
    return this.authError;
  }

  public getServiceAccount(): ContentServiceAccount {
    return {
      id: this.serviceId,
      label: this.displayLabel,
      provider: 'spotify',
      product: this.account.product,
    };
  }

  /**
   * List Spotify Connect devices visible to this account.
   */
  public async listConnectDevices(): Promise<SpotifyConnectDevice[]> {
    const payload = await this.request<{ devices?: any[] }>(`${SPOTIFY_API_BASE}/me/player/devices`);
    const devices = Array.isArray(payload?.devices) ? payload?.devices ?? [] : [];
    return devices
      .map((entry) => this.mapConnectDevice(entry))
      .filter((device): device is SpotifyConnectDevice => !!device);
  }

  public updateAccount(newState: SpotifyAccountConfig): void {
    this.account = { ...this.account, ...newState } as SpotifyAccountState;
  }

  /**
   * Resolve a single track by id.
   */
  public async getTrack(trackId: string): Promise<ContentFolderItem | null> {
    const id = (trackId || '').trim();
    if (!id) {
      return null;
    }
    const data = await this.request<any>(`${SPOTIFY_API_BASE}/tracks/${encodeURIComponent(id)}`);
    if (!data) {
      return null;
    }
    return this.mapTrack(data);
  }

  private get userKey(): string {
    return this.account.user || this.account.displayName || this.account.name || this.account.id;
  }

  private makeUri(type: string, id: string): string {
    // Single provider prefix, no double user segment to keep IDs stable.
    return `${this.providerId}:${type}:${id}`;
  }

  public async getPlaylists(offset: number, limit: number): Promise<PlaylistEntry[]> {
    const rawItems = await this.fetchUserPlaylists(offset, limit);
    return rawItems.items.map((item) => ({
      id: item.id,
      name: item.name,
      tracks: item.items ?? 0,
      audiopath: item.audiopath ?? item.id,
      coverurl: item.coverurl,
    }));
  }

  public async getFolder(
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    const normalized = this.normalizeFolderId(folderId);

    switch (normalized.type) {
      case 'root':
        return this.buildRootFolder(offset);
      case 'playlists':
        return this.buildFolder(
          folderId,
          'Playlists',
          await this.fetchUserPlaylists(offset, limit),
          offset,
        );
      case 'albums':
        return this.buildFolder(
          folderId,
          'Albums',
          await this.fetchUserAlbums(offset, limit),
          offset,
        );
      case 'artists':
        return this.buildFolder(
          folderId,
          'Artists',
          await this.fetchUserArtists(limit || 20),
          offset,
        );
      case 'popular':
        return this.buildFolder(
          folderId,
          'Popular Playlists',
          await this.fetchPopularPlaylists(limit || 20),
          offset,
        );
      case 'new':
        return this.buildFolder(
          folderId,
          'New Releases',
          await this.fetchNewReleases(limit || 20),
          offset,
        );
      case 'genres':
        return this.buildFolder(
          folderId,
          'Genres',
          await this.fetchBrowseCategories(offset, limit || 20),
          offset,
        );
      case 'category':
        return this.buildFolder(
          folderId,
          'Category',
          await this.fetchCategoryPlaylists(normalized.id, offset, limit || 20),
          offset,
        );
      case 'playlistItem':
        return this.buildFolder(
          folderId,
          'Playlist',
          await this.fetchPlaylistTracks(normalized.id, offset, limit || 50),
          offset,
        );
      case 'albumItem':
        return this.buildFolder(
          folderId,
          'Album',
          await this.fetchAlbumTracks(normalized.id, offset, limit || 50),
          offset,
        );
      case 'artistItem':
        return this.buildFolder(
          folderId,
          'Artist',
          await this.fetchArtistTopTracks(normalized.id),
          offset,
        );
      default:
        return {
          id: folderId,
          name: 'Spotify',
          start: offset,
          totalitems: 0,
          items: [],
        };
    }
  }

  private buildRootFolder(offset: number): ContentFolder {
    return {
      id: 'root',
      name: this.displayLabel,
      service: 'spotify',
      start: offset,
      totalitems: 6,
      items: [
        this.folderLink('playlists', 'Playlists'),
        this.folderLink('albums', 'Albums'),
        this.folderLink('artists', 'Artists'),
        this.folderLink('popular-playlists', 'Popular Playlists'),
        this.folderLink('new-releases', 'New Releases'),
        this.folderLink('genres', 'Genres & Moods'),
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

  private buildFolder(
    id: string,
    name: string,
    result: { items: ContentFolderItem[]; total?: number },
    offset: number,
  ): ContentFolder {
    return {
      id,
      name,
      service: 'spotify',
      start: offset,
      totalitems: typeof result.total === 'number' ? result.total : result.items.length,
      items: result.items,
    };
  }

  private normalizeFolderId(folderId: string):
    | { type: 'root' }
    | { type: 'playlists' }
    | { type: 'albums' }
    | { type: 'artists' }
    | { type: 'popular' }
    | { type: 'new' }
    | { type: 'genres' }
    | { type: 'category'; id: string }
    | { type: 'playlistItem'; id: string }
    | { type: 'albumItem'; id: string }
    | { type: 'artistItem'; id: string }
    | { type: 'unknown' } {
    const raw = this.stripProviderPrefix(folderId || 'root');
    const key = raw.toLowerCase();
    const parts = raw.split(':');
    const tail = parts[parts.length - 1] ?? '';

    if (key === 'root' || key === 'start') {
      return { type: 'root' };
    }
    if (key.startsWith('playlist:')) {
      return { type: 'playlistItem', id: tail };
    }
    if (key.startsWith('album:')) {
      return { type: 'albumItem', id: tail };
    }
    if (key.startsWith('artist:')) {
      return { type: 'artistItem', id: tail };
    }
    if (key.startsWith('category:')) {
      return { type: 'category', id: tail };
    }
    if (key === 'playlist' || key === 'playlists' || key === '3') {
      return { type: 'playlists' };
    }
    if (key === 'album' || key === 'albums' || key === '5') {
      return { type: 'albums' };
    }
    if (key === 'artist' || key === 'artists' || key === '6') {
      return { type: 'artists' };
    }
    if (
      key === 'popular' ||
      key.includes('popular-playlists') ||
      key === '0' ||
      key.includes('recommend') ||
      key.includes('aanbevel')
    ) {
      return { type: 'popular' };
    }
    if (key === 'new' || key.includes('new-releases') || key === '1') {
      return { type: 'new' };
    }
    if (key === 'genres' || key.includes('genres-moods') || key === '2') {
      return { type: 'genres' };
    }
    return { type: 'unknown' };
  }

  private stripProviderPrefix(value: string): string {
    const raw = value || '';
    const lower = raw.toLowerCase();
    const providerLower = this.providerId.toLowerCase();

    const stripDirect = `${providerLower}:`;
    if (lower.startsWith(stripDirect)) {
      return raw.slice(stripDirect.length);
    }

    const stripWithUser = `${providerLower}@`;
    if (lower.startsWith(stripWithUser)) {
      const firstColon = raw.indexOf(':', stripWithUser.length);
      return firstColon >= 0 ? raw.slice(firstColon + 1) : raw.slice(stripWithUser.length);
    }

    const userKey = (this.userKey || '').trim();
    if (userKey) {
      const userLower = userKey.toLowerCase();
      const userPrefix = `${userLower}:`;
      if (lower.startsWith(userPrefix)) {
        return raw.slice(userPrefix.length);
      }

      const userPrefixAt = `${userLower}@`;
      if (lower.startsWith(userPrefixAt)) {
        const firstColon = raw.indexOf(':', userPrefixAt.length);
        return firstColon >= 0 ? raw.slice(firstColon + 1) : raw.slice(userPrefixAt.length);
      }

      if (raw.startsWith('@')) {
        const trimmed = raw.slice(1);
        const trimmedLower = trimmed.toLowerCase();
        if (trimmedLower.startsWith(userPrefix)) {
          return trimmed.slice(userPrefix.length);
        }
        if (trimmedLower.startsWith(userPrefixAt)) {
          const firstColon = trimmed.indexOf(':', userPrefixAt.length);
          return firstColon >= 0
            ? trimmed.slice(firstColon + 1)
            : trimmed.slice(userPrefixAt.length);
        }
        return trimmed;
      }
    }

    return raw;
  }

  private async fetchUserPlaylists(
    offset: number,
    limit: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const data = await this.request<{ items?: any[]; total?: number }>(
      `${SPOTIFY_API_BASE}/me/playlists`,
      {
        params: { offset: String(offset), limit: String(limit || 20) },
      },
    );

    const items = Array.isArray(data?.items) ? data!.items : [];
    return { items: items.map((pl) => this.mapPlaylist(pl)), total: data?.total };
  }

  private async fetchPlaylistTracks(
    playlistId: string,
    offset: number,
    limit: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    if (!playlistId) {
      return { items: [], total: 0 };
    }
    const data = await this.request<{ items?: any[]; total?: number; tracks?: { total?: number } }>(
      `${SPOTIFY_API_BASE}/playlists/${encodeURIComponent(playlistId)}/tracks`,
      {
        params: {
          offset: String(offset),
          limit: String(limit || 50),
        },
      },
    );

    const items = Array.isArray(data?.items) ? data!.items : [];
    const mapped = items.map((entry) => entry?.track).filter(Boolean).map((track) => this.mapTrack(track));
    return { items: mapped, total: data?.total ?? data?.tracks?.total ?? mapped.length };
  }

  private async fetchAlbumTracks(
    albumId: string,
    offset: number,
    limit: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    if (!albumId) {
      return { items: [], total: 0 };
    }

    // Fetch album metadata once so we can enrich track rows with album/cover info.
    const albumMeta = await this.request<{ name?: string; images?: any[] }>(
      `${SPOTIFY_API_BASE}/albums/${encodeURIComponent(albumId)}`,
    );

    const data = await this.request<{ items?: any[]; total?: number }>(
      `${SPOTIFY_API_BASE}/albums/${encodeURIComponent(albumId)}/tracks`,
      {
        params: {
          offset: String(offset),
          limit: String(limit || 50),
        },
      },
    );
    const items = Array.isArray(data?.items) ? data!.items : [];
    const mapped = items.map((track) => this.mapTrack(track, albumMeta || undefined));
    return { items: mapped, total: data?.total ?? mapped.length };
  }

  private async fetchUserAlbums(
    offset: number,
    limit: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const data = await this.request<{ items?: any[]; total?: number }>(
      `${SPOTIFY_API_BASE}/me/albums`,
      {
        params: { offset: String(offset), limit: String(limit || 20) },
      },
    );
    const items = Array.isArray(data?.items) ? data!.items : [];
    const mapped = items
      .map((entry) => entry?.album)
      .filter(Boolean)
      .map((album) => this.mapAlbum(album, true));
    return { items: mapped, total: data?.total ?? mapped.length };
  }

  private async fetchUserArtists(
    limit: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const cappedLimit = Math.min(Math.max(limit || 20, 1), 50);
    const data = await this.request<{ artists?: { items?: any[]; total?: number } }>(
      `${SPOTIFY_API_BASE}/me/following?type=artist&limit=${cappedLimit}`,
    );
    const items = Array.isArray(data?.artists?.items) ? data!.artists!.items : [];
    const mapped = items.map((artist) => this.mapArtist(artist));
    return { items: mapped, total: data?.artists?.total ?? mapped.length };
  }

  private async fetchPopularPlaylists(
    limit: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const params = this.buildBrowseParams(limit);
    const fallbackParams = { ...params };
    delete fallbackParams.country;
    const usParams = { ...params, country: 'US' };

    const attemptOrder: Array<{ url: string; params: Record<string, string> }> = [
      { url: `${SPOTIFY_API_BASE}/browse/categories/toplists/playlists`, params },
      { url: `${SPOTIFY_API_BASE}/browse/categories/toplists/playlists`, params: fallbackParams },
      { url: `${SPOTIFY_API_BASE}/browse/categories/toplists/playlists`, params: usParams },
      { url: `${SPOTIFY_API_BASE}/browse/featured-playlists`, params },
      { url: `${SPOTIFY_API_BASE}/browse/featured-playlists`, params: fallbackParams },
      { url: `${SPOTIFY_API_BASE}/browse/featured-playlists`, params: usParams },
    ];

    for (const { url, params: p } of attemptOrder) {
      const res = await this.request<{ playlists?: { items?: any[]; total?: number } }>(url, {
        params: p,
        suppressWarn: true,
      });
      if (Array.isArray(res?.playlists?.items) && res.playlists.items.length) {
        const unique = this.dedupeById(res.playlists.items);
        return {
          items: unique.map((pl) => this.mapPlaylist(pl)),
          total: res.playlists.total ?? unique.length,
        };
      }
    }

    // Editorial fallback: curated playlists from the official Spotify account.
    const editorial = await this.request<{ items?: any[]; total?: number }>(
      `${SPOTIFY_API_BASE}/users/spotify/playlists`,
      {
        params: { limit: String(limit || 20) },
        suppressWarn: true,
      },
    );
    const editorialItems = this.dedupeById(editorial?.items || []);
    if (editorialItems.length) {
      return { items: editorialItems.map((pl) => this.mapPlaylist(pl)), total: editorial?.total };
    }

    // Fallback to user's own playlists to avoid empty UI.
    const userPlaylists = await this.fetchUserPlaylists(0, limit);
    if (userPlaylists.items.length) {
      return userPlaylists;
    }

    // Curated known global playlists (e.g., Today's Top Hits).
    const curatedIds = ['37i9dQZF1DXcBWIGoYBM5M'];
    const curated: ContentFolderItem[] = [];
    for (const pid of curatedIds) {
      const pl = await this.fetchPlaylistMeta(pid);
      if (pl) curated.push(pl);
      if (curated.length >= limit) break;
    }
    if (curated.length) {
      return { items: curated, total: curated.length };
    }

    return { items: [], total: 0 };
  }

  private async fetchPlaylistMeta(playlistId: string): Promise<ContentFolderItem | null> {
    if (!playlistId) return null;
    const data = await this.request<any>(`${SPOTIFY_API_BASE}/playlists/${encodeURIComponent(playlistId)}`, {
      suppressWarn: true,
      params: { fields: 'id,name,images,owner(display_name,id),tracks.total,is_following' },
    });
    if (!data) return null;
    return this.mapPlaylist(data);
  }

  private dedupeById(items: any[]): any[] {
    const seen = new Set<string>();
    const result: any[] = [];
    for (const item of items) {
      const id = typeof item?.id === 'string' ? item.id : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push(item);
    }
    return result;
  }

  private async fetchNewReleases(
    limit: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const data = await this.request<{ albums?: { items?: any[]; total?: number } }>(
      `${SPOTIFY_API_BASE}/browse/new-releases`,
      { params: this.buildBrowseParams(limit) },
    );
    const items = Array.isArray(data?.albums?.items) ? data!.albums!.items : [];
    return { items: items.map((album) => this.mapAlbum(album)), total: data?.albums?.total };
  }

  private async fetchBrowseCategories(
    offset: number,
    limit: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const params = this.buildBrowseParams(limit, offset);
    const fallbackParams = { ...params };
    delete fallbackParams.country;
    const usParams = { ...params, country: 'US' };

    const attemptOrder: Array<{
      params: Record<string, string>;
      suppressWarn?: boolean;
    }> = [
      { params },
      { params: fallbackParams, suppressWarn: true },
      { params: usParams, suppressWarn: true },
    ];

    for (const attempt of attemptOrder) {
      const data = await this.request<{ categories?: { items?: any[]; total?: number } }>(
        `${SPOTIFY_API_BASE}/browse/categories`,
        { params: attempt.params, suppressWarn: attempt.suppressWarn },
      );
      const items = Array.isArray(data?.categories?.items) ? data!.categories!.items : [];
      if (items.length) {
        return {
          items: items.map((category) => this.mapCategory(category)),
          total: data?.categories?.total,
        };
      }
    }

    // Last-resort fallback: use genre seeds if browse categories are unavailable.
    const seeds = await this.request<{ genres?: string[] }>(
      `${SPOTIFY_API_BASE}/recommendations/available-genre-seeds`,
      { suppressWarn: true },
    );
    const seedItems = Array.isArray(seeds?.genres)
      ? seeds!.genres!.map((name) => ({ id: name, name }))
      : [];
    if (seedItems.length) {
      this.log.debug('spotify categories fallback to genre seeds', { count: seedItems.length });
      return {
        items: seedItems.map((entry) => this.mapCategory(entry)),
        total: seedItems.length,
      };
    }

    this.log.warn('spotify categories unavailable after fallbacks');
    return { items: [], total: 0 };
  }

  private async fetchCategoryPlaylists(
    categoryId: string,
    offset: number,
    limit: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    if (!categoryId) {
      return { items: [], total: 0 };
    }
    const params = this.buildBrowseParams(limit, offset);
    const fallbackParams = { ...params };
    delete fallbackParams.country;
    const usParams = { ...params, country: 'US' };

    const attemptOrder: Array<{
      params: Record<string, string>;
      suppressWarn?: boolean;
    }> = [
      { params },
      { params: fallbackParams, suppressWarn: true },
      { params: usParams, suppressWarn: true },
    ];

    const data = await this.request<{ playlists?: { items?: any[]; total?: number } }>(
      `${SPOTIFY_API_BASE}/browse/categories/${encodeURIComponent(categoryId)}/playlists`,
      { params, suppressWarn: true },
    );
    const primaryItems = Array.isArray(data?.playlists?.items) ? data!.playlists!.items : [];
    if (primaryItems.length) {
      return { items: primaryItems.map((pl) => this.mapPlaylist(pl)), total: data?.playlists?.total };
    }

    for (const attempt of attemptOrder) {
      const fallback = await this.request<{ playlists?: { items?: any[]; total?: number } }>(
        `${SPOTIFY_API_BASE}/browse/categories/${encodeURIComponent(categoryId)}/playlists`,
        { params: attempt.params, suppressWarn: true },
      );
      const items = Array.isArray(fallback?.playlists?.items) ? fallback.playlists!.items : [];
      if (items.length) {
        return { items: items.map((pl) => this.mapPlaylist(pl)), total: fallback?.playlists?.total };
      }
    }

    this.log.warn('spotify category playlists unavailable after fallbacks', { categoryId });
    return { items: [], total: 0 };
  }

  private async fetchArtistTopTracks(
    artistId: string,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    if (!artistId) {
      return { items: [], total: 0 };
    }
    const data = await this.request<{ tracks?: any[] }>(
      `${SPOTIFY_API_BASE}/artists/${encodeURIComponent(artistId)}/top-tracks`,
      {
        params: { market: 'from_token' },
      },
    );
    const items = Array.isArray(data?.tracks) ? data!.tracks : [];
    const mapped = items.map((track) => this.mapTrack(track));
    return { items: mapped, total: mapped.length };
  }

  /**
   * Build common browse params with clamped limits and optional country.
   */
  private buildBrowseParams(limit: number, offset?: number): Record<string, string> {
    const params: Record<string, string> = {};
    const safeLimit = Math.min(Math.max(limit || 20, 1), 50);
    params.limit = String(safeLimit);
    if (typeof offset === 'number') {
      params.offset = String(Math.max(0, offset));
    }
    const country = this.account.country?.trim();
    if (country) {
      params.country = country.toUpperCase();
    }
    return params;
  }

  private mapPlaylist(playlist: any): ContentFolderItem {
    const id = String(playlist?.id ?? '');
    const cover = this.extractImage(playlist?.images);
    return {
      id: this.makeUri('playlist', id),
      name: String(playlist?.name ?? 'Playlist'),
      title: String(playlist?.name ?? 'Playlist'),
      type: 12,
      items: Number(playlist?.tracks?.total ?? 0),
      coverurl: cover,
      thumbnail: this.extractImage(playlist?.images, 1) ?? cover,
      audiopath: this.makeUri('playlist', id),
      owner: playlist?.owner?.display_name ?? playlist?.owner?.id ?? '',
      tag: 'playlist',
      followed: Boolean(playlist?.is_following),
    };
  }

  private mapAlbum(album: any, followed = false): ContentFolderItem {
    const id = String(album?.id ?? '');
    const cover = this.extractImage(album?.images);
    const owner =
      Array.isArray(album?.artists) && album.artists.length > 0
        ? album.artists.map((a: any) => a?.name).filter(Boolean).join(', ')
        : '';
    return {
      id: this.makeUri('album', id),
      name: String(album?.name ?? 'Album'),
      title: String(album?.name ?? 'Album'),
      type: 12,
      items: Number(album?.total_tracks ?? 0),
      coverurl: cover,
      thumbnail: this.extractImage(album?.images, 1) ?? cover,
      audiopath: this.makeUri('album', id),
      owner,
      tag: 'album',
      followed,
    };
  }

  private mapArtist(artist: any): ContentFolderItem {
    const id = String(artist?.id ?? '');
    const cover = this.extractImage(artist?.images);
    return {
      id: this.makeUri('artist', id),
      name: String(artist?.name ?? 'Artist'),
      title: String(artist?.name ?? 'Artist'),
      type: 12,
      coverurl: cover,
      thumbnail: this.extractImage(artist?.images, 1) ?? cover,
      audiopath: this.makeUri('artist', id),
      tag: 'artist',
    };
  }

  private mapCategory(category: any): ContentFolderItem {
    const id = String(category?.id ?? '');
    const icons = category?.icons;
    const cover = this.extractImage(icons);
    return {
      id: this.makeUri('category', id),
      name: String(category?.name ?? 'Category'),
      title: String(category?.name ?? 'Category'),
      type: 12,
      coverurl: cover,
      thumbnail: this.extractImage(icons, 1) ?? cover,
      tag: 'category',
    };
  }

  private mapTrack(track: any, albumContext?: { name?: string; images?: any[] }): ContentFolderItem {
    const id = String(track?.id ?? track?.uri ?? '');
    const artists = Array.isArray(track?.artists)
      ? track.artists
        .map((a: any) => (typeof a?.name === 'string' ? a.name : ''))
        .filter(Boolean)
        .join(', ')
      : '';
    const album = albumContext?.name ?? track?.album?.name ?? '';
    const coverImages = albumContext?.images ?? track?.album?.images;
    const cover = this.extractImage(coverImages);
    const durationSec = Number.isFinite(track?.duration_ms)
      ? Math.max(1, Math.round(Number(track.duration_ms) / 1000))
      : 120;

    return {
      id: this.makeUri('track', id),
      name: String(track?.name ?? 'Track'),
      title: String(track?.name ?? 'Track'),
      type: FileType.File,
      coverurl: cover,
      thumbnail: this.extractImage(coverImages, 1) ?? cover,
      audiopath: this.makeUri('track', id),
      artist: artists,
      album,
      duration: durationSec,
      tag: 'track',
    } as ContentFolderItem;
  }

  private extractImage(images: any, index = 0): string | undefined {
    if (!images) {
      return undefined;
    }
    if (Array.isArray(images) && images.length > 0) {
      const entry = images[Math.min(index, images.length - 1)];
      if (typeof entry?.url === 'string') {
        return entry.url;
      }
    }
    return undefined;
  }

  private async request<T>(
    url: string,
    options?: { params?: Record<string, string>; method?: string; body?: any; suppressWarn?: boolean },
  ): Promise<T | null> {
    const token = await this.getAccessToken();
    if (!token) {
      this.authError = true;
      this.log.warn('spotify api request skipped, no access token', { url });
      return null;
    }

    const apiUrl = new URL(url);
    if (options?.params) {
      for (const [key, value] of Object.entries(options.params)) {
        apiUrl.searchParams.set(key, value);
      }
    }

    const response = await this.rawRequest<T>(apiUrl.toString(), {
      method: options?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      body: options?.body,
    });

    if (!response.ok) {
      // Retry once on auth errors with a fresh token.
      if (response.status === 401 || response.status === 403) {
        this.authError = true;
        const retryToken = await this.getAccessToken();
        if (retryToken && retryToken !== token) {
          const retryResponse = await this.rawRequest<T>(apiUrl.toString(), {
            method: options?.method ?? 'GET',
            headers: {
              Authorization: `Bearer ${retryToken}`,
              Accept: 'application/json',
            },
            body: options?.body,
          });
          if (retryResponse.ok) {
            this.authError = false;
            return retryResponse.body;
          }
        }
      }
      const logFn = options?.suppressWarn ? this.log.debug.bind(this.log) : this.log.warn.bind(this.log);
      logFn('spotify api request failed', {
        url: apiUrl.toString(),
        status: response.status,
        body: response.body,
      });
      return null;
    }

    return response.body;
  }

  private mapConnectDevice(entry: any): SpotifyConnectDevice | null {
    if (!entry || typeof entry.id !== 'string' || !entry.id.trim()) {
      return null;
    }
    const id = entry.id.trim();
    const name =
      (typeof entry.name === 'string' && entry.name.trim()) || id;
    return {
      id,
      name,
      type: typeof entry.type === 'string' ? entry.type : undefined,
      isActive: entry.is_active === true,
      isPrivateSession: entry.is_private_session === true,
      isRestricted: entry.is_restricted === true,
      supportsVolume: entry.supports_volume === true,
      volumePercent:
        typeof entry.volume_percent === 'number' ? entry.volume_percent : undefined,
    };
  }

  private async rawRequest<T>(url: string, init: RequestInit): Promise<SpotifyApiResult<T>> {
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        const text = await safeReadText(res, '', {
          onError: 'debug',
          log: this.log,
          label: 'spotify account api read failed',
          context: { status: res.status },
        });
        return {
          ok: false,
          status: res.status,
          body: text as unknown as T | null,
        };
      }
      const data = (await res.json()) as T;
      return {
        ok: true,
        status: res.status,
        body: data,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('spotify api error', { url, message });
      return {
        ok: false,
        status: 0,
        body: null,
      };
    }
  }

  private async getAccessToken(): Promise<string | null> {
    const hasValid = this.accessToken && Date.now() < this.tokenExpiresAt - 5_000;
    if (hasValid) {
      return this.accessToken!;
    }

    const refreshToken =
      this.account.refreshToken?.trim() ||
      (this.account as any).refresh_token?.toString().trim();
    if (!refreshToken) {
      this.log.warn('no refresh token configured for spotify account');
      return null;
    }

    // Prevent multiple concurrent refresh attempts with the same token.
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.refreshAccessToken(refreshToken);
    const token = await this.refreshPromise;
    this.refreshPromise = null;
    return token;
  }

  /**
   * Public accessor for callers that need a Spotify access token (e.g. outputs).
   */
  public async fetchAccessToken(forceRefresh = false): Promise<string | null> {
    if (forceRefresh) {
      this.accessToken = '';
      this.tokenExpiresAt = 0;
    }
    return this.getAccessToken();
  }

  private async refreshAccessToken(refreshToken: string): Promise<string | null> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.clientId,
    });

    const maxAttempts = 3;
    let delayMs = 500;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const res = await fetch('https://accounts.spotify.com/api/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });

        if (!res.ok) {
          const text = await safeReadText(res, '', {
            onError: 'debug',
            log: this.log,
            label: 'spotify account api refresh read failed',
            context: { status: res.status },
          });
          this.log.warn('spotify token refresh failed', {
            status: res.status,
            body: text.slice(0, 200),
            attempt,
          });
          if (attempt < maxAttempts && res.status >= 500) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            delayMs *= 2;
            continue;
          }
          break;
        }

        const payload = (await res.json()) as any;
        const accessToken = typeof payload?.access_token === 'string' ? payload.access_token : '';
        const expiresIn = Number(payload?.expires_in ?? 3600);
        const rotatedRefreshToken =
          typeof payload?.refresh_token === 'string' ? payload.refresh_token : '';
        const scope = typeof payload?.scope === 'string' ? payload.scope : '';

        if (!accessToken) {
          this.log.warn('spotify token refresh response missing access_token');
          break;
        }

        this.accessToken = accessToken;
        this.tokenExpiresAt = Date.now() + expiresIn * 1000;
        this.authError = false;
        if (scope) {
          this.log.debug('spotify token refreshed', { scope });
        }

        if (rotatedRefreshToken && rotatedRefreshToken !== refreshToken) {
          await this.persistAccountPatch({ refreshToken: rotatedRefreshToken });
        }

        return accessToken;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn('spotify token refresh error', { message, attempt });
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          delayMs *= 2;
          continue;
        }
      }
    }

    // If we reach here, refresh failed. Re-use a recently valid token if we still have one.
    if (this.accessToken && Date.now() < this.tokenExpiresAt + 60_000) {
      this.log.warn('spotify refresh failed; reusing last access token temporarily', {
        expiresInMs: this.tokenExpiresAt - Date.now(),
      });
      return this.accessToken;
    }

    this.authError = true;
    return null;
  }

  private async persistAccountPatch(patch: Partial<SpotifyAccountConfig>): Promise<void> {
    const updated = await this.persistAccountState(this.account.id, patch);
    if (updated) {
      this.account = { ...this.account, ...updated } as SpotifyAccountState;
    } else {
      this.account = { ...this.account, ...patch } as SpotifyAccountState;
    }
  }
}
