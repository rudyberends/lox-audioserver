import type { ContentFolder, ContentFolderItem, ContentServiceAccount, PlaylistEntry } from '@/ports/ContentTypes';
import { SpotifyAccountProvider, type SpotifyAccountState, type SpotifyAccountProviderOptions } from '@/adapters/content/providers/spotify/spotifyAccountProvider';
import { MusicAssistantApi } from '@/shared/musicassistant/musicAssistantApi';
import { createLogger } from '@/shared/logging/logger';
import { bestEffort } from '@/shared/bestEffort';
import { DEFAULT_MIN_SEARCH_LIMIT } from '@/adapters/content/utils/searchLimits';

const enum FileType {
  Folder = 1,
  File = 2,
  PlaylistBrowsable = 7,
}

interface MusicAssistantBridgeOptions {
  providerId: string;
  label?: string;
  host?: string;
  port?: number;
  apiKey?: string;
  accountId?: string;
}

type FolderKind =
  | 'root'
  | 'playlists'
  | 'albums'
  | 'artists'
  | 'radios'
  | 'recommendationRoot'
  | { type: 'playlistItem'; id: string }
  | { type: 'albumItem'; id: string }
  | { type: 'artistItem'; id: string }
  | { type: 'recommendation'; id: string }
  | { type: 'unknown' };

/**
 * Fake Spotify provider that proxies content from Music Assistant.
 */
export class MusicAssistantBridgeProvider extends SpotifyAccountProvider {
  private readonly api: MusicAssistantApi;
  private readonly label: string;
  private readonly providerType = 'musicassistant';
  private readonly maLog = createLogger('Content', 'MusicAssistantBridge');
  private readonly recommendationPlan: Array<{ alias: string; id: string }> = [
    { alias: '0', id: 'random_artists' },
    { alias: '1', id: 'random_albums' },
    { alias: '2', id: 'recently_added_tracks' },
    { alias: '3', id: 'recently_added_tracks' },
    { alias: '4', id: 'recently_added_albums' },
  ];
  private recommendationAliases = new Map<string, string>();

  constructor(options: MusicAssistantBridgeOptions) {
    const account: SpotifyAccountState = {
      id: options.accountId || 'musicassistant',
    } as SpotifyAccountState;
    const providerOptions: SpotifyAccountProviderOptions = {
      providerId: options.providerId,
      account,
      clientId: '',
      // Music Assistant does not need Spotify persistence; stub out.
      persistAccount: async () => account,
    };
    super(providerOptions);
    this.label = options.label || 'Music Assistant';
    this.api = MusicAssistantApi.acquire(options.host || '127.0.0.1', options.port ?? 8095, options.apiKey);
  }

  public override get displayLabel(): string {
    return this.label;
  }

  public override getServiceAccount(): ContentServiceAccount {
    return {
      id: this.providerId,
      label: this.displayLabel,
      provider: this.providerType,
      fake: true,
    };
  }

  public override async fetchAccessToken(): Promise<string | null> {
    // Not required for Music Assistant.
    return null;
  }

  public override async getPlaylists(offset: number, limit: number): Promise<PlaylistEntry[]> {
    const res = await this.api.getLibraryPlaylists(limit, offset);
    return (res.items || []).map((pl: any) => {
      const id = this.extractMaId(pl);
      const uri = this.makeMaUri('playlist', id);
      return {
        id,
        name: pl.name ?? pl.title ?? 'Playlist',
        tracks: Array.isArray(pl.tracks) ? pl.tracks.length : pl.items ?? 0,
        audiopath: uri,
        coverurl: this.extractMaCover(pl),
      };
    });
  }

