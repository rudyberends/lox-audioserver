import type { SpotifyBridgeConfig } from '@/domain/config/types';
import type { ContentFolder, ContentFolderItem, ContentServiceAccount, PlaylistEntry } from '@/ports/ContentTypes';
import { createLogger } from '@/shared/logging/logger';
import { DEFAULT_MIN_SEARCH_LIMIT } from '@/adapters/content/utils/searchLimits';
import {
  extractVideoId,
  runYtDlpJsonLines,
  runYtDlpJson,
  type YtDlpExecOptions,
  YtDlpError,
} from '@/adapters/content/providers/ytmusic/ytmusicYtDlp';
import {
  YoutubeApiClient,
  type YoutubeVideoEntry,
} from '@/adapters/content/providers/youtube/youtubeApiClient';

const enum FileType {
  Folder = 1,
  File = 2,
  PlaylistBrowsable = 7,
}

type SearchResult = {
  tracks?: ContentFolderItem[];
};

interface YoutubeProviderOptions {
  providerId: string;
  label?: string;
  bridge: SpotifyBridgeConfig;
}

type FolderKind =
  | 'root'
  | { type: 'search'; query: string }
  | { type: 'trending' }
  | { type: 'newReleases' }
  | { type: 'genres' }
  | { type: 'genre'; q: string }
  | { type: 'playlists' }
  | { type: 'playlist'; id: string }
  | { type: 'channel'; id: string }
  | { type: 'track'; id: string }
  | { type: 'unknown'; raw: string };

export class YoutubeProvider {
  public readonly providerId: string;
  private readonly log = createLogger('Content', 'YouTube');
  private readonly label: string;
  private readonly apiClient: YoutubeApiClient | null;
  private readonly playlistMetaCacheTtlMs = 5 * 60_000;
  private readonly playlistMetaCache = new Map<string, { title: string; count: number | null; fetchedAt: number }>();
  private readonly playlistMetaInflight = new Map<string, Promise<{ title: string; count: number | null }>>();

  constructor(options: YoutubeProviderOptions) {
    this.providerId = options.providerId;
    this.label = options.label || 'YouTube';
    this.apiClient = options.bridge.youtubeApiKey
      ? new YoutubeApiClient(options.bridge.youtubeApiKey)
      : null;
  }

  public get accountId(): string {
    return 'youtube';
  }

  public get displayLabel(): string {
    return this.label;
  }

  public getServiceAccount(): ContentServiceAccount {
    return {
      id: this.providerId,
      label: this.displayLabel,
      provider: 'youtube',
      fake: true,
    };
  }

  public async fetchAccessToken(): Promise<string | null> {
    return null;
  }

  public async getPlaylists(_offset: number, _limit: number): Promise<PlaylistEntry[]> {
    return [];
  }

