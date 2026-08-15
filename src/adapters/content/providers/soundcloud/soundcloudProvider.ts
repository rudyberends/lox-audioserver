import type { ContentFolder, ContentFolderItem, ContentServiceAccount, PlaylistEntry } from '@/ports/ContentTypes';
import { DEFAULT_MIN_SEARCH_LIMIT } from '@/adapters/content/utils/searchLimits';
import { estimatedPage } from '@/adapters/content/folderPage';
import {
  SoundCloudClient,
  type SoundCloudCollection,
  type SoundCloudPlaylist,
  type SoundCloudTrack,
  type SoundCloudUser,
} from '@/adapters/content/providers/soundcloud/soundcloudClient';
import {
  FileType,
  mapArtist,
  mapPlaylist,
  mapTrack,
} from '@/adapters/content/providers/soundcloud/soundcloudParsers';
import type { ContentProvider, ProviderSearchCategories, ProviderSearchResult } from '@/adapters/content/ContentProvider';

const SEARCH_DURATION_TOLERANCE_MS = 1000;

interface SoundCloudProviderOptions {
  providerId: string;
  serviceNativePrefix?: string;
  label?: string;
  oauthToken?: string;
  clientId?: string;
}

/**
 * SoundCloud catalog provider. Browsing/search/charts work without credentials
 * against the public `api-v2`; an OAuth token additionally surfaces the user's
 * likes and playlists. Mirrors the Deezer/Tidal bridge-provider facade so the
 * SpotifyServiceManager can drive it uniformly.
 */
export class SoundCloudProvider implements ContentProvider {
  public readonly providerId: string;
  private readonly audiopathPrefix: string;
  private readonly label: string;
  private readonly client: SoundCloudClient;
  private readonly hasToken: boolean;

  constructor(options: SoundCloudProviderOptions) {
    this.providerId = options.providerId;
    this.audiopathPrefix = options.serviceNativePrefix ?? options.providerId;
    this.label = options.label || 'SoundCloud';
    this.client = new SoundCloudClient({
      oauthToken: options.oauthToken,
      clientId: options.clientId,
    });
    this.hasToken = this.client.hasOauthToken();
  }

  public get accountId(): string {
    return 'soundcloud';
  }

  public get displayLabel(): string {
    return this.label;
  }

  public getServiceAccount(): ContentServiceAccount {
    return {
      id: this.providerId,
      label: this.displayLabel,
      provider: 'soundcloud',
      fake: true,
    };
  }

  public async fetchAccessToken(): Promise<string | null> {
    // The client_id doubles as the "access token" the manager probes for; a
    // resolvable id means the provider is usable.
    return this.client.getClientId();
  }

  public async getPlaylists(_offset: number, _limit: number): Promise<PlaylistEntry[]> {
    // SoundCloud playlists are enumerated through getFolder ("Your Playlists");
    // the legacy PlaylistEntry list is not used for this provider.
    return [];
  }

  public async getFolder(folderId: string, offset: number, limit: number): Promise<ContentFolder | null> {
    const normalized = this.normalizeFolderId(folderId);
    const pageLimit = limit || 50;
    switch (normalized.type) {
      case 'root':
        return this.buildRootFolder(offset);
      case 'trending':
        return this.buildFolder(folderId, 'Trending', await this.fetchCharts('trending', pageLimit, offset), offset, pageLimit);
      case 'top':
        return this.buildFolder(folderId, 'Top 50', await this.fetchCharts('top', pageLimit, offset), offset, pageLimit);
      case 'likes':
        return this.buildFolder(folderId, 'Your Likes', await this.fetchLikes(pageLimit, offset), offset, pageLimit);
      case 'playlists':
        return this.buildFolder(folderId, 'Your Playlists', await this.fetchUserPlaylists(pageLimit, offset), offset, pageLimit);
      case 'playlistItem':
        return this.buildFolder(folderId, 'Playlist', await this.fetchPlaylistTracks(normalized.id, pageLimit, offset), offset, pageLimit);
      case 'artistItem':
        return this.buildFolder(folderId, 'Artist', await this.fetchArtistTracks(normalized.id, pageLimit, offset), offset, pageLimit);
      default:
        return {
          id: folderId,
          name: this.displayLabel,
          service: 'soundcloud',
          start: offset,
          totalitems: 0,
          items: [],
        };
    }
  }

