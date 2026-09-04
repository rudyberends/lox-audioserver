import type { StreamingServiceConfig } from '@/domain/config/types';
import type { ContentFolder, ContentFolderItem, ContentServiceAccount, PlaylistEntry } from '@/ports/ContentTypes';
import { estimatedPage, knownPage, slicedPage } from '@/adapters/content/folderPage';
import { createLogger } from '@/shared/logging/logger';
import { DEFAULT_MIN_SEARCH_LIMIT } from '@/adapters/content/utils/searchLimits';
import { stripAccountSlug } from '@/adapters/content/utils/folderIdPrefix';
import { convertCookieToNetscape } from '@/adapters/content/providers/ytmusic/ytmusicCookie';
import {
  YtMusicCookieExpiredError,
  ytmBrowse,
  type YtMusicContinuation,
  type YtMusicInnertubeClientOptions,
} from '@/adapters/content/providers/ytmusic/ytmusicInnertube';
import { recordYtMusicAuth } from '@/adapters/content/providers/ytmusic/ytmusicAuthState';
import {
  buildYtMusicBrowseUrl,
  buildYtMusicPlaylistUrl,
  buildYtMusicSearchUrl,
  buildYtMusicWatchUrl,
  extractVideoId,
  runYtDlpJsonLines,
  runYtDlpJson,
  type YtDlpExecOptions,
  YtDlpError,
} from '@/adapters/content/providers/ytmusic/ytmusicYtDlp';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ContentProvider, ProviderSearchResult } from '@/adapters/content/ContentProvider';

const enum FileType {
  Folder = 1,
  File = 2,
  PlaylistBrowsable = 7,
}

/** The leading segments a folder id may open with; anything else is an account slug. */
const FOLDER_KINDS = ['track', 'playlist', 'album', 'artist', 'genre'] as const;

interface YtMusicProviderOptions {
  providerId: string;
  serviceNativePrefix?: string;
  label?: string;
  bridge: StreamingServiceConfig;
  browse?: (
    browseId: string,
    options: YtMusicInnertubeClientOptions,
    continuation?: YtMusicContinuation | null,
  ) => Promise<any>;
}

type FolderKind =
  | 'root'
  | { type: 'playlists' }
  | { type: 'albums' }
  | { type: 'artists' }
  | { type: 'popular' }
  | { type: 'newReleases' }
  | { type: 'genres' }
  | { type: 'likedSongs' }
  | { type: 'genre'; q: string }
  | { type: 'playlist'; id: string }
  | { type: 'track'; id: string }
  | { type: 'artist'; id: string }
  | { type: 'album'; id: string }
  | { type: 'unknown'; raw: string };

export class YtMusicProvider implements ContentProvider {
  public readonly providerId: string;
  private readonly audiopathPrefix: string;
  private readonly log = createLogger('Content', 'YTMusic');
  private readonly label: string;
  private bridge: StreamingServiceConfig;
  private readonly browse: (
    browseId: string,
    options: YtMusicInnertubeClientOptions,
    continuation?: YtMusicContinuation | null,
  ) => Promise<any>;

  private cookieFile: { cookie: string; path: string } | null = null;
  private missingCookieWarned = false;
  private readonly libraryCacheTtlMs = 60_000;
  private libraryCache: {
    albums?: { items: ContentFolderItem[]; fetchedAt: number };
    playlists?: { items: ContentFolderItem[]; fetchedAt: number };
    artists?: { items: ContentFolderItem[]; fetchedAt: number };
  } = {};

  private artistTracksCache = new Map<string, { items: ContentFolderItem[]; fetchedAt: number }>();
  private albumTracksCache = new Map<string, { items: ContentFolderItem[]; fetchedAt: number }>();
  private readonly playlistMetaCacheTtlMs = 5 * 60_000;
  private playlistMetaCache = new Map<string, { title: string; count: number | null; fetchedAt: number }>();
  private playlistMetaInflight = new Map<string, Promise<{ title: string; count: number | null }>>();

  constructor(options: YtMusicProviderOptions) {
    this.providerId = options.providerId;
    this.audiopathPrefix = options.serviceNativePrefix ?? options.providerId;
    this.label = options.label || 'YouTube Music';
    this.bridge = options.bridge;
    this.browse = options.browse ?? ytmBrowse;
  }

  public get accountId(): string {
    return 'ytmusic';
  }

  public get displayLabel(): string {
    return this.label;
  }

  public getServiceAccount(): ContentServiceAccount {
    return {
      id: this.providerId,
      label: this.displayLabel,
      provider: 'ytmusic',
      fake: true,
    };
  }

  public async fetchAccessToken(): Promise<string | null> {
    // Not required; yt-dlp uses cookies.
    return null;
  }

  public async getPlaylists(_offset: number, _limit: number): Promise<PlaylistEntry[]> {
    // Listing library playlists requires deeper YTM API integration; keep minimal for now.
    return [];
  }