  public async getFolder(folderId: string, offset: number, limit: number): Promise<ContentFolder | null> {
    const normalized = this.normalizeFolderId(folderId);
    const start = Math.max(0, offset || 0);
    const cap = Math.max(1, limit || 50);

    if (normalized === 'root') {
      return this.buildRootFolder(start);
    }

    if (normalized.type === 'trending') {
      const tracks = await this.fetchTrending(cap);
      const page = tracks.slice(start, start + cap);
      return { id: folderId, name: 'Trending', service: 'youtube', start, totalitems: estimateTotal(start, page.length, cap), items: page };
    }

    if (normalized.type === 'newReleases') {
      const tracks = await this.fetchSearchViaYtDlp('new music releases', cap);
      const page = tracks.slice(start, start + cap);
      return { id: folderId, name: 'New Releases', service: 'youtube', start, totalitems: estimateTotal(start, page.length, cap), items: page };
    }

    if (normalized.type === 'genres') {
      const items: ContentFolderItem[] = [
        this.folderLink('genre:pop', 'Pop'),
        this.folderLink('genre:rock', 'Rock'),
        this.folderLink('genre:hiphop', 'Hip Hop'),
        this.folderLink('genre:dance', 'Dance & Electronic'),
        this.folderLink('genre:jazz', 'Jazz'),
        this.folderLink('genre:classical', 'Classical'),
        this.folderLink('genre:rnb', 'R&B'),
        this.folderLink('genre:country', 'Country'),
      ];
      return { id: folderId, name: 'Genres', service: 'youtube', start, totalitems: items.length, items };
    }

    if (normalized.type === 'genre') {
      const tracks = await this.fetchSearchViaYtDlp(`${normalized.q} music`, cap);
      const page = tracks.slice(start, start + cap);
      const name = normalized.q.charAt(0).toUpperCase() + normalized.q.slice(1);
      return { id: folderId, name, service: 'youtube', start, totalitems: estimateTotal(start, page.length, cap), items: page };
    }

    if (normalized.type === 'playlists') {
      const tracks = await this.fetchSearchViaYtDlp('popular music playlist', cap);
      const page = tracks.slice(start, start + cap);
      return { id: folderId, name: 'Playlists', service: 'youtube', start, totalitems: estimateTotal(start, page.length, cap), items: page };
    }

    if (normalized.type === 'playlist') {
      const playlistUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(normalized.id)}`;
      const meta = start === 0
        ? await this.fetchPlaylistMetaCached(playlistUrl)
        : this.getPlaylistMetaCached(playlistUrl);

      if (this.apiClient) {
        try {
          const entries = await this.apiClient.getPlaylistItems(normalized.id, cap);
          const items = entries.map((e) => this.mapApiVideoToTrack(e)).filter(Boolean) as ContentFolderItem[];
          const page = items.slice(start, start + cap);
          return { id: folderId, name: meta?.title || 'Playlist', service: 'youtube', start, totalitems: typeof meta?.count === 'number' ? meta.count : estimateTotal(start, page.length, cap), items: page };
        } catch (err) {
          this.log.warn('youtube playlist via api failed, falling back to yt-dlp', { message: errMessage(err) });
        }
      }

      try {
        const args = [
          '-j', '--js-runtimes', 'node', '--flat-playlist', '--no-warnings', '--skip-download',
          '--playlist-start', String(start + 1), '--playlist-end', String(start + cap),
          playlistUrl,
        ];
        const entries = await runYtDlpJsonLines(args, this.execOptions());
        const items = entries.map((e: any) => this.mapYtDlpEntryToTrack(e)).filter(Boolean) as ContentFolderItem[];
        const total = typeof meta?.count === 'number' ? meta.count : estimateTotal(start, items.length, cap);
        return { id: folderId, name: meta?.title || 'Playlist', service: 'youtube', start, totalitems: total, items };
      } catch (err) {
        this.log.warn('youtube playlist fetch failed', { folderId, message: errMessage(err) });
        return { id: folderId, name: 'Playlist', service: 'youtube', start, totalitems: 0, items: [] };
      }
    }

    if (normalized.type === 'channel') {
      const channelUrl = `https://www.youtube.com/channel/${encodeURIComponent(normalized.id)}/videos`;
      try {
        const args = [
          '-j', '--js-runtimes', 'node', '--flat-playlist', '--no-warnings', '--skip-download',
          '--playlist-start', String(start + 1), '--playlist-end', String(start + cap),
          channelUrl,
        ];
        const entries = await runYtDlpJsonLines(args, this.execOptions());
        const items = entries.map((e: any) => this.mapYtDlpEntryToTrack(e)).filter(Boolean) as ContentFolderItem[];
        return { id: folderId, name: 'Channel', service: 'youtube', start, totalitems: estimateTotal(start, items.length, cap), items };
      } catch (err) {
        this.log.warn('youtube channel fetch failed', { folderId, message: errMessage(err) });
        return { id: folderId, name: 'Channel', service: 'youtube', start, totalitems: 0, items: [] };
      }
    }

    if (normalized.type === 'track') {
      const track = await this.getTrack(normalized.id);
      const items = track ? [track] : [];
      return { id: folderId, name: 'Video', service: 'youtube', start, totalitems: items.length, items };
    }