  public async getTrack(trackId: string): Promise<ContentFolderItem | null> {
    const id = this.extractId(trackId, 'track');
    if (!id) {
      return null;
    }
    const track = await this.client.apiGet<SoundCloudTrack>(`/tracks/${encodeURIComponent(id)}`);
    if (!track?.id) {
      return null;
    }
    return mapTrack(this.audiopathPrefix, track);
  }

  public async search(
    query: string,
    limits: Record<string, number>,
    maxLimit: number,
  ): Promise<ProviderSearchResult> {
    const limit = Math.min(
      Math.max(...(Object.values(limits).length ? Object.values(limits) : [maxLimit]), DEFAULT_MIN_SEARCH_LIMIT),
      maxLimit,
    );
    const requestedTypes = Object.keys(limits);
    const activeTypes = requestedTypes.length > 0 ? new Set(requestedTypes) : new Set(['track', 'artist', 'playlist']);
    const result: ProviderSearchCategories = {};
    const tasks: Array<Promise<void>> = [];

    if (activeTypes.has('track')) {
      tasks.push(
        this.searchTracks(query, limits.track ?? limit)
          .then((tracks) => {
            result.tracks = tracks;
          })
          .catch(() => {
            result.tracks = [];
          }),
      );
    }
    if (activeTypes.has('artist')) {
      tasks.push(
        this.client
          .apiGet<SoundCloudCollection<SoundCloudUser>>('/search/users', { q: query, limit: limits.artist ?? limit })
          .then((data) => {
            result.artists = (data?.collection ?? []).filter((u) => u?.id).map((u) => mapArtist(this.audiopathPrefix, u));
          })
          .catch(() => {
            result.artists = [];
          }),
      );
    }
    if (activeTypes.has('playlist')) {
      tasks.push(
        this.client
          .apiGet<SoundCloudCollection<SoundCloudPlaylist>>('/search/playlists', { q: query, limit: limits.playlist ?? limit })
          .then((data) => {
            result.playlists = (data?.collection ?? []).filter((p) => p?.id).map((p) => mapPlaylist(this.audiopathPrefix, p));
          })
          .catch(() => {
            result.playlists = [];
          }),
      );
    }

    await Promise.all(tasks);
    return { result, providerId: this.providerId, user: this.providerId.split('@')[1] || this.providerId };
  }

  public dispose(): void {
    /* nothing to clean up */
  }

  /* ------------------------------------------------------------------------ */
  /* Fetch helpers                                                            */
  /* ------------------------------------------------------------------------ */

  private async searchTracks(query: string, limit: number): Promise<ContentFolderItem[]> {
    const data = await this.client.apiGet<SoundCloudCollection<SoundCloudTrack>>('/search/tracks', { q: query, limit });
    const tracks: ContentFolderItem[] = [];
    for (const item of data?.collection ?? []) {
      if (!item?.id) {
        continue;
      }
      // Skip preview/snippet tracks (free-account teasers) whose playable window
      // is far shorter than the real track — mirrors the MA reference filter.
      const duration = item.duration ?? 0;
      const fullDuration = item.full_duration ?? duration;
      if (Math.abs(duration - fullDuration) >= SEARCH_DURATION_TOLERANCE_MS) {
        continue;
      }
      tracks.push(mapTrack(this.audiopathPrefix, item));
    }
    return tracks;
  }