  public async getFolder(folderId: string, offset: number, limit: number): Promise<ContentFolder | null> {
    const normalized = this.normalizeFolderId(folderId);
    const start = Math.max(0, offset || 0);
    const cap = Math.max(1, limit || 50);

    if (normalized === 'root') {
      return this.buildRootFolder(start);
    }

    if (normalized.type === 'playlists') {
      const library = await this.fetchLibraryPlaylists();
      const items: ContentFolderItem[] = [];
      if (start === 0 && this.hasCookie()) {
        items.push(this.folderLink('liked', 'Liked songs'));
      }
      const libraryStart = Math.max(0, start - 1);
      const remaining = Math.max(0, cap - items.length);
      items.push(...library.slice(libraryStart, libraryStart + remaining));
      return {
        id: folderId,
        name: 'Playlists',
        service: 'ytmusic',
        start,
        totalitems: (this.hasCookie() ? 1 : 0) + library.length,
        items,
      };
    }

    if (normalized.type === 'albums') {
      const albums = await this.fetchLibraryAlbums();
      return slicedPage({ id: folderId, name: 'Albums', service: 'ytmusic', start }, albums, cap);
    }

    if (normalized.type === 'artists') {
      const artists = await this.fetchLibraryArtists();
      return slicedPage({ id: folderId, name: 'Artists', service: 'ytmusic', start }, artists, cap);
    }

    if (normalized.type === 'popular') {
      const tracks = await this.fetchTrackSearchResults({ query: 'top hits', offset: start, limit: cap });
      return estimatedPage(
        { id: folderId, name: 'Popular', service: 'ytmusic', start, items: tracks },
        cap,
      );
    }

    if (normalized.type === 'newReleases') {
      const albums = await this.fetchTrackSearchResults({ query: 'new music', offset: start, limit: cap });
      return estimatedPage(
        { id: folderId, name: 'New Releases', service: 'ytmusic', start, items: albums },
        cap,
      );
    }

    if (normalized.type === 'genres') {
      const items: ContentFolderItem[] = [
        this.folderLink('genre:pop', 'Pop'),
        this.folderLink('genre:rock', 'Rock'),
        this.folderLink('genre:hiphop', 'Hip Hop'),
        this.folderLink('genre:dance', 'Dance'),
        this.folderLink('genre:jazz', 'Jazz'),
        this.folderLink('genre:classical', 'Classical'),
      ];
      return {
        id: folderId,
        name: 'Genres & Moods',
        service: 'ytmusic',
        start,
        totalitems: items.length,
        items,
      };
    }

    if (normalized.type === 'likedSongs') {
      return this.getFolder(`playlist:LM`, start, cap);
    }

    if (normalized.type === 'genre') {
      const tracks = await this.fetchTrackSearchResults({ query: `${normalized.q} music`, offset: start, limit: cap });
      return estimatedPage(
        { id: folderId, name: normalized.q.toUpperCase(), service: 'ytmusic', start, items: tracks },
        cap,
      );
    }

    if (normalized.type === 'artist') {
      const tracks = await this.fetchArtistTracksFromInnertube(normalized.id, start, cap);
      return estimatedPage(
        { id: folderId, name: 'Artist', service: 'ytmusic', start, items: tracks },
        cap,
      );
    }

    if (normalized.type === 'album') {
      let tracks = await this.fetchAlbumTracksFromInnertube(normalized.id, start, cap);
      if (tracks.length === 0) {
        const browseUrl = buildYtMusicBrowseUrl(normalized.id);
        tracks = await this.fetchTracksFromBrowse(browseUrl, start, cap);
      }
      return estimatedPage(
        { id: folderId, name: 'Album', service: 'ytmusic', start, items: tracks },
        cap,
      );
    }

    if (normalized.type === 'track') {
      const track = await this.getTrack(normalized.id);
      const items = track ? [track] : [];
      return {
        id: folderId,
        name: 'Track',
        service: 'ytmusic',
        start,
        totalitems: items.length,
        items,
      };
    }

    if (normalized.type === 'playlist') {
      const playlistId = normalized.id;
      if (playlistId.toUpperCase() === 'LM' && !this.hasCookie()) {
        this.warnMissingCookieOnce();
        return {
          id: folderId,
          name: 'Liked songs',
          service: 'ytmusic',
          start,
          totalitems: 0,
          items: [],
        };
      }
      const cookieFile = await this.ensureCookieFile();
      try {
        const playlistUrl = isBrowseLikePlaylistId(playlistId)
          ? buildYtMusicBrowseUrl(playlistId)
          : buildYtMusicPlaylistUrl(playlistId);
        // Fetch playlist entries via JSON-lines for lower overhead.
        const entriesArgs = [
          '-j',
          '--js-runtimes',
          'node',
          '--flat-playlist',
          '--no-warnings',
          '--skip-download',
          '--playlist-start',
          String(start + 1),
          '--playlist-end',
          String(start + cap),
          ...this.buildCookieArgs(cookieFile),
          playlistUrl,
        ];
        // Only fetch playlist metadata on the first page (then reuse cached values for subsequent pages).
        // This avoids paying extra "playlist_count/title" work per page.
        const meta =
          start === 0 ? await this.fetchPlaylistMetaCached(playlistUrl, cookieFile) : this.getPlaylistMetaCached(playlistUrl);

        const entries = await runYtDlpJsonLines(entriesArgs, this.execOptions());
        const mapped = (entries ?? [])
          .map((e: any) => this.mapSearchEntryToTrack(e))
          .filter(Boolean) as ContentFolderItem[];
        const base = {
          id: folderId,
          name: meta?.title || 'Playlist',
          service: 'ytmusic',
          start,
          items: mapped,
        };
        // The playlist metadata carries a real count when we managed to fetch it; the
        // entries themselves come back a page at a time with no total attached.
        return typeof meta?.count === 'number'
          ? knownPage(base, meta.count)
          : estimatedPage(base, cap);
      } finally {
        // Keep cookie file around for reuse; it will be rewritten if the cookie changes.
      }
    }

    return {
      id: folderId,
      name: this.displayLabel,
      service: 'ytmusic',
      start,
      totalitems: 0,
      items: [],
    };
  }

