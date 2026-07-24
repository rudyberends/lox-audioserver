import type { ConfigPort } from '@/ports/ConfigPort';
import type {
  ContentFolder,
  ContentFolderItem,
  ContentItemMetadata,
  ContentServiceEntry,
  PlaylistEntry,
  RadioMenuEntry,
  ScanStatus,
} from '@/ports/ContentTypes';
import { decodeAudiopath, detectServiceFromAudiopath, metadataKeyVariants } from '@/domain/loxone/audiopath';
import {
  LocalLibraryProvider,
  type LibraryCoverSample,
  type LibraryDeleteResult,
  type LibraryStats,
} from '@/adapters/content/providers/localLibraryProvider';
import type { NotifierPort } from '@/ports/NotifierPort';
import { TuneInProvider, type TuneInProviderOptions } from '@/adapters/content/providers/tunein/tuneinProvider';
import { RadioParadiseProvider } from '@/adapters/content/providers/radioparadise/radioParadiseProvider';
import {
  SpotifyServiceManager,
  SpotifyServiceManagerProvider,
} from '@/adapters/content/providers/spotifyServiceManager';
import { ContentCacheManager } from '@/adapters/content/utils/contentCacheManager';
import type { StorageConfig } from '@/adapters/content/storage/storageManager';
import {
  addStorage,
  deleteStorage,
  listStorages,
} from '@/adapters/content/storage/storageManager';
import { parseSearchLimits } from '@/adapters/content/utils/searchLimits';
import { createLogger } from '@/shared/logging/logger';
import type { CustomRadioStore } from '@/adapters/content/providers/customRadioStore';

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
  private spotify: SpotifyServiceManager | null = null;
  private readonly spotifyManagerProvider: SpotifyServiceManagerProvider;
  private readonly library: LocalLibraryProvider;
  private tunein: TuneInProvider;
  private radioParadise: RadioParadiseProvider;
  private readonly cache = new ContentCacheManager();
  private readonly globalSearchCache = new Map<
    string,
    {
      expiresAt: number;
      value: { result: Record<string, ContentFolderItem[]>; user: string; providerId: string };
    }
  >();

  private readonly globalSearchInflight = new Map<
    string,
    Promise<{ result: Record<string, ContentFolderItem[]>; user: string; providerId: string }>
  >();

  private readonly globalSearchTtlMs = 10_000;
  private readonly globalSearchNegativeTtlMs = 2_000;
  private readonly metadataCache = new Map<string, { expiresAt: number; value: ContentItemMetadata | null }>();
  private readonly metadataInflight = new Map<string, Promise<ContentItemMetadata | null>>();
  private readonly metadataTtlMs = 5 * 60 * 1000;
  private readonly metadataNegativeTtlMs = 30 * 1000;
  // Metadata harvested from every served folder listing, keyed per
  // metadataKeyVariants(). Lets resolveMetadata() answer favourites/recents (and
  // the now-playing path) from the listing the player just browsed instead of a
  // second browse. Bounded LRU keyed by audiopath variant; entries share the
  // metadata TTL so a stale listing eventually re-resolves live.
  private readonly metadataByAudiopath = new Map<string, { expiresAt: number; value: ContentItemMetadata }>();
  private readonly metadataByAudiopathMax = 5000;
  private initialized = false;
  private readonly configPort: ConfigPort;
  private readonly customRadioStore: CustomRadioStore;

  constructor(
    notifier: NotifierPort,
    configPort: ConfigPort,
    spotifyManagerProvider: SpotifyServiceManagerProvider,
    customRadioStore: CustomRadioStore,
  ) {
    this.library = new LocalLibraryProvider(notifier, configPort);
    this.configPort = configPort;
    this.spotifyManagerProvider = spotifyManagerProvider;
    this.customRadioStore = customRadioStore;
    this.tunein = new TuneInProvider(this.customRadioStore, this.readTuneInConfig());
    this.radioParadise = new RadioParadiseProvider({ iconBaseUrl: this.readLocalIconBaseUrl() });
  }

  public setNotifier(notifier: NotifierPort): void {
    this.library.setNotifier(notifier);
  }

  /**
   * Ensures the manager is wired to the persisted configuration before use.
   */
  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.getConfigPort().load();
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
    this.globalSearchCache.clear();
    this.globalSearchInflight.clear();
    this.metadataCache.clear();
    this.metadataInflight.clear();
    this.metadataByAudiopath.clear();
    this.spotify = this.spotifyManagerProvider.reload();
    this.tunein = new TuneInProvider(this.customRadioStore, this.readTuneInConfig());
    this.radioParadise = new RadioParadiseProvider({ iconBaseUrl: this.readLocalIconBaseUrl() });
  }

  public getAvailableServices() {
    return AVAILABLE_SERVICES;
  }

  public getServices(): ContentServiceEntry[] {
    return this.requireSpotify().listServiceEntries() as unknown as ContentServiceEntry[];
  }

  /**
   * Resolve a service provider by id (currently only spotify) for follow-state operations.
   */
  public resolveServiceProvider(service: string, user?: string) {
    if (!service && !user) {
      return null;
    }
    const spotify = this.requireSpotify();
    if (service && spotify.hasProvider(service)) {
      return spotify;
    }
    if (user && spotify.hasProvider(user)) {
      return spotify;
    }
    return null;
  }

  public getDefaultSpotifyAccountId(): string | null {
    return this.requireSpotify().getDefaultAccountId();
  }

  public getMediaFolder(
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    const safeFolderId = folderId || 'root';
    const cacheKey = this.cache.key('media', 'local', safeFolderId, offset, limit);
    const fetcher = () =>
      this.library
        .getMediaFolder(safeFolderId, offset, limit)
        .then((folder) => this.harvestFolderMetadata(folder));
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.harvestFolderMetadata(cached);
      void this.cache.refresh(cacheKey, fetcher);
      return Promise.resolve(cached);
    }
    return this.cache.refresh(cacheKey, fetcher);
  }

  public async getRadios(): Promise<RadioMenuEntry[]> {
    // Radio Paradise now lives under the built-in Loxone Radio tile (the
    // `loxoneradio` service folder), so it is intentionally absent here.
    return this.tunein.getMenuEntries();
  }

  /** Add a manually-defined custom radio stream (native `audio/cfg/radios/add`). */
  public async addCustomRadio(
    name: string,
    stream: string,
    coverurl?: string,
  ): Promise<{ id: string; name: string; stream: string }> {
    const entry = await this.customRadioStore.add({ name, stream, coverurl: coverurl || undefined });
    return { id: entry.id, name: entry.name, stream: entry.stream };
  }

  /** Remove a custom radio stream by id (native `audio/cfg/radios/del`). */
  public async removeCustomRadio(id: string): Promise<boolean> {
    return this.customRadioStore.remove(id);
  }

  public getPlaylists(
    service: string,
    user: string,
    offset: number,
    limit: number,
  ): Promise<PlaylistEntry[]> {
    if (service === 'lms') {
      return this.library.listPlaylists(offset, limit);
    }
    return this.requireSpotify().getPlaylists(service, user, offset, limit);
  }

  // -- Local playlist editing -------------------------------------------------

  public createLocalPlaylist(name: string): PlaylistEntry {
    this.cache.clearAll();
    return this.library.createPlaylist(name);
  }

  public renameLocalPlaylist(id: number, name: string): PlaylistEntry | null {
    this.cache.clearAll();
    return this.library.renamePlaylist(id, name);
  }

  public deleteLocalPlaylist(id: number): boolean {
    this.cache.clearAll();
    return this.library.deletePlaylist(id);
  }

  public getLocalPlaylist(id: number): PlaylistEntry | null {
    return this.library.getPlaylist(id);
  }

  public async addItemsToLocalPlaylist(playlistId: number, rawId: string): Promise<number> {
    this.cache.clearAll();
    return this.library.addItemsToPlaylist(playlistId, rawId);
  }

  public removeLocalPlaylistItem(playlistId: number, position: number): boolean {
    this.cache.clearAll();
    return this.library.removePlaylistItem(playlistId, position);
  }

  public moveLocalPlaylistItem(playlistId: number, from: number, to: number): boolean {
    this.cache.clearAll();
    return this.library.movePlaylistItem(playlistId, from, to);
  }

  public getLocalPlaylistItems(
    playlistId: number,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    return this.library
      .getPlaylistItemsFolder(playlistId, offset, limit)
      .then((folder) => this.harvestFolderMetadata(folder));
  }

  public async getServiceFolder(
    service: string,
    user: string,
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    // Always fetch Spotify podcasts live: users expect immediate updates and
    // stale cache entries can mask empty/non-empty transitions.
    if (service === 'spotify' && this.isSpotifyPodcastsFolder(folderId)) {
      this.log.debug('content cache bypass', { service, user, folderId, offset, limit });
      return this.fetchServiceFolder(service, user, folderId, offset, limit);
    }

    // cache only browse-like folders; tunein is cheap enough to skip
    // For yt-dlp-backed providers, normalize the limit for offset=0 so the Loxone app
    // (limit=20) and queue builder (limit=50) share one cache entry — avoids a second
    // yt-dlp call per play. Other providers keep exact-limit caching.
    const isYtDlpService = service === 'youtube' || service === 'ytmusic';
    const effectiveLimit = isYtDlpService && offset === 0 ? Math.max(limit, 50) : limit;
    const cacheKey = this.cache.key(service, user, folderId, offset, effectiveLimit);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.log.debug('content cache hit', { service, user, folderId, offset, limit });
      this.harvestFolderMetadata(cached);
      void this.cache.refresh(cacheKey, () => this.fetchServiceFolder(service, user, folderId, offset, effectiveLimit));
      return cached;
    }
    this.log.debug('content cache miss', { service, user, folderId, offset, limit });
    return this.cache.refresh(cacheKey, () => this.fetchServiceFolder(service, user, folderId, offset, effectiveLimit));
  }

  private isSpotifyPodcastsFolder(folderId: string): boolean {
    const raw = String(folderId || '').trim().toLowerCase();
    if (!raw) {
      return false;
    }
    if (raw === '7' || raw === 'podcasts' || raw === 'podcast') {
      return true;
    }
    if (raw.includes('liked')) {
      return false;
    }
    if (raw.includes('podcasts') || raw.includes('show')) {
      return true;
    }
    return false;
  }

  private async fetchServiceFolder(
    service: string,
    user: string,
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    let folder: ContentFolder | null;
    if (service === 'local' || service === 'custom') {
      folder = await this.tunein.getFolder(service, folderId, offset, limit);
    } else if (service.toLowerCase() === 'radioparadise') {
      folder = await this.radioParadise.getFolder(folderId, offset, limit);
    } else if (service.toLowerCase() === 'loxoneradio') {
      // The V17 client ships a built-in Loxone Radio tile and browses it via
      // getservicefolder/loxoneradio. Loxone's own streams are gated behind an mTLS
      // device certificate a software audioserver can't present, so instead of leaving
      // the tile empty (which makes the app error out) we surface the Radio Paradise
      // stations here. Their audiopath stays `radioparadise:<id>`, so playback and
      // metadata resolution are unaffected by which folder listed them.
      folder = await this.radioParadise.getFolder(folderId === 'root' ? 'start' : folderId, offset, limit);
    } else {
      folder = await this.requireSpotify().getFolder(service, user, folderId, offset, limit);
    }
    return this.harvestFolderMetadata(folder);
  }

  /**
   * Indexes every item of a served folder into the harvested-metadata cache so a
   * later resolveMetadata(<item audiopath>) is a cache hit rather than a second
   * browse. Returns the folder untouched for chaining onto fetchers.
   */
  private harvestFolderMetadata(folder: ContentFolder | null): ContentFolder | null {
    if (folder?.items?.length) {
      for (const item of folder.items) {
        this.storeHarvestedItem(item);
      }
    }
    return folder;
  }

  private storeHarvestedItem(item: ContentFolderItem): void {
    const audiopath = (item.audiopath ?? '').trim();
    if (!audiopath) {
      return;
    }
    // Leave radio/stream items to the live tunein path: it sets the `station`
    // field that a harvested metadata entry can't carry.
    if (detectServiceFromAudiopath(audiopath) === 'radio' || /^https?:\/\//i.test(audiopath)) {
      return;
    }
    const title = (item.title || item.name || '').trim();
    // A title-less entry is useless and could mask a richer live resolve; skip it.
    if (!title) {
      return;
    }
    const value: ContentItemMetadata = {
      title,
      artist: (item.artist ?? '').trim(),
      album: (item.album ?? '').trim(),
      coverurl: item.coverurl ?? '',
      duration: typeof item.duration === 'number' && item.duration > 0 ? Math.round(item.duration) : undefined,
    };
    const expiresAt = Date.now() + this.metadataTtlMs;
    for (const key of metadataKeyVariants(audiopath)) {
      this.setHarvestedEntry(key, value, expiresAt);
    }
  }

  private setHarvestedEntry(key: string, value: ContentItemMetadata, expiresAt: number): void {
    // Re-insert so the most-recently-harvested keys sit at the tail (LRU order).
    if (this.metadataByAudiopath.has(key)) {
      this.metadataByAudiopath.delete(key);
    }
    this.metadataByAudiopath.set(key, { value, expiresAt });
    while (this.metadataByAudiopath.size > this.metadataByAudiopathMax) {
      const oldest = this.metadataByAudiopath.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.metadataByAudiopath.delete(oldest);
    }
  }

  private lookupHarvestedMetadata(audiopath: string): ContentItemMetadata | null {
    const now = Date.now();
    for (const key of metadataKeyVariants(audiopath)) {
      const entry = this.metadataByAudiopath.get(key);
      if (!entry) {
        continue;
      }
      if (entry.expiresAt <= now) {
        this.metadataByAudiopath.delete(key);
        continue;
      }
      // LRU touch.
      this.metadataByAudiopath.delete(key);
      this.metadataByAudiopath.set(key, entry);
      return entry.value;
    }
    return null;
  }

  public getServiceTrack(
    service: string,
    user: string,
    trackId: string,
  ): Promise<ContentFolderItem | null> {
    return this.requireSpotify().getTrack(service, user, trackId);
  }

  public rescanLibrary(): Promise<void> {
    // A scan can significantly change local library folders; drop cached folder pages.
    this.cache.clearAll();
    return this.library.rescan();
  }

  public getScanStatus(): ScanStatus {
    return this.library.getScanStatus();
  }

  public getLibraryStats(): LibraryStats | null {
    return this.library.getLibraryStats();
  }

  public getLibraryStorageStats(storageId: string): LibraryStats | null {
    return this.library.getStorageStats(storageId);
  }

  public getLibraryCoverSamples(limit: number): LibraryCoverSample[] {
    return this.library.getCoverSamples(limit);
  }

  public getLibraryStorageCoverSamples(storageId: string, limit: number): LibraryCoverSample[] {
    return this.library.getStorageCoverSamples(storageId, limit);
  }

  public uploadLibraryAudio(relativePath: string, base64Data: string): Promise<{ relPath: string; filename: string }> {
    return this.library.uploadLocalAudio(relativePath, base64Data);
  }

  public deleteLibraryTrackByAudiopath(audiopath: string): Promise<LibraryDeleteResult> {
    this.cache.clearAll();
    return this.library.deleteTrackByAudiopath(audiopath);
  }

  public deleteLibraryAlbumByFolderId(albumId: string): Promise<LibraryDeleteResult> {
    this.cache.clearAll();
    return this.library.deleteAlbumByFolderId(albumId);
  }

  public deleteLibraryArtistByFolderId(artistId: string): Promise<LibraryDeleteResult> {
    this.cache.clearAll();
    return this.library.deleteArtistByFolderId(artistId);
  }

  public getGlobalSearchDescription(): Record<string, string[]> {
    const desc: Record<string, string[]> = {};
    const providerTypes = new Set<string>();
    const spotify = this.requireSpotify();
    for (const account of spotify.listAccounts()) {
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
    const safeSource = String(source || '').trim();
    const safeQuery = String(query || '').trim();
    if (!safeSource || !safeQuery) {
      return { result: {}, user: 'nouser', providerId: 'unknown' };
    }

    const now = Date.now();
    const cacheKey = `${safeSource}|${safeQuery.toLowerCase()}`;
    const cached = this.globalSearchCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const inflight = this.globalSearchInflight.get(cacheKey);
    if (inflight) {
      return inflight;
    }

    const promise = this.globalSearchUncached(safeSource, safeQuery)
      .then((value) => {
        const hasResults = Object.keys(value.result ?? {}).length > 0;
        const ttl = hasResults ? this.globalSearchTtlMs : this.globalSearchNegativeTtlMs;
        this.globalSearchCache.set(cacheKey, { expiresAt: Date.now() + ttl, value });
        return value;
      })
      .finally(() => {
        this.globalSearchInflight.delete(cacheKey);
      });

    this.globalSearchInflight.set(cacheKey, promise);
    return promise;
  }

  private async globalSearchUncached(
    source: string,
    query: string,
  ): Promise<{ result: Record<string, ContentFolderItem[]>; user: string; providerId: string }> {
    const [providerPart = '', filterPart = ''] = source.split(':');
    const { limits } = parseSearchLimits(filterPart);
    const [providerIdRaw = '', userRaw = ''] = providerPart.split('@');
    const providerCandidate = providerPart || providerIdRaw || '';

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

    // Spotify + bridge providers (supports multiple accounts)
    const spotify = this.requireSpotify();
    if (spotify.hasProvider(providerCandidate)) {
      const { result, user, providerId } = await spotify.search(source, query);
      return { result, user, providerId };
    }

    const user = source.split('@')[1]?.split(':')[0] ?? 'nouser';
    const fallbackProviderId = providerIdRaw || providerCandidate || 'unknown';
    return { result: {}, user, providerId: fallbackProviderId };
  }

  public async resolveMetadata(audiopath: string): Promise<ContentItemMetadata | null> {
    const raw = String(audiopath || '').trim();
    const decoded = decodeAudiopath(raw);
    const cacheKey = (decoded && decoded !== raw ? decoded : raw) || raw;
    const now = Date.now();

    const cached = this.metadataCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      // A positive memoised result wins; for a cached negative, give the harvest
      // cache a chance first — a listing may have arrived since it was recorded.
      if (cached.value) {
        return cached.value;
      }
      const harvestedAfterNegative = this.lookupHarvestedMetadata(raw);
      if (harvestedAfterNegative) {
        this.metadataCache.set(cacheKey, { value: harvestedAfterNegative, expiresAt: Date.now() + this.metadataTtlMs });
        return harvestedAfterNegative;
      }
      return null;
    }
    if (cached) {
      this.metadataCache.delete(cacheKey);
    }

    // Metadata harvested from a previously served listing answers without a
    // second browse or any per-service live lookup. Memoise the hit so repeat
    // calls short-circuit on the metadataCache fast path above.
    const harvested = this.lookupHarvestedMetadata(raw);
    if (harvested) {
      this.metadataCache.set(cacheKey, { value: harvested, expiresAt: Date.now() + this.metadataTtlMs });
      return harvested;
    }

    const inflight = this.metadataInflight.get(cacheKey);
    if (inflight) {
      return inflight;
    }

    const promise = this.resolveMetadataUncached(raw)
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.debug('resolve metadata failed', { audiopath: raw, message: msg });
        return null;
      })
      .then((value) => {
        const ttl = value ? this.metadataTtlMs : this.metadataNegativeTtlMs;
        this.metadataCache.set(cacheKey, { value, expiresAt: Date.now() + ttl });
        return value;
      })
      .finally(() => {
        if (this.metadataInflight.get(cacheKey) === promise) {
          this.metadataInflight.delete(cacheKey);
        }
      });

    this.metadataInflight.set(cacheKey, promise);
    return promise;
  }

  private async resolveMetadataUncached(audiopath: string): Promise<ContentItemMetadata | null> {
    const decodedPath = decodeAudiopath(audiopath);
    const detectedService = detectServiceFromAudiopath(audiopath);

    // Music Assistant bridge items: try to resolve via bridge provider (stored under spotify manager).
    if (detectedService === 'musicassistant') {
      const providerSegment = (audiopath.split(':')[0] ?? '').trim();
      const spotify = this.requireSpotify();
      const accounts = spotify.listAccounts();
      const bridgeAccount =
        accounts.find((acc) => acc.provider === 'musicassistant' && acc.id === providerSegment) ??
        accounts.find((acc) => acc.provider === 'musicassistant');
      const providerId =
        ((providerSegment && spotify.hasProvider(providerSegment) ? providerSegment : null) ??
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
        const track = await spotify.getTrack(providerId, userId, trackId);
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

    if (detectedService === 'soundcloud') {
      const providerSegment = (audiopath.split(':')[0] ?? '').trim();
      const trackMatch = audiopath.match(/^([^:]+):track:(.+)$/i);
      if (trackMatch) {
        const rawId = trackMatch[2] ?? '';
        const providerId = providerSegment || 'soundcloud';
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
        this.log.debug('soundcloud metadata unresolved', {
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
      const providerSegment = trackMatch[1] ?? '';
      const trackId = trackMatch[2] ?? '';
      const [provider = '', user = ''] = providerSegment.split('@');
      const spotify = this.requireSpotify();
      const serviceId = spotify.hasProvider(providerSegment)
        ? providerSegment
        : provider;
      if (spotify.hasProvider(serviceId)) {
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
      const cfg = this.getConfigPort().getConfig();
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

  private readLocalIconBaseUrl(): string {
    try {
      const cfg = this.getConfigPort().getConfig();
      const host = cfg.system?.audioserver?.ip?.trim() || '127.0.0.1';
      return `http://${host}:7090/assets/icons`;
    } catch {
      return 'http://127.0.0.1:7090/assets/icons';
    }
  }

  private getConfigPort(): ConfigPort {
    return this.configPort;
  }

  private requireSpotify(): SpotifyServiceManager {
    if (!this.spotify) {
      this.spotify = this.spotifyManagerProvider.get();
    }
    return this.spotify;
  }
}

type ContentManagerDeps = {
  notifier: NotifierPort;
  configPort: ConfigPort;
  spotifyManagerProvider: SpotifyServiceManagerProvider;
  customRadioStore: CustomRadioStore;
};

export function createContentManager(deps: ContentManagerDeps): ContentManager {
  return new ContentManager(
    deps.notifier,
    deps.configPort,
    deps.spotifyManagerProvider,
    deps.customRadioStore,
  );
}