  public override async getFolder(folderId: string, offset: number, limit: number): Promise<ContentFolder | null> {
    const normalized = this.normalizeMaFolderId(folderId);

    switch (normalized) {
      case 'root':
        return this.buildMaRootFolder(offset);
      case 'playlists':
        return this.buildMaFolder(
          'playlists',
          'Playlists',
          await this.api.getLibraryPlaylists(limit || 50, offset),
          offset,
          (item) => this.mapMaPlaylist(item),
        );
      case 'albums':
        return this.buildMaFolder(
          'albums',
          'Albums',
          await this.api.getLibraryAlbums(limit || 50, offset),
          offset,
          (item) => this.mapMaAlbum(item),
        );
      case 'artists':
        return this.buildMaFolder(
          'artists',
          'Artists',
          await this.api.getLibraryArtists(limit || 50, offset),
          offset,
          (item) => this.mapMaArtist(item),
        );
      case 'radios':
        return this.buildMaFolder(
          'radios',
          'Radio',
          await this.api.getLibraryRadios(limit || 50, offset),
          offset,
          (item) => this.mapMaRadio(item),
        );
      case 'recommendationRoot': {
        const recs = await this.api.getRecommendations();
        const items = (recs || [])
          .map((rec: any) => this.mapMaRecommendationGroup(rec))
          .filter(Boolean) as ContentFolderItem[];
        return {
          id: 'recommendations',
          name: 'Recommendations',
          service: this.providerType,
          start: offset,
          totalitems: items.length,
          items,
        };
      }
      default:
        break;
    }

    if (typeof normalized === 'object') {
      if (normalized.type === 'recommendation') {
        return this.buildRecommendationFolder(normalized.id, offset, limit || 50);
      }
      if (normalized.type === 'playlistItem') {
        const { provider, id } = this.parseMaUri(normalized.id, 'library');
        const tracks = await this.api.getPlaylistTracks(id, provider);
        return this.buildMaFolder(normalized.id, 'Playlist', { items: tracks, total: tracks.length }, offset, (t) =>
          this.mapMaTrack(t),
        );
      }
      if (normalized.type === 'albumItem') {
        const { provider, id } = this.parseMaUri(normalized.id, 'library');
        const tracks = await this.api.getAlbumTracks(id, provider, offset, limit || 50);
        return this.buildMaFolder(normalized.id, 'Album', { items: tracks, total: tracks.length }, offset, (t) =>
          this.mapMaTrack(t),
        );
      }
      if (normalized.type === 'artistItem') {
        const { provider, id } = this.parseMaUri(normalized.id, 'library');
        const tracks = await this.api.getArtistTracks(id, provider, offset, limit || 50);
        return this.buildMaFolder(normalized.id, 'Artist', { items: tracks, total: tracks.length }, offset, (t) =>
          this.mapMaTrack(t),
        );
      }
    }

    return {
      id: folderId,
      name: this.displayLabel,
      start: offset,
      totalitems: 0,
      items: [],
    };
  }

  public override async getTrack(trackId: string): Promise<ContentFolderItem | null> {
    const decoded = this.decodeMaId(trackId);
    const { provider, id } = this.parseMaUri(decoded, 'library');
    const data = await this.api.getTrack(id, provider);
    if (!data) return null;
    return this.mapMaTrack(data);
  }

  public async search(
    query: string,
    limits: Record<string, number>,
    maxLimit: number,
  ): Promise<{ result: Record<string, ContentFolderItem[]>; providerId: string; user: string }> {
    const limit = Math.min(
      Math.max(...(Object.values(limits).length ? Object.values(limits) : [maxLimit]), DEFAULT_MIN_SEARCH_LIMIT),
      maxLimit,
    );
    const raw = await this.api.search(query, limit);
    const result: Record<string, ContentFolderItem[]> = {};

    const mapLimited = <T>(list: T[] | undefined, mapper: (item: T) => ContentFolderItem | null, cap: number) =>
      (Array.isArray(list) ? list : [])
        .slice(0, cap)
        .map(mapper)
        .filter(Boolean) as ContentFolderItem[];

    if (raw.tracks) {
      result.tracks = mapLimited(raw.tracks, (t) => this.mapMaTrack(t as any), limits.track ?? limit);
    }
    if (raw.albums) {
      result.albums = mapLimited(raw.albums, (a) => this.mapMaAlbum(a as any), limits.album ?? limit);
    }
    if (raw.artists) {
      result.artists = mapLimited(raw.artists, (a) => this.mapMaArtist(a as any), limits.artist ?? limit);
    }
    if (raw.playlists) {
      result.playlists = mapLimited(raw.playlists, (p) => this.mapMaPlaylist(p as any), limits.playlist ?? limit);
    }

    return { result, providerId: this.providerId, user: this.accountId };
  }