  public async getTrack(trackId: string): Promise<ContentFolderItem | null> {
    const decoded = String(trackId || '').trim();
    const videoId = extractVideoId(decoded);
    if (!videoId) {
      return null;
    }
    const cookieFile = await this.ensureCookieFile();
    try {
      const url = buildYtMusicWatchUrl(videoId);
      const args = [
        '-J',
        '--js-runtimes',
        'node',
        '--no-playlist',
        '--no-warnings',
        '--skip-download',
        ...this.buildCookieArgs(cookieFile),
        url,
      ];
      const data = await runYtDlpJson(args, this.execOptions());
      if (!data) return null;
      return this.mapVideoToTrack(data);
    } catch (err) {
      if (err instanceof YtDlpError) {
        this.log.debug('ytmusic track lookup failed (yt-dlp)', {
          providerId: this.providerId,
          trackId: videoId,
          stderr: err.stderr || undefined,
        });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.debug('ytmusic track lookup failed', { providerId: this.providerId, trackId: videoId, message: msg });
      }
      return null;
    } finally {
      // Keep cookie file around for reuse.
    }
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
    const cookieFile = await this.ensureCookieFile();
    try {
      const url = buildYtMusicSearchUrl(query);
      const args = [
        '-j',
        '--js-runtimes',
        'node',
        '--flat-playlist',
        '--no-warnings',
        '--skip-download',
        '--playlist-end',
        String(limit),
        ...this.buildCookieArgs(cookieFile),
        url,
      ];
      const entries = await runYtDlpJsonLines(args, this.execOptions());
      const tracks = entries
        .map((e: any) => this.mapSearchEntryToTrack(e))
        .filter(Boolean) as ContentFolderItem[];
      return {
        result: { tracks },
        providerId: this.providerId,
        user: this.accountId,
      };
    } catch (err) {
      if (err instanceof YtDlpError) {
        this.log.warn('ytmusic search failed (yt-dlp)', {
          providerId: this.providerId,
          stderr: err.stderr || undefined,
        });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn('ytmusic search failed', { providerId: this.providerId, message: msg });
      }
      return { result: {}, providerId: this.providerId, user: this.accountId };
    } finally {
      // Keep cookie file around for reuse.
    }
  }

  public dispose(): void {
    // Leave cookie files in /tmp; the container owns /tmp lifecycle.
  }

  private execOptions(): YtDlpExecOptions {
    return { timeoutMs: 20_000 };
  }

  private buildCookieArgs(cookieFile: string | null): string[] {
    if (!cookieFile) return [];
    return ['--cookies', cookieFile];
  }

  private async ensureCookieFile(): Promise<string | null> {
    const cookie = typeof this.bridge?.ytmusicCookie === 'string' ? this.bridge.ytmusicCookie.trim() : '';
    if (!cookie) return null;
    if (this.cookieFile && this.cookieFile.cookie === cookie) {
      return this.cookieFile.path;
    }
    const content = convertCookieToNetscape(cookie, '.youtube.com');
    const safeBridgeId = String(this.bridge.id || 'bridge').replace(/[^a-zA-Z0-9_-]/g, '_');
    const tmpPath = path.join('/tmp', `lox-ytmusic-cookies-${safeBridgeId}.txt`);
    await fsp.writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
    this.cookieFile = { cookie, path: tmpPath };
    return tmpPath;
  }

  private getPlaylistMetaCached(playlistUrl: string): { title: string; count: number | null } | null {
    const cached = this.playlistMetaCache.get(playlistUrl);
    if (!cached) return null;
    if (Date.now() - cached.fetchedAt > this.playlistMetaCacheTtlMs) return null;
    return { title: cached.title, count: cached.count };
  }