    return { id: folderId, name: this.displayLabel, service: 'youtube', start, totalitems: 0, items: [] };
  }

  public async getTrack(trackId: string): Promise<ContentFolderItem | null> {
    const videoId = extractVideoId(String(trackId || '').trim());
    if (!videoId) return null;
    try {
      const args = [
        '-J', '--js-runtimes', 'node', '--no-playlist', '--no-warnings', '--skip-download',
        `https://www.youtube.com/watch?v=${videoId}`,
      ];
      const data = await runYtDlpJson(args, this.execOptions());
      if (!data) return null;
      return this.mapYtDlpVideoToTrack(data);
    } catch (err) {
      this.log.debug('youtube track lookup failed', { trackId: videoId, message: errMessage(err) });
      return null;
    }
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
    try {
      const tracks = await this.fetchSearchResults(query, limit);
      return { result: { tracks }, providerId: this.providerId, user: this.accountId };
    } catch (err) {
      this.log.warn('youtube search failed', { message: errMessage(err) });
      return { result: {}, providerId: this.providerId, user: this.accountId };
    }
  }

  public dispose(): void {}

  private async fetchSearchResults(query: string, limit: number): Promise<ContentFolderItem[]> {
    if (this.apiClient) {
      try {
        const entries = await this.apiClient.search(query, limit);
        return entries.map((e) => this.mapApiVideoToTrack(e)).filter(Boolean) as ContentFolderItem[];
      } catch (err) {
        this.log.warn('youtube search via api failed, falling back to yt-dlp', { message: errMessage(err) });
      }
    }
    return this.fetchSearchViaYtDlp(query, limit);
  }

  private async fetchSearchViaYtDlp(query: string, limit: number): Promise<ContentFolderItem[]> {
    const safeLimit = Math.max(1, Math.min(50, limit));
    const args = [
      '-j', '--js-runtimes', 'node', '--flat-playlist', '--no-warnings', '--skip-download',
      `ytsearch${safeLimit}:${query}`,
    ];
    const entries = await runYtDlpJsonLines(args, this.execOptions());
    return entries.map((e: any) => this.mapYtDlpEntryToTrack(e)).filter(Boolean) as ContentFolderItem[];
  }

  private async fetchTrending(limit: number): Promise<ContentFolderItem[]> {
    if (this.apiClient) {
      try {
        const entries = await this.apiClient.getTrendingMusic(limit);
        return entries.map((e) => this.mapApiVideoToTrack(e)).filter(Boolean) as ContentFolderItem[];
      } catch (err) {
        this.log.warn('youtube trending via api failed, falling back to yt-dlp', { message: errMessage(err) });
      }
    }
    return this.fetchSearchViaYtDlp('trending music', limit);
  }

  private execOptions(): YtDlpExecOptions {
    return { timeoutMs: 20_000 };
  }

  private getPlaylistMetaCached(playlistUrl: string): { title: string; count: number | null } | null {
    const cached = this.playlistMetaCache.get(playlistUrl);
    if (!cached || Date.now() - cached.fetchedAt > this.playlistMetaCacheTtlMs) return null;
    return { title: cached.title, count: cached.count };
  }

  private async fetchPlaylistMetaCached(playlistUrl: string): Promise<{ title: string; count: number | null }> {
    const cached = this.getPlaylistMetaCached(playlistUrl);
    if (cached) return cached;
    const inflight = this.playlistMetaInflight.get(playlistUrl);
    if (inflight) return inflight;

    const promise = (async () => {
      try {
        const args = [
          '-J', '--js-runtimes', 'node', '--flat-playlist', '--no-warnings',
          '--skip-download', '--playlist-end', '1', playlistUrl,
        ];
        const data = await runYtDlpJson(args, this.execOptions());
        const title = typeof data?.title === 'string' ? data.title : '';
        const count = typeof data?.playlist_count === 'number' ? data.playlist_count : null;
        const meta = { title: title || 'Playlist', count };
        this.playlistMetaCache.set(playlistUrl, { ...meta, fetchedAt: Date.now() });
        return meta;
      } catch {
        const meta = { title: 'Playlist', count: null };
        this.playlistMetaCache.set(playlistUrl, { ...meta, fetchedAt: Date.now() });
        return meta;
      } finally {
        this.playlistMetaInflight.delete(playlistUrl);
      }
    })();

    this.playlistMetaInflight.set(playlistUrl, promise);
    return promise;
  }

  private normalizeFolderId(folderId: string): FolderKind {
    const raw = (folderId || 'root').trim();
    const stripped = raw
      .replace(/^spotify@[^:]+:/i, '')
      .replace(/^youtube@[^:]+:/i, '')
      .replace(/^spotify[:/]/i, '')
      .replace(/^youtube[:/]/i, '');
    const lower = stripped.toLowerCase().trim();

    if (!lower || lower === 'root' || lower === 'start') return 'root';

    if (lower === '0' || lower === 'popular' || lower === 'trending') return { type: 'trending' };
    if (lower === '1' || lower === 'newreleases' || lower.startsWith('new')) return { type: 'newReleases' };
    if (lower === '2' || lower === 'genres' || lower === 'moods') return { type: 'genres' };
    if (lower === '3' || lower === 'playlists' || lower === 'playlist') return { type: 'playlists' };

    const genreMatch = stripped.match(/^genre:(.+)$/i);
    if (genreMatch) return { type: 'genre', q: genreMatch[1] ?? '' };

    const searchMatch = stripped.match(/^search:(.+)$/i);
    if (searchMatch) return { type: 'search', query: searchMatch[1] ?? '' };

    const trackMatch = stripped.match(/^track:(.+)$/i);
    if (trackMatch) return { type: 'track', id: trackMatch[1] ?? '' };

    const playlistMatch = stripped.match(/^playlist:(.+)$/i);
    if (playlistMatch) return { type: 'playlist', id: playlistMatch[1] ?? '' };

    const channelMatch = stripped.match(/^channel:(.+)$/i);
    if (channelMatch) return { type: 'channel', id: channelMatch[1] ?? '' };

    if (/^UC[a-zA-Z0-9_-]{10,}$/.test(stripped)) return { type: 'channel', id: stripped };
    if (/^PL[a-zA-Z0-9_-]{16,}$/.test(stripped)) return { type: 'playlist', id: stripped };
    if (/^[a-zA-Z0-9_-]{11}$/.test(stripped)) return { type: 'track', id: stripped };

    return { type: 'unknown', raw: folderId };
  }

  private buildRootFolder(offset: number): ContentFolder {
    const items: ContentFolderItem[] = [
      this.folderLink('0', 'Trending'),
      this.folderLink('1', 'New Releases'),
      this.folderLink('2', 'Genres'),
      this.folderLink('3', 'Playlists'),
    ];
    return { id: 'root', name: this.displayLabel, service: 'youtube', start: offset, totalitems: items.length, items };
  }

  private folderLink(id: string, name: string): ContentFolderItem {
    return { id, name, type: FileType.Folder, items: 0, provider: 'youtube' };
  }

  private makeUri(type: 'track' | 'playlist' | 'channel', id: string): string {
    return `${this.providerId}:${type}:${id}`;
  }

  private mapYtDlpEntryToTrack(entry: any): ContentFolderItem | null {
    const id = String(entry?.id ?? '');
    const url = (typeof entry?.url === 'string' ? entry.url : '') || (typeof entry?.webpage_url === 'string' ? entry.webpage_url : '') || '';
    const title = String(entry?.title ?? entry?.fulltitle ?? '').trim();
    const duration = typeof entry?.duration === 'number' ? Math.round(entry.duration) : undefined;
    const videoId = extractVideoId(url || id);
    if (!videoId || !title) return null;
    const thumb = pickYtDlpThumb(entry) || fallbackVideoThumb(videoId);
    const audiopath = this.makeUri('track', videoId);
    return {
      id: audiopath, audiopath, name: title, title,
      artist: String(entry?.channel ?? entry?.uploader ?? '').trim(),
      album: '', coverurl: thumb, thumbnail: thumb,
      type: FileType.File, tag: 'track', duration, hasCover: !!thumb, provider: 'youtube',
    };
  }

  private mapYtDlpVideoToTrack(data: any): ContentFolderItem {
    const id = String(data?.id ?? '');
    const title = String(data?.title ?? id);
    const duration = typeof data?.duration === 'number' ? Math.round(data.duration) : undefined;
    const thumb = (typeof data?.thumbnail === 'string' ? data.thumbnail : '') || fallbackVideoThumb(id);
    const audiopath = `${this.providerId}:track:${id}`;
    return {
      id: audiopath, audiopath, name: title, title,
      artist: String(data?.uploader ?? data?.channel ?? ''),
      album: '', coverurl: thumb, thumbnail: thumb,
      type: FileType.File, tag: 'track', duration, hasCover: !!thumb, provider: 'youtube',
    };
  }

  private mapApiVideoToTrack(entry: YoutubeVideoEntry): ContentFolderItem | null {
    if (!entry.videoId || !entry.title) return null;
    const thumb = entry.thumbnail || fallbackVideoThumb(entry.videoId);
    const audiopath = this.makeUri('track', entry.videoId);
    return {
      id: audiopath, audiopath, name: entry.title, title: entry.title,
      artist: entry.channelTitle, album: '',
      coverurl: thumb, thumbnail: thumb,
      type: FileType.File, tag: 'track', hasCover: !!thumb, provider: 'youtube',
    };
  }

}

function estimateTotal(start: number, pageSize: number, cap: number): number {
  return pageSize < cap ? start + pageSize : start + cap + 1;
}

function fallbackVideoThumb(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

function pickYtDlpThumb(value: any): string {
  if (!value) return '';
  const direct = typeof value?.thumbnail === 'string' ? value.thumbnail : '';
  if (direct) return direct;
  const thumbs = Array.isArray(value?.thumbnails) ? value.thumbnails : [];
  for (let i = thumbs.length - 1; i >= 0; i -= 1) {
    const u = typeof thumbs[i]?.url === 'string' ? thumbs[i].url : '';
    if (u) return u;
  }
  return '';
}

function errMessage(err: unknown): string {
  if (err instanceof YtDlpError) return `yt-dlp: ${err.stderr || err.message}`;
  return err instanceof Error ? err.message : String(err);
}
