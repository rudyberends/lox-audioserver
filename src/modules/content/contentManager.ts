import { getConfig, loadConfig as loadStoredConfig } from '@/domain/config/configStore';
import type {
  ContentFolder,
  ContentFolderItem,
  ContentItemMetadata,
  ContentServiceEntry,
  PlaylistEntry,
  RadioMenuEntry,
  ScanStatus,
} from '@/modules/content/types';
import { decodeAudiopath, detectServiceFromAudiopath } from '@/modules/audio/utils/audiopath';
import { LocalLibraryProvider, type LibraryCoverSample, type LibraryStats } from '@/modules/content/providers/localLibraryProvider';
import { TuneInProvider, type TuneInProviderOptions } from '@/modules/content/providers/tunein/tuneinProvider';
import {
  SpotifyServiceManager,
  getSharedSpotifyManager,
  reloadSharedSpotifyManager,
} from '@/modules/content/providers/spotifyServiceManager';
import { ContentCacheManager } from '@/modules/content/utils/contentCacheManager';
import type { StorageConfig } from '@/modules/content/storage/storageManager';
import {
  addStorage,
  deleteStorage,
  listStorages,
} from '@/modules/content/storage/storageManager';
import { parseSearchLimits } from '@/modules/content/utils/searchLimits';
import { createLogger } from '@/core/logging/logger';

const AVAILABLE_SERVICES = [
  {
    cmd: 'spotify',
    config: [
      {
        name: 'Username',
        regex: '%5B%5E%3C%3E%26%25%5C%5C%2F\'%5D%7B3%2C99%7D%24', // legacy-safe regex from Loxone
        type: 'text',
      },
      {
        link: 'https://www.spotify.com/legal/end-user-agreement',
        name: 'EULA',
        type: 'eula',
      },
    ],
    helplink: 'http://www.loxone.com/help/musicserver-spotify',
    icon: 'https://extended-app-content.s3.eu-central-1.amazonaws.com/audioZone/services/Icon-Spotify.svg',
    name: 'Spotify',
    registerlink: 'https://www.spotify.com/signup',
  },
];

export class ContentManager {
  private readonly log = createLogger('Content', 'Manager');
  private spotify: SpotifyServiceManager = getSharedSpotifyManager();
  private readonly library = new LocalLibraryProvider();
  private tunein = new TuneInProvider();
  private readonly cache = new ContentCacheManager();
  private initialized = false;