  private async fetchCharts(kind: 'trending' | 'top', limit: number, offset: number): Promise<ContentFolderItem[]> {
    const chartType = kind === 'top' ? 'top' : 'trending';
    const data = await this.client.apiGet<SoundCloudCollection<{ track?: SoundCloudTrack }>>('/charts', {
      kind: chartType,
      genre: 'soundcloud:genres:all-music',
      limit,
      offset,
    });
    const tracks: ContentFolderItem[] = [];
    for (const entry of data?.collection ?? []) {
      const track = entry?.track;
      if (track?.id) {
        tracks.push(mapTrack(this.audiopathPrefix, track));
      }
    }
    return tracks;
  }

  private async fetchLikes(limit: number, offset: number): Promise<ContentFolderItem[]> {
    if (!this.hasToken) {
      return [];
    }
    const userId = await this.resolveUserId();
    if (!userId) {
      return [];
    }
    const data = await this.client.apiGet<SoundCloudCollection<{ track?: SoundCloudTrack }>>(
      `/users/${encodeURIComponent(userId)}/track_likes`,
      { limit, offset },
    );
    const tracks: ContentFolderItem[] = [];
    for (const entry of data?.collection ?? []) {
      const track = entry?.track;
      if (track?.id) {
        tracks.push(mapTrack(this.audiopathPrefix, track));
      }
    }
    return tracks;
  }

  private async fetchUserPlaylists(limit: number, offset: number): Promise<ContentFolderItem[]> {
    if (!this.hasToken) {
      return [];
    }
    const userId = await this.resolveUserId();
    if (!userId) {
      return [];
    }
    const byId = new Map<number, SoundCloudPlaylist>();
    // Playlists the user created themselves.
    const own = await this.client.apiGet<SoundCloudCollection<SoundCloudPlaylist>>(
      `/users/${encodeURIComponent(userId)}/playlists`,
      { limit, offset },
    );
    for (const p of own?.collection ?? []) {
      if (p?.id) {
        byId.set(p.id, p);
      }
    }
    // Playlists/albums the user saved or follows. The web player shows these
    // under the library; /users/{id}/playlists only returns self-authored ones.
    const library = await this.client.apiGet<SoundCloudCollection<{ type?: string; playlist?: SoundCloudPlaylist }>>(
      '/me/library/all',
      { limit, offset },
    );
    for (const entry of library?.collection ?? []) {
      // Keep real playlist/album entries (type contains "playlist"); skip the
      // system "user"-kind rows that carry no playable playlist.
      const playlist = entry?.playlist;
      if (playlist?.id && (entry.type ?? '').includes('playlist') && playlist.kind === 'playlist') {
        byId.set(playlist.id, playlist);
      }
    }
    return [...byId.values()].map((p) => mapPlaylist(this.audiopathPrefix, p));
  }

  private async fetchPlaylistTracks(playlistId: string, limit: number, offset: number): Promise<ContentFolderItem[]> {
    const playlist = await this.client.apiGet<SoundCloudPlaylist>(`/playlists/${encodeURIComponent(playlistId)}`);
    const raw = playlist?.tracks ?? [];
    const page = raw.slice(offset, offset + limit);
    const tracks: ContentFolderItem[] = [];
    for (const item of page) {
      // Playlist entries may be stubs (id only); hydrate those on demand.
      if (item?.title) {
        tracks.push(mapTrack(this.audiopathPrefix, item));
      } else if (item?.id) {
        const full = await this.client.apiGet<SoundCloudTrack>(`/tracks/${encodeURIComponent(String(item.id))}`);
        if (full?.id) {
          tracks.push(mapTrack(this.audiopathPrefix, full));
        }
      }
    }
    return tracks;
  }

  private async fetchArtistTracks(artistId: string, limit: number, offset: number): Promise<ContentFolderItem[]> {
    const data = await this.client.apiGet<SoundCloudCollection<SoundCloudTrack>>(
      `/users/${encodeURIComponent(artistId)}/tracks`,
      { limit, offset },
    );
    return (data?.collection ?? []).filter((t) => t?.id).map((t) => mapTrack(this.audiopathPrefix, t));
  }