  private async fetchPlaylistMetaCached(
    playlistUrl: string,
    cookieFile: string | null,
  ): Promise<{ title: string; count: number | null }> {
    const cached = this.getPlaylistMetaCached(playlistUrl);
    if (cached) return cached;

    const inflight = this.playlistMetaInflight.get(playlistUrl);
    if (inflight) return inflight;

    const promise = (async () => {
      try {
        const args = [
          '-J',
          '--js-runtimes',
          'node',
          '--flat-playlist',
          '--no-warnings',
          '--skip-download',
          // Only fetch minimal items; still yields playlist title/count when available.
          '--playlist-end',
          '1',
          ...this.buildCookieArgs(cookieFile),
          playlistUrl,
        ];
        const data = await runYtDlpJson(args, this.execOptions());
        const title = typeof data?.title === 'string' ? data.title : '';
        const count = typeof data?.playlist_count === 'number' ? data.playlist_count : null;
        const meta = { title: title || 'Playlist', count };
        this.playlistMetaCache.set(playlistUrl, { ...meta, fetchedAt: Date.now() });
        return meta;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.debug('ytmusic playlist meta fetch failed', { providerId: this.providerId, playlistUrl, message: msg });
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
    const stripped = stripAccountSlug(
      raw
        .replace(/^spotify@[^:]+:/i, '')
        .replace(/^ytmusic@[^:]+:/i, '')
        .replace(/^spotify[:/]/i, '')
        .replace(/^ytmusic[:/]/i, ''),
      FOLDER_KINDS,
    );
    const key = (stripped.split('/').pop() ?? stripped).trim();
    const lower = key.toLowerCase();

    if (!lower || lower === 'root' || lower === 'start') return 'root';

    // Loxone Spotify clients sometimes use numeric folder ids (consistent with Spotify's own mapping):
    // 0 popular, 1 new releases, 2 genres, 3 playlists, 5 albums, 6 artists.
    if (lower === 'playlist' || lower === 'playlists') return { type: 'playlists' };
    if (lower === 'album' || lower === 'albums') return { type: 'albums' };
    if (lower === 'artist' || lower === 'artists') return { type: 'artists' };
    if (lower.includes('popular') || lower.includes('recommend') || lower.includes('aanbevel')) {
      return { type: 'popular' };
    }
    if (lower.includes('new')) return { type: 'newReleases' };
    if (lower.includes('genres') || lower.includes('moods')) return { type: 'genres' };

    if (lower === 'liked' || lower === 'likes' || lower === 'lm') return { type: 'likedSongs' };
    if (lower.startsWith('genre:')) return { type: 'genre', q: lower.slice('genre:'.length) };

    const trackMatch = key.match(/^track:(.+)$/i);
    if (trackMatch) return { type: 'track', id: trackMatch[1] ?? '' };

    const artistMatch = key.match(/^artist:(.+)$/i);
    if (artistMatch) return { type: 'artist', id: artistMatch[1] ?? '' };

    const albumMatch = key.match(/^album:(.+)$/i);
    if (albumMatch) return { type: 'album', id: albumMatch[1] ?? '' };

    const playlistMatch = key.match(/^playlist:(.+)$/i);
    if (playlistMatch) return { type: 'playlist', id: playlistMatch[1] ?? '' };

    // YouTube channel IDs (artists) usually start with UC.
    if (/^UC[a-zA-Z0-9_-]{10,}$/.test(key)) return { type: 'artist', id: key };
    // YouTube Music library artist browseIds (e.g. MPLAUC...).
    if (/^MPLA[A-Za-z0-9_-]{6,}$/.test(key)) return { type: 'artist', id: key };
    // YouTube Music album browseIds (e.g. MPREb_...).
    if (/^MPREb_[A-Za-z0-9_-]{6,}$/.test(key)) return { type: 'album', id: key };
    // YouTube Music playlist browseIds (e.g. VL..., VLR...).
    if (/^VL[A-Za-z0-9_-]{2,}$/.test(key)) return { type: 'playlist', id: key };

    // Also accept raw playlist ids.
    if (/^[a-zA-Z0-9_-]{4,}$/.test(key)) return { type: 'playlist', id: key };

    return { type: 'unknown', raw: folderId };
  }

  private buildRootFolder(offset: number): ContentFolder {
    // Keep this aligned with Spotify root ids so the Loxone client can navigate using numeric ids.
    return {
      id: 'root',
      name: this.displayLabel,
      service: 'ytmusic',
      start: offset,
      totalitems: 6,
      items: [
        this.folderLink('playlists', 'Playlists'),
        this.folderLink('albums', 'Albums'),
        this.folderLink('artists', 'Artists'),
        this.folderLink('popular', 'Popular'),
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
      provider: 'ytmusic',
    };
  }

  private makeUri(type: 'track' | 'playlist' | 'album' | 'artist', id: string): string {
    return `${this.audiopathPrefix}:${type}:${id}`;
  }

  private pickThumb(value: any): string {
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

  private async fetchTracksFromBrowse(browseUrl: string, offset: number, limit: number): Promise<ContentFolderItem[]> {
    const cookieFile = await this.ensureCookieFile();
    try {
      const args = [
        '-j',
        '--js-runtimes',
        'node',
        '--flat-playlist',
        '--no-warnings',
        '--skip-download',
        '--playlist-start',
        String(offset + 1),
        '--playlist-end',
        String(offset + limit),
        ...this.buildCookieArgs(cookieFile),
        browseUrl,
      ];
      const entries = await runYtDlpJsonLines(args, this.execOptions());
      return entries
        .map((e: any) => this.mapEntryToTrack(e))
        .filter(Boolean) as ContentFolderItem[];
    } catch (err) {
      if (err instanceof YtDlpError) {
        this.log.debug('ytmusic browse fetch failed (yt-dlp)', {
          providerId: this.providerId,
          browseUrl,
          stderr: err.stderr || undefined,
        });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.debug('ytmusic browse fetch failed', { providerId: this.providerId, browseUrl, message: msg });
      }
      return [];
    } finally {
      // Keep cookie file around for reuse.
    }
  }

  private async fetchTrackSearchResults(opts: { query: string; offset: number; limit: number }): Promise<ContentFolderItem[]> {
    const cookieFile = await this.ensureCookieFile();
    try {
      const url = buildYtMusicSearchUrl(opts.query);
      // Overfetch a bit to compensate for non-track items that get filtered out.
      // Use playlist-start to avoid fetching the full first N pages when paging.
      const overfetchFactor = 4;
      const rawStart = Math.max(1, opts.offset + 1);
      const rawEnd = Math.max(rawStart, opts.offset + Math.max(1, opts.limit) * overfetchFactor);
      const args = [
        '-j',
        '--js-runtimes',
        'node',
        '--flat-playlist',
        '--no-warnings',
        '--skip-download',
        '--playlist-start',
        String(rawStart),
        '--playlist-end',
        String(rawEnd),
        ...this.buildCookieArgs(cookieFile),
        url,
      ];
      const entries = await runYtDlpJsonLines(args, this.execOptions());
      const tracks = entries
        .map((e: any) => this.mapEntryToTrack(e))
        .filter(Boolean) as ContentFolderItem[];
      return tracks.slice(0, opts.limit);
    } catch (err) {
      // This one used to log only `err.message`, which for a yt-dlp that never ran said
      // nothing a user could act on. Keep it at warn — an unusable folder is not a detail —
      // and carry yt-dlp's own words with it.
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('ytmusic track search failed', {
        providerId: this.providerId,
        query: opts.query,
        message: msg,
        ...(err instanceof YtDlpError && err.stderr ? { stderr: err.stderr.slice(0, 500) } : {}),
      });
      return [];
    } finally {
      // Keep cookie file around for reuse.
    }
  }

  private mapSearchEntryToTrack(entry: any): ContentFolderItem | null {
    return this.mapEntryToTrack(entry);
  }

  private mapEntryToTrack(entry: any): ContentFolderItem | null {
    const id = String(entry?.id ?? '');
    const url =
      (typeof entry?.url === 'string' ? entry.url : '') ||
      (typeof entry?.webpage_url === 'string' ? entry.webpage_url : '') ||
      '';
    const rawTitle = entry?.title ?? entry?.fulltitle ?? '';
    const title = String(rawTitle ?? '').trim();
    const duration = typeof entry?.duration === 'number' ? Math.round(entry.duration) : undefined;
    const videoId = extractVideoId(url || id);
    if (!videoId) return null;
    if (!title) return null;
    const thumb = this.pickThumb(entry) || fallbackVideoThumb(videoId);
    const audiopath = this.makeUri('track', videoId);
    return {
      id: audiopath,
      audiopath,
      name: title,
      title,
      artist: String(entry?.channel ?? entry?.uploader ?? '').trim(),
      album: '',
      coverurl: thumb,
      thumbnail: thumb,
      type: FileType.File,
      tag: 'track',
      duration,
      hasCover: !!thumb,
      provider: 'ytmusic',
    };
  }

  private mapVideoToTrack(data: any): ContentFolderItem {
    const id = String(data?.id ?? '');
    const title = String(data?.title ?? id);
    const duration = typeof data?.duration === 'number' ? Math.round(data.duration) : undefined;
    const thumb = (typeof data?.thumbnail === 'string' ? data.thumbnail : '') || fallbackVideoThumb(id);
    const uploader = String(data?.uploader ?? data?.channel ?? '');
    const audiopath = `${this.audiopathPrefix}:track:${id}`;
    return {
      id: audiopath,
      audiopath,
      name: title,
      title,
      artist: uploader,
      album: '',
      coverurl: thumb,
      thumbnail: thumb,
      type: FileType.File,
      tag: 'track',
      duration,
      hasCover: !!thumb,
      provider: 'ytmusic',
    };
  }

  private hasCookie(): boolean {
    return typeof this.bridge?.ytmusicCookie === 'string' && this.bridge.ytmusicCookie.trim().length > 0;
  }

  /**
   * Every browse that spends the cookie, with the verdict on that cookie recorded.
   *
   * The library fetchers each swallow their failure and return an empty list, which
   * is right for a section that could not load but wrong as the *only* trace of an
   * expired cookie — an empty library is what the user sees either way. Recording it
   * in one place here is what lets the setup screen say which of the two it is.
   */
  private async browseAuthed(
    browseId: string,
    options: YtMusicInnertubeClientOptions,
    continuation?: YtMusicContinuation | null,
  ): Promise<any> {
    try {
      const json = await this.browse(browseId, options, continuation);
      recordYtMusicAuth(this.bridge.id, 'ok');
      return json;
    } catch (err) {
      if (err instanceof YtMusicCookieExpiredError) {
        recordYtMusicAuth(this.bridge.id, 'expired');
      }
      throw err;
    }
  }

  private warnMissingCookieOnce(): void {
    recordYtMusicAuth(this.bridge.id, 'missing');
    if (this.missingCookieWarned) return;
    this.missingCookieWarned = true;
    this.log.warn('ytmusic not configured; missing cookie', { providerId: this.providerId });
  }

  /**
   * Every page of a browse result, not just the first.
   *
   * YouTube Music answers a library section with 25 items and a token for the rest,
   * which was the whole of issue #369: one browse looked like a complete library, and
   * reporting its length as the total told every client it had seen everything.
   *
   * The token hangs off the shelf that holds the items, never off the items, so it has
   * to be read from the enclosing renderer — and it is matched to `itemKey` because a
   * page can carry several shelves. An album page has a "more from this artist"
   * carousel with a token of its own, and following that one would append unrelated
   * rows to a track list.
   */
  private async browseAllRows(
    browseId: string,
    itemKey: 'musicTwoRowItemRenderer' | 'musicResponsiveListItemRenderer',
  ): Promise<any[]> {
    const options: YtMusicInnertubeClientOptions = { cookie: this.bridge.ytmusicCookie!, hl: 'en' };
    const first = await this.browseAuthed(browseId, options);
    const rows = extractRenderers(first, itemKey);
    let continuation = findShelfContinuation(first, itemKey);
    const spent = new Set<string>();
    let pages = 0;

    while (continuation) {
      if (pages >= CONTINUATION_PAGE_CAP) {
        this.log.warn('ytmusic paging hit the page cap; some items are not listed', {
          providerId: this.providerId,
          browseId,
          rows: rows.length,
        });
        break;
      }
      // A token handed back unchanged would page forever.
      if (spent.has(continuation.token)) break;
      spent.add(continuation.token);
      pages += 1;

      const response = await this.browseAuthed(browseId, options, continuation);
      const page = continuationPayload(response);
      if (!page) break;
      const next = extractRenderers(page, itemKey);
      if (!next.length) break;
      rows.push(...next);
      continuation = findShelfContinuation(page, itemKey);
    }

    return rows;
  }

  private async fetchLibraryAlbums(): Promise<ContentFolderItem[]> {
    if (!this.hasCookie()) {
      this.warnMissingCookieOnce();
      return [];
    }
    const cached = this.libraryCache.albums;
    if (cached && Date.now() - cached.fetchedAt < this.libraryCacheTtlMs) {
      return cached.items;
    }
    try {
      const rows = await this.browseAllRows('FEmusic_liked_albums', 'musicTwoRowItemRenderer');
      const items = rows
        .map((r) => {
          const browseId = r?.navigationEndpoint?.browseEndpoint?.browseId;
          if (typeof browseId !== 'string' || !browseId) return null;
          if (!isAlbumBrowseId(browseId)) return null;
          const title = extractText(r?.title);
          const thumb = pickThumbFromTwoRow(r);
          return {
            id: this.makeUri('album', browseId),
            audiopath: this.makeUri('album', browseId),
            name: title || 'Album',
            title: title || 'Album',
            coverurl: thumb,
            thumbnail: thumb,
            type: FileType.PlaylistBrowsable,
            tag: 'album',
            provider: 'ytmusic',
            hasCover: !!thumb,
          } satisfies ContentFolderItem;
        })
        .filter(Boolean) as ContentFolderItem[];
      const deduped = dedupeById(items);
      this.libraryCache.albums = { items: deduped, fetchedAt: Date.now() };
      return deduped;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('ytmusic library albums fetch failed', { providerId: this.providerId, message: msg });
      return [];
    }
  }

  private async fetchLibraryPlaylists(): Promise<ContentFolderItem[]> {
    if (!this.hasCookie()) {
      this.warnMissingCookieOnce();
      return [];
    }
    const cached = this.libraryCache.playlists;
    if (cached && Date.now() - cached.fetchedAt < this.libraryCacheTtlMs) {
      return cached.items;
    }
    try {
      const rows = await this.browseAllRows('FEmusic_liked_playlists', 'musicTwoRowItemRenderer');
      const items: ContentFolderItem[] = [];
      for (const r of rows) {
        const browseId = r?.navigationEndpoint?.browseEndpoint?.browseId;
        const title = extractText(r?.title);
        if (!browseId || !title) continue;
        if (String(browseId).toUpperCase() === 'VLLM') continue; // exposed explicitly as a folder
        if (!isBrowseLikePlaylistId(String(browseId))) continue;
        const thumb = pickThumbFromTwoRow(r);
        items.push({
          id: this.makeUri('playlist', browseId),
          audiopath: this.makeUri('playlist', browseId),
          name: title,
          title,
          coverurl: thumb,
          thumbnail: thumb,
          type: FileType.PlaylistBrowsable,
          tag: 'playlist',
          provider: 'ytmusic',
          hasCover: !!thumb,
        });
      }
      const deduped = dedupeById(items);
      this.libraryCache.playlists = { items: deduped, fetchedAt: Date.now() };
      return deduped;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('ytmusic library playlists fetch failed', { providerId: this.providerId, message: msg });
      return [];
    }
  }

  private async fetchLibraryArtists(): Promise<ContentFolderItem[]> {
    if (!this.hasCookie()) {
      this.warnMissingCookieOnce();
      return [];
    }
    const cached = this.libraryCache.artists;
    if (cached && Date.now() - cached.fetchedAt < this.libraryCacheTtlMs) {
      return cached.items;
    }
    try {
      const listItems = await this.browseAllRows(
        'FEmusic_library_corpus_track_artists',
        'musicResponsiveListItemRenderer',
      );
      const out: ContentFolderItem[] = [];
      for (const it of listItems) {
        const browseId = it?.navigationEndpoint?.browseEndpoint?.browseId;
        if (typeof browseId !== 'string' || !browseId) continue;
        if (!isArtistBrowseId(browseId)) continue;
        const title = extractText(it?.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text);
        if (!title) continue;
        const thumb = pickThumbFromResponsive(it);
        out.push({
          id: this.makeUri('artist', browseId),
          audiopath: this.makeUri('artist', browseId),
          name: title,
          title,
          artist: title,
          coverurl: thumb,
          thumbnail: thumb,
          type: FileType.PlaylistBrowsable,
          tag: 'artist',
          provider: 'ytmusic',
          hasCover: !!thumb,
        });
      }
      const deduped = dedupeById(out);
      this.libraryCache.artists = { items: deduped, fetchedAt: Date.now() };
      return deduped;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('ytmusic library artists fetch failed', { providerId: this.providerId, message: msg });
      return [];
    }
  }

  private async fetchAlbumTracksFromInnertube(albumBrowseId: string, offset: number, limit: number): Promise<ContentFolderItem[]> {
    if (!this.hasCookie()) {
      return [];
    }
    const cached = this.albumTracksCache.get(albumBrowseId);
    if (cached && Date.now() - cached.fetchedAt < this.libraryCacheTtlMs) {
      return cached.items.slice(offset, offset + limit);
    }
    try {
      const listItems = await this.browseAllRows(albumBrowseId, 'musicResponsiveListItemRenderer');
      const tracks = listItems
        .map((it) => mapResponsiveToTrack(this.audiopathPrefix, it))
        .filter(Boolean) as ContentFolderItem[];
      this.albumTracksCache.set(albumBrowseId, { items: tracks, fetchedAt: Date.now() });
      return tracks.slice(offset, offset + limit);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('ytmusic album tracks fetch failed', { providerId: this.providerId, albumBrowseId, message: msg });
      return [];
    }
  }

  private async fetchArtistTracksFromInnertube(artistBrowseId: string, offset: number, limit: number): Promise<ContentFolderItem[]> {
    if (!this.hasCookie()) {
      return [];
    }
    const cached = this.artistTracksCache.get(artistBrowseId);
    if (cached && Date.now() - cached.fetchedAt < this.libraryCacheTtlMs) {
      return cached.items.slice(offset, offset + limit);
    }
    try {
      // Deliberately a single page, unlike the library listings and album tracks. An
      // artist page is not a list that continues; it is a set of shelves, and the songs
      // shelf is a top-5 whose "more" is a separate playlist rather than a next page.
      const json = await this.browseAuthed(artistBrowseId, { cookie: this.bridge.ytmusicCookie!, hl: 'en' });
      const listItems = extractResponsiveListItems(json);
      const tracks = listItems
        .map((it) => mapResponsiveToTrack(this.audiopathPrefix, it))
        .filter(Boolean) as ContentFolderItem[];
      this.artistTracksCache.set(artistBrowseId, { items: tracks, fetchedAt: Date.now() });
      return tracks.slice(offset, offset + limit);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('ytmusic artist tracks fetch failed', { providerId: this.providerId, artistBrowseId, message: msg });
      return [];
    }
  }
}

function extractText(value: any): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value.simpleText === 'string') return value.simpleText;
  if (Array.isArray(value.runs)) return value.runs.map((r: any) => String(r?.text ?? '')).join('');
  return '';
}

function pickThumbFromTwoRow(renderer: any): string {
  const thumbs = renderer?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails;
  if (!Array.isArray(thumbs) || !thumbs.length) return '';
  const last = thumbs[thumbs.length - 1];
  return typeof last?.url === 'string' ? last.url : '';
}

function pickThumbFromResponsive(renderer: any): string {
  const thumbs = renderer?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails;
  if (!Array.isArray(thumbs) || !thumbs.length) return '';
  const last = thumbs[thumbs.length - 1];
  return typeof last?.url === 'string' ? last.url : '';
}

/**
 * How many extra pages a single listing may walk.
 *
 * At 25 items a page this is a library of a thousand, which is far past anything
 * seen in practice and still a bound: a token that keeps renewing must not turn one
 * folder request into an unbounded run of calls to YouTube.
 */
const CONTINUATION_PAGE_CAP = 40;

function extractRenderers(json: any, key: string): any[] {
  const out: any[] = [];
  const walk = (v: any) => {
    if (!v) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (typeof v !== 'object') return;
    if (v[key]) out.push(v[key]);
    for (const k of Object.keys(v)) walk(v[k]);
  };
  walk(json);
  return out;
}

function extractResponsiveListItems(json: any): any[] {
  return extractRenderers(json, 'musicResponsiveListItemRenderer');
}

/** The rows a shelf renderer holds, under whichever of the two names it uses. */
function shelfRows(v: any): any[] | null {
  if (Array.isArray(v?.contents)) return v.contents;
  if (Array.isArray(v?.items)) return v.items;
  return null;
}

function tokenFromShelf(shelf: any, rows: any[]): YtMusicContinuation | null {
  const legacy = shelf?.continuations?.[0]?.nextContinuationData?.continuation;
  if (typeof legacy === 'string' && legacy) return { token: legacy, style: 'query' };
  for (const row of rows) {
    const token = row?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
    if (typeof token === 'string' && token) return { token, style: 'body' };
  }
  return null;
}

/**
 * The token for the next page of the shelf that holds `itemKey` rows.
 *
 * Scoped to that shelf rather than to the whole response because a browse can answer
 * with several, each with its own token; taking the first token found would page a
 * carousel into a track list.
 */
function findShelfContinuation(json: any, itemKey: string): YtMusicContinuation | null {
  let found: YtMusicContinuation | null = null;
  const walk = (v: any) => {
    if (found || !v) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (typeof v !== 'object') return;
    const rows = shelfRows(v);
    if (rows && rows.some((r) => r && typeof r === 'object' && r[itemKey])) {
      const token = tokenFromShelf(v, rows);
      if (token) {
        found = token;
        return;
      }
    }
    for (const k of Object.keys(v)) walk(v[k]);
  };
  walk(json);
  return found;
}

/** The part of a continuation response that carries the next page's rows. */
function continuationPayload(response: any): any | null {
  const contents = response?.continuationContents;
  if (contents && typeof contents === 'object') {
    // A single key, named after the shelf it continues: gridContinuation for the
    // album and playlist grids, musicShelfContinuation for the artist list.
    const shelf = Object.values(contents).find((v) => v && typeof v === 'object');
    if (shelf) return shelf;
  }
  const appended = response?.onResponseReceivedActions?.[0]?.appendContinuationItemsAction?.continuationItems;
  if (Array.isArray(appended)) return { contents: appended };
  return null;
}

/**
 * Drop repeats, keeping the first.
 *
 * Paging makes this worth doing: an item that sits on a page boundary while the
 * library is being reordered can arrive twice, and a duplicate folder entry is more
 * confusing than a missing one.
 */
function dedupeById(items: ContentFolderItem[]): ContentFolderItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function mapResponsiveToTrack(providerId: string, item: any): ContentFolderItem | null {
  const videoId =
    item?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId ??
    item?.navigationEndpoint?.watchEndpoint?.videoId ??
    null;
  if (typeof videoId !== 'string' || !videoId) return null;
  const cols = Array.isArray(item?.flexColumns) ? item.flexColumns : [];
  const title = extractText(cols[0]?.musicResponsiveListItemFlexColumnRenderer?.text);
  const artist = extractText(cols[1]?.musicResponsiveListItemFlexColumnRenderer?.text);
  const album = extractText(cols[2]?.musicResponsiveListItemFlexColumnRenderer?.text);
  const thumb = pickThumbFromResponsive(item) || fallbackVideoThumb(videoId);
  const audiopath = `${providerId}:track:${videoId}`;
  return {
    id: audiopath,
    audiopath,
    name: title || videoId,
    title: title || videoId,
    artist,
    album,
    coverurl: thumb,
    thumbnail: thumb,
    type: FileType.File,
    tag: 'track',
    hasCover: !!thumb,
    provider: 'ytmusic',
  };
}

function isBrowseLikePlaylistId(id: string): boolean {
  const v = String(id || '').trim();
  if (!v) return false;
  // VLLM, VLSE, VLR..., etc.
  if (v.toUpperCase().startsWith('VL')) return true;
  return false;
}

function fallbackVideoThumb(videoId: string): string {
  const id = String(videoId || '').trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) return '';
  // Works for most YT/YTMusic items; avoids extra lookups when browsing with `--flat-playlist`.
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

function isAlbumBrowseId(id: string): boolean {
  const v = String(id || '').trim();
  if (!v) return false;
  // YouTube Music album browseIds typically start with MPRE (e.g. MPREb_...).
  if (/^MPRE/i.test(v)) return true;
  return false;
}

function isArtistBrowseId(id: string): boolean {
  const v = String(id || '').trim();
  if (!v) return false;
  // YouTube channel IDs (artists) usually start with UC.
  if (/^UC[a-zA-Z0-9_-]{10,}$/.test(v)) return true;
  // YouTube Music library artist browseIds (e.g. MPLAUC...).
  if (/^MPLA/i.test(v)) return true;
  return false;
}

// no file cleanup helpers; /tmp is owned by the container