  public dispose(): void {
    this.api.release();
  }

  /* ---------------------------------------------------------------------- */
  /* Mapping helpers                                                        */
  /* ---------------------------------------------------------------------- */

  private async buildMaRootFolder(offset: number): Promise<ContentFolder> {
    this.recommendationAliases = new Map<string, string>();
    // Best-effort recommendations; failures should not block the view.
    const recommendations = await bestEffort(() => this.api.getRecommendations(), {
      fallback: [],
      onError: 'debug',
      log: this.maLog,
      label: 'musicassistant recommendations failed',
    }) as any[];
    const picked: ContentFolderItem[] = [];

    if (Array.isArray(recommendations) && recommendations.length) {
      const remaining = [...recommendations];
      for (const plan of this.recommendationPlan) {
        const idx = remaining.findIndex((rec: any) => rec?.item_id === plan.id);
        if (idx >= 0) {
          const rec = remaining.splice(idx, 1)[0];
          this.recommendationAliases.set(plan.alias, rec.item_id);
          const mapped = this.mapMaRecommendationGroup(rec, plan.alias);
          if (mapped) picked.push(mapped);
        }
      }
    }

    return {
      id: 'root',
      name: this.displayLabel,
      service: this.providerType,
      start: offset,
      totalitems: 4 + picked.length,
      items: [
        this.folderLinkMa('playlists', 'Playlists'),
        this.folderLinkMa('albums', 'Albums'),
        this.folderLinkMa('artists', 'Artists'),
        this.folderLinkMa('radios', 'Radio'),
        ...picked,
      ],
    };
  }

  private buildMaFolder(
    id: string,
    name: string,
    res: { items: any[]; total: number },
    offset: number,
    mapper: (item: any) => ContentFolderItem,
  ): ContentFolder {
    const items = (res.items || []).map(mapper).filter(Boolean) as ContentFolderItem[];
    return {
      id,
      name,
      service: this.providerType,
      start: offset,
      totalitems: typeof res.total === 'number' ? res.total : items.length,
      items,
    };
  }

  private folderLinkMa(id: string, name: string): ContentFolderItem {
    return {
      id,
      name,
      type: FileType.Folder,
      items: 0,
    };
  }

  private mapMaTrack(track: any): ContentFolderItem {
    const item = this.unwrapMediaItem(track);
    const rawId = this.extractMaId(item) || 'unknown';
    const uri = this.makeMaUri('track', rawId, item);
    const album = typeof item.album === 'string' ? item.album : item.album?.name;
    const artists = Array.isArray(item.artists)
      ? item.artists.map((a: any) => a?.name).filter(Boolean).join(', ')
      : item.artist || '';
    const cover = this.extractMaCover(item);
    return {
      id: uri,
      audiopath: uri,
      name: item.name ?? item.title ?? rawId,
      title: item.name ?? item.title ?? rawId,
      artist: artists,
      album: album ?? '',
      coverurl: cover,
      thumbnail: cover,
      type: FileType.File,
      tag: 'track',
      duration: typeof item.duration === 'number' ? Math.round(item.duration) : undefined,
      hasCover: !!cover,
      provider: this.providerType,
    };
  }