  private cachedUserId: string | null = null;

  private async resolveUserId(): Promise<string | null> {
    if (this.cachedUserId) {
      return this.cachedUserId;
    }
    const me = await this.client.apiGet<SoundCloudUser>('/me');
    if (me?.id) {
      this.cachedUserId = String(me.id);
      return this.cachedUserId;
    }
    return null;
  }

  /* ------------------------------------------------------------------------ */
  /* Folder shaping + id parsing                                              */
  /* ------------------------------------------------------------------------ */

  // The sections this account publishes, each addressed by its own keyword. Which
  // slot of the Loxone app's fixed section list a keyword fills is that app's
  // business, and lives in its adapter (`loxoneServiceFolders`).
  private static readonly ROOT_SECTIONS: ReadonlyArray<{
    keyword: 'trending' | 'top' | 'likes' | 'playlists';
    name: string;
    requiresToken: boolean;
  }> = [
    { keyword: 'trending', name: 'Trending', requiresToken: false },
    { keyword: 'top', name: 'Top 50', requiresToken: false },
    { keyword: 'playlists', name: 'Your Playlists', requiresToken: true },
    { keyword: 'likes', name: 'Your Likes', requiresToken: true },
  ];

  private buildRootFolder(offset: number): ContentFolder {
    const items = SoundCloudProvider.ROOT_SECTIONS.filter(
      (section) => !section.requiresToken || this.hasToken,
    ).map((section) => this.folderLink(section.keyword, section.name));
    return {
      id: 'root',
      name: this.displayLabel,
      service: 'soundcloud',
      start: offset,
      totalitems: items.length,
      items,
    };
  }

  /**
   * A page of a SoundCloud folder.
   *
   * SoundCloud pages by offset and never reports a collection size, so the total is an
   * estimate. It used to be expressed as a phantom `+1` item, which read to a consumer as a
   * real count that was always one too many; `estimatedPage` says so instead.
   */
  private buildFolder(
    folderId: string,
    name: string,
    items: ContentFolderItem[],
    offset: number,
    limit: number,
  ): ContentFolder {
    return estimatedPage({ id: folderId, name, service: 'soundcloud', start: offset, items }, limit);
  }

  private folderLink(id: string, name: string): ContentFolderItem {
    return {
      id,
      name,
      type: FileType.Folder,
      items: 0,
    };
  }

  private normalizeFolderId(
    folderId: string,
  ):
    | { type: 'root' }
    | { type: 'trending' }
    | { type: 'top' }
    | { type: 'likes' }
    | { type: 'playlists' }
    | { type: 'playlistItem'; id: string }
    | { type: 'artistItem'; id: string }
    | { type: 'unknown' } {
    const raw = this.stripProviderPrefix(folderId || 'root').trim();
    const lower = raw.toLowerCase();
    if (lower === 'root' || lower === 'start' || lower === '') {
      return { type: 'root' };
    }
    const section = SoundCloudProvider.ROOT_SECTIONS.find((s) => s.keyword === lower);
    if (section) {
      return { type: section.keyword };
    }
    const playlistMatch = raw.match(/(?:^|:)playlist:(.+)$/i);
    if (playlistMatch) {
      return { type: 'playlistItem', id: playlistMatch[1] ?? '' };
    }
    const artistMatch = raw.match(/(?:^|:)artist:(.+)$/i);
    if (artistMatch) {
      return { type: 'artistItem', id: artistMatch[1] ?? '' };
    }
    return { type: 'unknown' };
  }

  private extractId(value: string, kind: 'track' | 'artist' | 'playlist'): string {
    const raw = this.stripProviderPrefix(value || '').trim();
    const match = raw.match(new RegExp(`(?:^|:)${kind}:(.+)$`, 'i'));
    return (match ? (match[1] ?? raw) : raw).trim();
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
}