  /**
   * Ensures the manager is wired to the persisted configuration before use.
   */
  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await loadStoredConfig();
    this.refreshFromConfig();
    await this.library.initialize();
    this.initialized = true;
  }

  /**
   * Forces a re-run of initialization so config/provider state can be rebuilt without
   * restarting the process.
   */
  public async reinitialize(): Promise<void> {
    this.initialized = false;
    await this.initialize();
  }

  /**
   * Rebuilds provider adapters after config changes (setconfig).
   */
  public refreshFromConfig(): void {
    this.cache.clearAll();
    this.spotify = reloadSharedSpotifyManager();
    this.tunein = new TuneInProvider(this.readTuneInConfig());
  }

  public getAvailableServices() {
    return AVAILABLE_SERVICES;
  }

  public getServices(): ContentServiceEntry[] {
    return this.spotify.listServiceEntries() as unknown as ContentServiceEntry[];
  }

  /**
   * Resolve a service provider by id (currently only spotify) for follow-state operations.
   */
  public resolveServiceProvider(service: string, user?: string) {
    if (!service && !user) {
      return null;
    }
    if (service && this.spotify.hasProvider(service)) {
      return this.spotify;
    }
    if (user && this.spotify.hasProvider(user)) {
      return this.spotify;
    }
    return null;
  }

  public getDefaultSpotifyAccountId(): string | null {
    return this.spotify.getDefaultAccountId();
  }

  public getMediaFolder(
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    return this.library.getMediaFolder(folderId || 'root', offset, limit);
  }

  public getRadios(): Promise<RadioMenuEntry[]> {
    return this.tunein.getMenuEntries();
  }

  public getPlaylists(
    service: string,
    user: string,
    offset: number,
    limit: number,
  ): Promise<PlaylistEntry[]> {
    return this.spotify.getPlaylists(service, user, offset, limit);
  }

  public async getServiceFolder(
    service: string,
    user: string,
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    // cache only browse-like folders; tunein is cheap enough to skip
    const cacheKey = this.cache.key(service, user, folderId, offset, limit);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.log.debug('content cache hit', { service, user, folderId, offset, limit });
      // refresh in background
      void this.cache.refresh(cacheKey, () => this.fetchServiceFolder(service, user, folderId, offset, limit));
      return cached;
    }
    this.log.debug('content cache miss', { service, user, folderId, offset, limit });
    return this.cache.refresh(cacheKey, () => this.fetchServiceFolder(service, user, folderId, offset, limit));
  }

  private async fetchServiceFolder(
    service: string,
    user: string,
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    if (service === 'local' || service === 'custom') {
      return this.tunein.getFolder(service, folderId, offset, limit);
    }
    return this.spotify.getFolder(service, user, folderId, offset, limit);
  }

  public getServiceTrack(
    service: string,
    user: string,
    trackId: string,
  ): Promise<ContentFolderItem | null> {
    return this.spotify.getTrack(service, user, trackId);
  }

  public rescanLibrary(): Promise<void> {
    return this.library.rescan();
  }

  public getScanStatus(): ScanStatus {
    return this.library.getScanStatus();
  }

  public getLibraryStats(): LibraryStats | null {
    return this.library.getLibraryStats();
  }

  public getLibraryCoverSamples(limit: number): LibraryCoverSample[] {
    return this.library.getCoverSamples(limit);
  }

  public uploadLibraryAudio(relativePath: string, base64Data: string): Promise<{ relPath: string; filename: string }> {
    return this.library.uploadLocalAudio(relativePath, base64Data);
  }

  public getGlobalSearchDescription(): Record<string, string[]> {
    const desc: Record<string, string[]> = {};
    const providerTypes = new Set<string>();
    for (const account of this.spotify.listAccounts()) {
      if (account.fake) {
        providerTypes.add('spotify');
        continue;
      }
      if (account.provider) {
        providerTypes.add(account.provider.toLowerCase());
      }
    }
    if (providerTypes.size === 0) {
      providerTypes.add('spotify');
    }

    for (const provider of providerTypes) {
      desc[provider] = ['track', 'album', 'artist', 'playlist', 'episode', 'show'];
    }
    desc.local = ['track', 'album', 'artist', 'playlist', 'folder'];
    desc.tunein = ['station', 'custom'];
    return desc;
  }

  public async globalSearch(
    source: string,
    query: string,
  ): Promise<{ result: Record<string, ContentFolderItem[]>; user: string; providerId: string }> {
    // Spotify search (supports multiple accounts)
    const [providerPart, filterPart = ''] = source.split(':');
    const { limits } = parseSearchLimits(filterPart);
    const [providerIdRaw, userRaw = ''] = providerPart.split('@');
    const providerCandidate = providerPart || providerIdRaw || '';
    if (this.spotify.hasProvider(providerCandidate)) {
      const { result, user, providerId } = await this.spotify.search(source, query);
      return { result, user, providerId };
    }

    // Local library search
    const providerId = providerIdRaw || 'local';
    if (providerId.toLowerCase() === 'local' || providerId.toLowerCase() === 'library') {
      const result = this.library.search(query, limits);
      return { result, user: 'local', providerId: 'local' };
    }

    // TuneIn (radio) search
    const tuneinProviderId = providerIdRaw || 'tunein';
    if (tuneinProviderId.toLowerCase() === 'tunein' || tuneinProviderId.toLowerCase() === 'radio') {
      const { station, custom } = await this.tunein.search(query, {
        station: limits.station,
        custom: limits.custom,
      });
      return {
        result: { station, custom },
        user: userRaw || 'nouser',
        providerId: 'tunein',
      };
    }

    const user = source.split('@')[1]?.split(':')[0] ?? 'nouser';
    const fallbackProviderId = providerIdRaw || providerCandidate || 'unknown';
    return { result: {}, user, providerId: fallbackProviderId };
  }

  public async resolveMetadata(audiopath: string): Promise<ContentItemMetadata | null> {
    const decodedPath = decodeAudiopath(audiopath);
    const detectedService = detectServiceFromAudiopath(audiopath);

    // Music Assistant bridge items: try to resolve via bridge provider (stored under spotify manager).
    if (detectedService === 'musicassistant') {
      const providerSegment = (audiopath.split(':')[0] ?? '').trim();
      const accounts = this.spotify.listAccounts();
      const bridgeAccount =
        accounts.find((acc) => acc.provider === 'musicassistant' && acc.id === providerSegment) ??
        accounts.find((acc) => acc.provider === 'musicassistant');
      const providerId =
        ((providerSegment && this.spotify.hasProvider(providerSegment) ? providerSegment : null) ??
          bridgeAccount?.id ??
          providerSegment) ||
        'musicassistant';
      const userId = providerId.split('@')[1] ?? providerSegment.split('@')[1] ?? 'musicassistant';
      const parts = audiopath.split(':');
      const maybeId = parts[parts.length - 1] ?? audiopath;
      const candidates = new Set<string>();
      if (maybeId) {
        candidates.add(maybeId);
      }
      if (decodedPath && !decodedPath.startsWith('b64_')) {
        try {
          const b64 = Buffer.from(decodedPath, 'utf-8').toString('base64');
          candidates.add(`b64_${b64}`);
        } catch {
          /* ignore */
        }
      }
      for (const trackId of candidates) {
        const track = await this.spotify.getTrack(providerId, userId, trackId);
        if (track) {
          return {
            title: track.title ?? track.name ?? '',
            artist: track.artist ?? '',
            album: track.album ?? '',
            coverurl: track.coverurl ?? '',
            duration: typeof track.duration === 'number' ? Math.round(track.duration) : undefined,
          };
        }
      }
    }

    if (detectedService === 'applemusic') {
      const providerSegment = (audiopath.split(':')[0] ?? '').trim();
      const trackMatch = audiopath.match(/^([^:]+):(library-)?track:(.+)$/i);
      if (trackMatch) {
        const isLibrary = Boolean(trackMatch[2]);
        const rawId = trackMatch[3] ?? '';
        let trackId = rawId;
        if (rawId.startsWith('b64_')) {
          try {
            trackId = Buffer.from(rawId.slice(4), 'base64').toString('utf-8');
          } catch {
            trackId = rawId;
          }
        }
        const providerId = providerSegment || 'applemusic';
        const track = await this.getServiceTrack(
          providerId,
          providerId.split('@')[1] ?? '',
          `${isLibrary ? 'library-' : ''}track:${trackId}`,
        );
        if (track) {
          return {
            title: track.title ?? track.name ?? '',
            artist: track.artist ?? '',
            album: track.album ?? '',
            coverurl: track.coverurl ?? '',
            duration: typeof track.duration === 'number' ? Math.round(track.duration) : undefined,
          };
        }
        this.log.debug('apple music metadata unresolved', {
          audiopath,
          providerId,
          trackId,
          isLibrary,
        });
      }
    }

    if (detectedService === 'deezer') {
      const providerSegment = (audiopath.split(':')[0] ?? '').trim();
      const trackMatch = audiopath.match(/^([^:]+):track:(.+)$/i);
      if (trackMatch) {
        const rawId = trackMatch[2] ?? '';
        const providerId = providerSegment || 'deezer';
        const track = await this.getServiceTrack(
          providerId,
          providerId.split('@')[1] ?? '',
          `track:${rawId}`,
        );
        if (track) {
          return {
            title: track.title ?? track.name ?? '',
            artist: track.artist ?? '',
            album: track.album ?? '',
            coverurl: track.coverurl ?? '',
            duration: typeof track.duration === 'number' ? Math.round(track.duration) : undefined,
          };
        }
        this.log.debug('deezer metadata unresolved', {
          audiopath,
          providerId,
          trackId: rawId,
        });
      }
    }

    if (detectedService === 'tidal') {
      const providerSegment = (audiopath.split(':')[0] ?? '').trim();
      const trackMatch = audiopath.match(/^([^:]+):track:(.+)$/i);
      if (trackMatch) {
        const rawId = trackMatch[2] ?? '';
        const providerId = providerSegment || 'tidal';
        const track = await this.getServiceTrack(
          providerId,
          providerId.split('@')[1] ?? '',
          `track:${rawId}`,
        );
        if (track) {
          return {
            title: track.title ?? track.name ?? '',
            artist: track.artist ?? '',
            album: track.album ?? '',
            coverurl: track.coverurl ?? '',
            duration: typeof track.duration === 'number' ? Math.round(track.duration) : undefined,
          };
        }
        this.log.debug('tidal metadata unresolved', {
          audiopath,
          providerId,
          trackId: rawId,
        });
      }
    }

    if (audiopath.startsWith('library:')) {
      return this.library.resolveItem(audiopath);
    }

    const httpCandidate =
      /^https?:\/\//i.test(audiopath) ? audiopath : /^https?:\/\//i.test(decodedPath) ? decodedPath : '';
    if (httpCandidate) {
      const station = await this.tunein.resolveStationByStream(httpCandidate);
      if (station) {
        return {
          title: station.name || '',
          artist: '',
          album: '',
          coverurl: station.coverurl ?? '',
          station: station.name || '',
        };
      }
    }

    const normalized = audiopath.trim();
    const trackMatch = normalized.match(/^([^:]+):track:(.+)$/i);
    if (trackMatch) {
      const providerSegment = trackMatch[1];
      const trackId = trackMatch[2];
      const [provider, user = ''] = providerSegment.split('@');
      const serviceId = this.spotify.hasProvider(providerSegment)
        ? providerSegment
        : provider;
      if (this.spotify.hasProvider(serviceId)) {
        const track = await this.getServiceTrack(serviceId, user, trackId);
        if (track) {
          return {
            title: track.title ?? track.name ?? '',
            artist: track.artist ?? '',
            album: track.album ?? '',
            coverurl: track.coverurl ?? '',
            duration: typeof track.duration === 'number' ? Math.round(track.duration) : undefined,
          };
        }
      }
    }

    return null;
  }

  public listStorages(): Promise<StorageConfig[]> {
    return listStorages();
  }

  public async addStorage(config: Omit<StorageConfig, 'id'> & { id?: string }): Promise<StorageConfig> {
    return addStorage(config);
  }

  public async deleteStorage(id: string): Promise<void> {
    await deleteStorage(id);
  }

  private readTuneInConfig(): TuneInProviderOptions {
    try {
      const cfg = getConfig();
      const username = cfg.content?.radio?.tuneInUsername;
      return {
        username: typeof username === 'string' && username.trim()
          ? username.trim()
          : undefined,
      };
    } catch {
      /* ignore */
    }
    return {};
  }
}

export const contentManager = new ContentManager();