  private mapMaAlbum(album: any): ContentFolderItem {
    const item = this.unwrapMediaItem(album);
    const rawId = this.extractMaId(item) || 'unknown';
    const uri = this.makeMaUri('album', rawId, item);
    const cover = this.extractMaCover(item);
    const artist = Array.isArray(item.artists)
      ? item.artists.map((a: any) => a?.name).filter(Boolean).join(', ')
      : item.artist || '';
    return {
      id: uri,
      audiopath: uri,
      name: item.name ?? item.title ?? rawId,
      title: item.name ?? item.title ?? rawId,
      artist,
      coverurl: cover,
      thumbnail: cover,
      type: FileType.PlaylistBrowsable,
      tag: 'album',
      hasCover: !!cover,
      provider: this.providerType,
    };
  }

  private mapMaArtist(artistObj: any): ContentFolderItem {
    const item = this.unwrapMediaItem(artistObj);
    const rawId = this.extractMaId(item) || 'unknown';
    const uri = this.makeMaUri('artist', rawId, item);
    const cover = this.extractMaCover(item);
    const name = item.name ?? item.title ?? rawId;
    return {
      id: uri,
      audiopath: uri,
      name,
      title: name,
      artist: name,
      coverurl: cover,
      thumbnail: cover,
      type: FileType.PlaylistBrowsable,
      tag: 'artist',
      hasCover: !!cover,
      provider: this.providerType,
    };
  }

  private mapMaPlaylist(playlist: any): ContentFolderItem {
    const item = this.unwrapMediaItem(playlist);
    const rawId = this.extractMaId(item) || 'unknown';
    const uri = this.makeMaUri('playlist', rawId, item);
    const cover = this.extractMaCover(item);
    return {
      id: uri,
      audiopath: uri,
      name: item.name ?? item.title ?? rawId,
      title: item.name ?? item.title ?? rawId,
      owner: item.owner || '',
      owner_id: item.owner_id || '',
      coverurl: cover,
      thumbnail: cover,
      type: FileType.PlaylistBrowsable,
      tag: 'playlist',
      hasCover: !!cover,
      provider: this.providerType,
    };
  }

  private mapMaRadio(radio: any): ContentFolderItem {
    const item = this.unwrapMediaItem(radio);
    const rawId = this.extractMaId(item) || 'unknown';
    const uri = this.makeMaUri('radio', rawId, item);
    const cover = this.extractMaCover(item);
    return {
      id: uri,
      audiopath: uri,
      name: item.name ?? item.title ?? rawId,
      title: item.name ?? item.title ?? rawId,
      coverurl: cover,
      thumbnail: cover,
      type: FileType.File,
      tag: 'radio',
      provider: this.providerType,
    };
  }

  private mapMaRecommendationGroup(rec: any, alias?: string): ContentFolderItem | null {
    const id = typeof rec?.item_id === 'string' ? rec.item_id : '';
    if (!id) return null;
    const items = Array.isArray(rec?.items) ? rec.items.length : 0;
    const targetId = alias || id;
    const label = rec.name || rec.translation_key || 'Recommendation';
    const name = alias ? `${alias}: ${label}` : label;
    return {
      id: this.makeMaRecommendationId(targetId),
      name,
      title: name,
      type: FileType.Folder,
      items,
      provider: this.providerType,
    };
  }

  private mapMaRecommendationItem(entry: any): ContentFolderItem | null {
    const mediaType = (entry?.media_type || '').toLowerCase();
    if (mediaType === 'track') return this.mapMaTrack(entry);
    if (mediaType === 'album') return this.mapMaAlbum(entry);
    if (mediaType === 'artist') return this.mapMaArtist(entry);
    if (mediaType === 'playlist') return this.mapMaPlaylist(entry);
    if (mediaType === 'radio') return this.mapMaRadio(entry);
    return null;
  }

  private normalizeMaFolderId(folderId: string): FolderKind {
    const raw = folderId || 'root';
    const strippedRaw = raw
      .replace(/^spotify@[^:]+:/i, '')
      .replace(/^spotify[:/]/i, '')
      .replace(/^musicassistant[:/]/i, '')
      .replace(/^spotify\/[^/]+\//i, '')
      .replace(/^musicassistant\/[^/]+\//i, '');
    const key = (strippedRaw.split('/').pop() ?? strippedRaw).trim();
    const lower = key.toLowerCase();

    if (lower === 'root' || lower === 'start') return 'root';
    if (lower === 'playlists' || lower === 'playlist' || lower === '3') return 'playlists';
    if (lower === 'albums' || lower === 'album' || lower === '5') return 'albums';
    if (lower === 'artists' || lower === 'artist' || lower === '6') return 'artists';
    if (lower === 'radios' || lower === 'radio') return 'radios';
    if (lower === 'recommendations' || lower === 'rec') return 'recommendationRoot';
    const recMatch = key.match(/^recommendation:(.+)$/i);
    if (recMatch) return { type: 'recommendation', id: recMatch[1] };
    if (/^\d+$/.test(lower)) return { type: 'recommendation', id: key };

    const playlistMatch = key.match(/^playlist:(.+)$/i);
    if (playlistMatch) return { type: 'playlistItem', id: this.decodeMaId(playlistMatch[1]) };
    const albumMatch = key.match(/^album:(.+)$/i);
    if (albumMatch) return { type: 'albumItem', id: this.decodeMaId(albumMatch[1]) };
    const artistMatch = key.match(/^artist:(.+)$/i);
    if (artistMatch) return { type: 'artistItem', id: this.decodeMaId(artistMatch[1]) };
    return { type: 'unknown' };
  }

  private extractMaId(item: any): string {
    const source = this.unwrapMediaItem(item);
    return (
      (typeof source?.item_id === 'string' && source.item_id) ||
      (typeof source?.uri === 'string' && source.uri) ||
      (typeof source?.id === 'string' && source.id) ||
      ''
    );
  }

  private makeMaUri(type: string, rawId: string, item?: any): string {
    const encoded = this.encodeMaId(type, rawId, item);
    return `${this.providerId}:${type}:${encoded}`;
  }

  private makeMaRecommendationId(itemId: string): string {
    return `${this.providerId}:recommendation:${itemId}`;
  }

  private encodeMaId(type: string, rawId: string, item?: any): string {
    if (!rawId) return '';
    if (rawId.startsWith('b64_')) return rawId;
    const uri = this.toMaUri(type, rawId, item);
    return `b64_${Buffer.from(uri, 'utf-8').toString('base64')}`;
  }

  private decodeMaId(raw: string): string {
    if (!raw) return '';
    if (raw.startsWith('b64_')) {
      try {
        return Buffer.from(raw.slice(4), 'base64').toString('utf-8');
      } catch (err) {
        this.maLog.warn('failed to decode musicassistant id', { message: err instanceof Error ? err.message : String(err) });
      }
    }
    return this.toMaUri('track', raw);
  }

  private parseMaUri(raw: string, fallbackProvider = 'library'): { provider: string; id: string } {
    if (!raw) return { provider: fallbackProvider, id: raw };
    const schemeIdx = raw.indexOf('://');
    if (schemeIdx > 0) {
      const provider = raw.slice(0, schemeIdx) || fallbackProvider;
      const rest = raw.slice(schemeIdx + 3);
      const slashIdx = rest.indexOf('/');
      const id = slashIdx >= 0 ? rest.slice(slashIdx + 1) : rest;
      return { provider, id };
    }
    const colonParts = raw.split(':');
    if (colonParts.length === 3) {
      return { provider: colonParts[0] || fallbackProvider, id: colonParts[2] || raw };
    }
    return { provider: fallbackProvider, id: raw };
  }

  private extractMaCover(obj: any): string {
    const source = this.unwrapMediaItem(obj);
    const images = source?.metadata?.images || source?.images || source?.covers || source?.artwork;
    if (Array.isArray(images) && images.length) {
      const img = images.find((i: any) => i?.path) || images[0];
      const path = img?.path || img?.url || img?.link;
      if (typeof path === 'string') return this.resizeCover(path);
    }
    if (typeof source?.image === 'string') return this.resizeCover(source.image);
    if (typeof source?.cover === 'string') return this.resizeCover(source.cover);
    if (typeof source?.thumbnail === 'string') return this.resizeCover(source.thumbnail);
    return '';
  }

  /**
   * Ensure cover URLs are limited to ~256px where supported (Music Assistant imageproxy).
   */
  private resizeCover(url: string): string {
    if (!url) return '';
    try {
      const parsed = new URL(url);
      if (parsed.pathname.includes('imageproxy') && !parsed.searchParams.has('size')) {
        parsed.searchParams.set('size', '256');
        return parsed.toString();
      }
      // Apple Music images: .../<hash>/<filename>/<WxH>bb.jpg → force to 256x256
      if (parsed.hostname.includes('mzstatic.com')) {
        parsed.pathname = parsed.pathname.replace(/\/(\d{2,5})x\1bb\.jpg/i, '/256x256bb.jpg');
        return parsed.toString();
      }
    } catch {
      // not a full URL; return as-is
    }
    return url;
  }

  private toMaUri(type: string, raw: string, item?: any): string {
    if (!raw) return '';
    if (raw.includes('://')) return raw;
    const provider = this.getProviderFromItem(item) || 'library';
    const cleanProvider = typeof provider === 'string' ? provider : 'library';
    return `${cleanProvider}://${type}/${raw}`;
  }

  private getProviderFromItem(item: any): string {
    const source = this.unwrapMediaItem(item);
    if (!source) return '';
    if (typeof source.provider === 'string' && source.provider) return source.provider;
    if (typeof source.provider_domain === 'string' && source.provider_domain) return source.provider_domain;
    if (Array.isArray(source.provider_mappings) && source.provider_mappings.length) {
      const domain = source.provider_mappings[0]?.provider_domain;
      if (typeof domain === 'string') return domain;
    }
    if (Array.isArray(source.mappings) && source.mappings.length) {
      const domain = source.mappings[0]?.provider_domain;
      if (typeof domain === 'string') return domain;
    }
    return '';
  }

  /**
   * Some Music Assistant responses wrap the media item under `media_item` or `item`.
   * Normalize that shape so IDs/covers come from the actual track/album payload.
   */
  private unwrapMediaItem(item: any): any {
    if (!item) return item;
    if (item.media_item) return item.media_item;
    if (item.mediaitem) return item.mediaitem;
    if (item.item) return item.item;
    return item;
  }

  private async buildRecommendationFolder(
    recId: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder> {
    const resolvedId = this.resolveRecommendationId(recId);
    // Best-effort recommendations; failures should not block the view.
    const recommendations = await bestEffort(() => this.api.getRecommendations(), {
      fallback: [],
      onError: 'debug',
      log: this.maLog,
      label: 'musicassistant recommendations failed',
    }) as any[];
    const match = Array.isArray(recommendations)
      ? recommendations.find((rec: any) => rec?.item_id === resolvedId)
      : null;
    if (!match) {
      return {
        id: this.makeMaRecommendationId(recId),
        name: 'Recommendations',
        service: this.providerType,
        start: offset,
        totalitems: 0,
        items: [],
      };
    }

    const itemsRaw = Array.isArray(match?.items) ? match.items.slice(offset, offset + limit) : [];
    const mapped = itemsRaw
      .map((item: any) => this.mapMaRecommendationItem(item))
      .filter(Boolean) as ContentFolderItem[];

    return {
      id: this.makeMaRecommendationId(recId),
      name: match?.name || match?.translation_key || 'Recommendations',
      service: this.providerType,
      start: offset,
      totalitems: Array.isArray(match?.items) ? match.items.length : mapped.length,
      items: mapped,
    };
  }

  private resolveRecommendationId(recId: string): string {
    if (!recId) return recId;
    const direct = this.recommendationAliases.get(recId);
    if (direct) return direct;
    const planMatch = this.recommendationPlan.find((p) => p.alias === recId);
    if (planMatch) return planMatch.id;
    return recId;
  }
}
