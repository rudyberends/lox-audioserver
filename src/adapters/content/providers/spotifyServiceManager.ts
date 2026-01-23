import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type {
  ContentFolder,
  ContentFolderItem,
  ContentServiceAccount,
  PlaylistEntry,
  SpotifyAccountConfig,
  SpotifyBridgeConfig,
} from '@/ports/ContentTypes';
import {
  SpotifyAccountProvider,
  type PersistAccountCallback,
  type SpotifyAccountState,
  type SpotifyConnectDevice,
} from '@/adapters/content/providers/spotify/spotifyAccountProvider';
import { FakeSpotifyAccountProvider } from '@/adapters/content/providers/spotify/fakeSpotifyAccountProvider';
import { AppleMusicProvider } from '@/adapters/content/providers/applemusic/appleMusicProvider';
import { DeezerProvider } from '@/adapters/content/providers/deezer/deezerProvider';
import { TidalProvider } from '@/adapters/content/providers/tidal/tidalProvider';
import { MusicAssistantBridgeProvider } from '@/adapters/content/providers/musicassistant/musicAssistantBridgeProvider';
import { resolveSpotifyClientId } from '@/adapters/content/providers/spotify/utils';
import { parseSearchLimits } from '@/adapters/content/utils/searchLimits';

type ProviderId = string;
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
const PROVIDER_ICONS: Record<string, string> = {
  spotify: 'https://extended-app-content.s3.eu-central-1.amazonaws.com/audioZone/services/Icon-Spotify.svg',
  applemusic: '/providers/apple-music.svg',
  musicassistant: '/providers/music-assistant.png',
  deezer: 'https://extended-app-content.s3.eu-central-1.amazonaws.com/audioZone/services/Icon-Deezer.svg',
  tidal: 'https://extended-app-content.s3.eu-central-1.amazonaws.com/audioZone/services/Icon-Tidal.svg',
};
const PROVIDER_NAMES: Record<string, string> = {
  spotify: 'Spotify',
  applemusic: 'Apple Music',
  musicassistant: 'Music Assistant',
  deezer: 'Deezer',
  tidal: 'Tidal',
};

export interface SpotifyServiceDevice {
  id: string;
  name: string;
  type?: string;
  isActive?: boolean;
  volumePercent?: number;
  supportsVolume?: boolean;
  accountId: string;
  accountLabel: string;
  providerId: string;
}

/**
 * Manages Spotify accounts and exposes simple helpers for folder/playlist lookups.
 */
export class SpotifyServiceManager {
  private readonly log = createLogger('Content', 'SpotifyManager');
  private readonly configPort: ConfigPort;

  private providers = new Map<
    ProviderId,
    SpotifyAccountProvider | MusicAssistantBridgeProvider | AppleMusicProvider | DeezerProvider | TidalProvider
  >();
  private accounts: SpotifyAccountState[] = [];
  private bridges: SpotifyBridgeConfig[] = [];
  private clientId = resolveSpotifyClientId();

  constructor(
    configPort: ConfigPort,
    accounts: SpotifyAccountConfig[] = [],
    clientId?: string,
    bridges: SpotifyBridgeConfig[] = [],
  ) {
    this.configPort = configPort;
    this.reload(accounts, clientId, bridges);
  }

  /**
   * Rebuild all account providers from config.
   */
  public reload(
    accounts: SpotifyAccountConfig[] = [],
    clientId?: string,
    bridges: SpotifyBridgeConfig[] = [],
  ): void {
    for (const provider of this.providers.values()) {
      (provider as any)?.dispose?.();
    }
    this.providers.clear();
    this.clientId = resolveSpotifyClientId({ clientId });
    this.bridges = Array.isArray(bridges) ? [...bridges] : [];
    this.accounts = (accounts ?? []).map((acc, idx) => ({
      ...acc,
      // normalize alternative refresh_token key if present
      refreshToken: acc.refreshToken ?? (acc as any).refresh_token,
      id: acc.id || acc.user || acc.email || `user${idx + 1}`,
    }));

    for (const account of this.accounts) {
      const providerId = this.providerIdFor(account.id);
      const provider = new SpotifyAccountProvider({
        providerId,
        account,
        clientId: account.clientId ?? this.clientId,
        persistAccount: this.persistAccountState,
      });
      this.providers.set(providerId, provider);
    }

    this.registerBridgeProviders();

    this.log.debug('spotify manager reloaded', { accounts: this.accounts.length });
  }

  /**
   * List all available spotify accounts (including optional bridge/fake accounts).
   */
  public listAccounts(): ContentServiceAccount[] {
    const realAccounts: ContentServiceAccount[] = this.accounts.map((acc) => ({
      id: this.providerIdFor(acc.id),
      label: acc.displayName || acc.name || acc.user || acc.email || acc.id,
      provider: 'spotify',
      fake: false,
      product: acc.product,
    }));

    const fakeAccounts: ContentServiceAccount[] = (this.bridges ?? [])
      .filter((bridge) => bridge && bridge.enabled !== false)
      .map((bridge) => ({
        id: this.bridgeProviderId(bridge),
        // Expose provider as the name for bridge accounts (e.g., MusicAssistant).
        label: bridge.provider || bridge.label || bridge.id,
        provider: (bridge.provider || 'spotify').toLowerCase(),
        fake: true,
      }));

    return [...realAccounts, ...fakeAccounts];
  }

  /**
   * Legacy-style service entries for Loxone getservices.
   */
  public listServiceEntries(): Array<Record<string, unknown>> {
    const entries = this.accounts.map((acc) => {
      const provider = this.providers.get(this.providerIdFor(acc.id));
      return {
        cmd: 'spotify',
        name: this.resolveProviderName('spotify'),
        icon: this.resolveProviderIcon('spotify'),
        id: acc.id || acc.user || acc.email || '',
        user: this.displayLabel(acc),
        email: acc.email ?? '',
        product: acc.product ?? '',
        asdefault: [],
        offline_storage: [],
        configerror: (provider as SpotifyAccountProvider | undefined)?.hasAuthError ?? false,
        provider: 'spotify',
        fake: false,
      };
    });

    for (const bridge of (this.bridges ?? []).filter((b) => b && b.enabled !== false)) {
      const providerId = this.bridgeProviderId(bridge);
      const provider = this.providers.get(providerId);
      const providerType = (bridge.provider || 'spotify').toLowerCase();
      const email = `${(bridge.id || '').trim()}@lox-audioserver.io`;
      entries.push({
        cmd: 'spotify',
        // For bridges, omit the friendly name; clients can display sourceName/provider instead.
        name: '',
        icon: this.resolveProviderIcon(providerType),
        id: bridge.id,
        user: bridge.label || bridge.id,
        email: email || '',
        product: '',
        asdefault: [],
        offline_storage: [],
        configerror: (provider as SpotifyAccountProvider | undefined)?.hasAuthError ?? false,
        provider: providerType,
        fake: true,
      });
    }

    return entries;
  }

  /**
   * Aggregate Spotify Connect devices across all configured Spotify accounts.
   */
  public async listConnectDevices(): Promise<SpotifyServiceDevice[]> {
    const devices: SpotifyServiceDevice[] = [];
    for (const provider of this.providers.values()) {
      if (!this.isRealSpotifyProvider(provider)) {
        this.log.debug('bridge provider skipped for spotify connect devices', {
          provider: provider?.providerId,
        });
        continue;
      }
      try {
        const accountDevices = await provider.listConnectDevices();
        for (const device of accountDevices) {
          if (!device.id || !device.name) {
            continue;
          }
          devices.push({
            id: device.id,
            name: device.name,
            type: device.type,
            isActive: device.isActive ?? false,
            volumePercent: device.volumePercent,
            supportsVolume: device.supportsVolume ?? false,
            accountId: provider.accountId,
            accountLabel: provider.displayLabel,
            providerId: provider.providerId,
          });
        }
      } catch (err) {
        this.log.warn('spotify connect device listing failed', {
          provider: provider.providerId,
          err,
        });
      }
    }
    const unique = new Map<string, SpotifyServiceDevice>();
    for (const device of devices) {
      if (!unique.has(device.id)) {
        unique.set(device.id, device);
      }
    }
    return Array.from(unique.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Fetch playlists for the given service/user combination.
   */
  public async getPlaylists(
    service: string,
    user: string,
    offset: number,
    limit: number,
  ): Promise<PlaylistEntry[]> {
    const provider = this.resolveProvider(service, user);
    if (!provider) {
      return [];
    }
    return provider.getPlaylists(offset, limit);
  }

  /**
   * Fetch a folder tree for the given service/user.
   */
  public async getFolder(
    service: string,
    user: string,
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    const cleanedId = this.sanitizeSpotifyId(folderId);
    const provider = this.resolveProvider(service, user);
    if (!provider) {
      return null;
    }
    return provider.getFolder(cleanedId, offset, limit);
  }

  /**
   * Resolve a single track for the given service/user combination.
   */
  public async getTrack(
    service: string,
    user: string,
    trackId: string,
  ): Promise<ContentFolderItem | null> {
    const cleanedId = this.sanitizeSpotifyId(trackId);
    const provider = this.resolveProvider(service, user);
    if (!provider) {
      return null;
    }
    return provider.getTrack(cleanedId);
  }

  /**
   * Perform a Spotify search with filters (e.g. "spotify@user:track#5,album#5").
   * Returns grouped results keyed by type (tracks, albums, artists, playlists).
   */
  public async search(
    source: string,
    query: string,
  ): Promise<{
    result: Record<string, ContentFolderItem[]> & { _totals?: Record<string, number> };
    user: string;
    providerId: string;
  }> {
    const [providerPart, filterPart = ''] = source.split(':');
    const { limits, maxLimit } = parseSearchLimits(filterPart);
    const [service, user = ''] = providerPart.split('@');
    const provider = this.resolveProvider(service, user);
    if (!provider) {
      return {
        result: {},
        user: user || 'nouser',
        providerId: this.normalizeServiceId(service),
      };
    }

    if (provider instanceof MusicAssistantBridgeProvider) {
      const { result, user: bridgeUser, providerId } = await provider.search(
        query,
        limits,
        maxLimit,
      );
      return { result, user: bridgeUser, providerId };
    }

    if (provider instanceof AppleMusicProvider) {
      const { result, user: bridgeUser, providerId } = await provider.search(
        query,
        limits,
        maxLimit,
      );
      return { result, user: bridgeUser, providerId };
    }

    if (provider instanceof DeezerProvider) {
      const { result, user: bridgeUser, providerId } = await provider.search(
        query,
        limits,
        maxLimit,
      );
      return { result, user: bridgeUser, providerId };
    }

    if (provider instanceof TidalProvider) {
      const { result, user: bridgeUser, providerId } = await provider.search(
        query,
        limits,
        maxLimit,
      );
      return { result, user: bridgeUser, providerId };
    }

    const accessToken = await provider.fetchAccessToken();
    if (!accessToken) {
      return {
        result: {},
        user: provider.accountId,
        providerId: provider.providerId,
      };
    }

    const supportedTypes = ['track', 'album', 'artist', 'playlist', 'episode', 'show'] as const;
    const requestedTypes = Object.keys(limits);
    const activeTypes =
      requestedTypes.length > 0
        ? supportedTypes.filter((t) => requestedTypes.includes(t))
        : supportedTypes;
    if (!activeTypes.length) {
      return { result: {}, user: provider.accountId, providerId: provider.providerId };
    }

    const url = new URL('https://api.spotify.com/v1/search');
    url.searchParams.set('q', query.replace(/'/g, ''));
    url.searchParams.set('type', activeTypes.join(','));
    url.searchParams.set('limit', String(maxLimit));

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      return { result: {}, user: provider.accountId, providerId: provider.providerId };
    }
    const data = (await res.json()) as any;
    const result: Record<string, ContentFolderItem[]> & { _totals?: Record<string, number> } = {};
    const totals: Record<string, number> = {};
    const providerPrefix = provider.providerId;

    const mapTrack = (track: any): ContentFolderItem | null => {
      const id = String(track?.id ?? '');
      if (!id) return null;
      const name = String(track?.name ?? id);
      const artists = Array.isArray(track?.artists)
        ? track.artists
            .map((a: any) => (a && typeof a.name === 'string' ? a.name : ''))
            .filter(Boolean)
            .join(', ')
        : '';
      const album = track?.album?.name ?? '';
      const cover =
        (Array.isArray(track?.album?.images) && track.album.images[0]?.url) || '';
      return {
        id: `${providerPrefix}:track:${id}`,
        title: name,
        name,
        audiopath: `${providerPrefix}:track:${id}`,
        coverurl: cover,
        thumbnail: cover,
        artist: artists,
        album,
        duration: typeof track?.duration_ms === 'number' ? Math.round(track.duration_ms / 1000) : undefined,
        hasCover: !!cover,
        owner: album || undefined,
        type: 2,
        tag: 'track',
      };
    };

    const mapAlbum = (album: any): ContentFolderItem | null => {
      const id = String(album?.id ?? '');
      if (!id) return null;
      const name = String(album?.name ?? id);
      const cover = (Array.isArray(album?.images) && album.images[0]?.url) || '';
      const artists = Array.isArray(album?.artists)
        ? album.artists
            .map((a: any) => (a && typeof a.name === 'string' ? a.name : ''))
            .filter(Boolean)
            .join(', ')
        : '';
      return {
        id: `${providerPrefix}:album:${id}`,
        title: name,
        name,
        audiopath: `${providerPrefix}:album:${id}`,
        coverurl: cover,
        thumbnail: cover,
        artist: artists,
        type: 7,
        tag: 'album',
      };
    };

    const mapArtist = (artist: any): ContentFolderItem | null => {
      const id = String(artist?.id ?? '');
      if (!id) return null;
      const name = String(artist?.name ?? id);
      const cover = (Array.isArray(artist?.images) && artist.images[0]?.url) || '';
      return {
        id: `${providerPrefix}:artist:${id}`,
        title: name,
        name,
        audiopath: `${providerPrefix}:artist:${id}`,
        coverurl: cover,
        thumbnail: cover,
        artist: name,
        type: 7,
        tag: 'artist',
      };
    };

    const mapPlaylist = (playlist: any): ContentFolderItem | null => {
      const id = String(playlist?.id ?? '');
      if (!id) return null;
      const name = String(playlist?.name ?? id);
      const cover = (Array.isArray(playlist?.images) && playlist.images[0]?.url) || '';
      return {
        id: `${providerPrefix}:playlist:${id}`,
        title: name,
        name,
        audiopath: `${providerPrefix}:playlist:${id}`,
        coverurl: cover,
        thumbnail: cover,
        artist: '',
        owner: playlist?.owner?.display_name || playlist?.owner?.id || '',
        owner_id: playlist?.owner?.id || '',
        type: 7,
        tag: 'playlist',
      };
    };

    const mapShow = (show: any): ContentFolderItem | null => {
      const id = String(show?.id ?? '');
      if (!id) return null;
      const name = String(show?.name ?? id);
      const publisher = show?.publisher ?? '';
      const cover = (Array.isArray(show?.images) && show.images[0]?.url) || '';
      return {
        id: `${providerPrefix}:show:${id}`,
        title: name,
        name,
        audiopath: `${providerPrefix}:show:${id}`,
        coverurl: cover,
        thumbnail: cover,
        artist: publisher,
        type: 7,
        tag: 'show',
      };
    };

    const mapEpisode = (episode: any): ContentFolderItem | null => {
      const id = String(episode?.id ?? '');
      if (!id) return null;
      const name = String(episode?.name ?? id);
      const showName = episode?.show?.name ?? '';
      const cover =
        (Array.isArray(episode?.images) && episode.images[0]?.url) ||
        (Array.isArray(episode?.show?.images) && episode.show.images[0]?.url) ||
        '';
      return {
        id: `${providerPrefix}:episode:${id}`,
        title: name,
        name,
        audiopath: `${providerPrefix}:episode:${id}`,
        coverurl: cover,
        thumbnail: cover,
        artist: showName,
        album: showName,
        type: 2,
        tag: 'episode',
      };
    };

    if (activeTypes.includes('track') && data?.tracks?.items) {
      const max = limits.track ?? maxLimit;
      const items = Array.isArray(data.tracks.items) ? data.tracks.items : [];
      result.tracks = items.slice(0, max).map(mapTrack).filter(Boolean) as ContentFolderItem[];
      totals.tracks = typeof data.tracks.total === 'number' ? data.tracks.total : items.length;
    }
    if (activeTypes.includes('album') && data?.albums?.items) {
      const max = limits.album ?? maxLimit;
      const items = Array.isArray(data.albums.items) ? data.albums.items : [];
      result.albums = items.slice(0, max).map(mapAlbum).filter(Boolean) as ContentFolderItem[];
      totals.albums = typeof data.albums.total === 'number' ? data.albums.total : items.length;
    }
    if (activeTypes.includes('artist') && data?.artists?.items) {
      const max = limits.artist ?? maxLimit;
      const items = Array.isArray(data.artists.items) ? data.artists.items : [];
      result.artists = items.slice(0, max).map(mapArtist).filter(Boolean) as ContentFolderItem[];
      totals.artists = typeof data.artists.total === 'number' ? data.artists.total : items.length;
    }
    if (activeTypes.includes('playlist') && data?.playlists?.items) {
      const max = limits.playlist ?? maxLimit;
      const items = Array.isArray(data.playlists.items) ? data.playlists.items : [];
      result.playlists = items
        .slice(0, max)
        .map(mapPlaylist)
        .filter(Boolean) as ContentFolderItem[];
      totals.playlists =
        typeof data.playlists.total === 'number' ? data.playlists.total : items.length;
    }
    if (activeTypes.includes('show') && data?.shows?.items) {
      const max = limits.show ?? maxLimit;
      const items = Array.isArray(data.shows.items) ? data.shows.items : [];
      result.shows = items.slice(0, max).map(mapShow).filter(Boolean) as ContentFolderItem[];
      totals.shows = typeof data.shows.total === 'number' ? data.shows.total : items.length;
    }
    if (activeTypes.includes('episode') && data?.episodes?.items) {
      const max = limits.episode ?? maxLimit;
      const items = Array.isArray(data.episodes.items) ? data.episodes.items : [];
      result.episodes = items
        .slice(0, max)
        .map(mapEpisode)
        .filter(Boolean) as ContentFolderItem[];
      totals.episodes =
        typeof data.episodes.total === 'number' ? data.episodes.total : items.length;
    }

    result._totals = totals;

    return { result, user: provider.accountId, providerId: provider.providerId };
  }

  /**
   * Follow-state helpers used by the Loxone commands.
   */
  public async getFollowState(
    service: string,
    user: string,
    itemId: string,
  ): Promise<{ isfollowed: boolean; isowner: boolean }> {
    const provider = this.resolveProvider(service, user);
    if (!provider || !this.isRealSpotifyProvider(provider)) {
      if (provider) {
        this.log.debug('bridge provider skipped for spotify follow state', {
          provider: provider.providerId,
        });
      }
      return { isfollowed: false, isowner: false };
    }
    const parsed = this.parseSpotifyId(itemId);
    if (!parsed) {
      return { isfollowed: false, isowner: false };
    }
    const token = await provider.fetchAccessToken();
    if (!token) {
      return { isfollowed: false, isowner: false };
    }

    const { type, id } = parsed;
    try {
      if (type === 'playlist') {
        const me = provider.accountId;
        const contains = await this.fetchJson<boolean[]>(
          `${SPOTIFY_API_BASE}/playlists/${encodeURIComponent(id)}/followers/contains?ids=${encodeURIComponent(me)}`,
          token,
        );
        const playlist = await this.fetchJson<any>(
          `${SPOTIFY_API_BASE}/playlists/${encodeURIComponent(id)}`,
          token,
        );
        return {
          isfollowed: Array.isArray(contains) ? !!contains[0] : false,
          isowner: playlist?.owner?.id ? playlist.owner.id === me : false,
        };
      }

      if (type === 'artist' || type === 'show') {
        const resp = await this.fetchJson<boolean[]>(
          `${SPOTIFY_API_BASE}/me/following/contains?type=${type}&ids=${encodeURIComponent(id)}`,
          token,
        );
        return { isfollowed: Array.isArray(resp) ? !!resp[0] : false, isowner: false };
      }

      if (type === 'album') {
        const resp = await this.fetchJson<boolean[]>(
          `${SPOTIFY_API_BASE}/me/albums/contains?ids=${encodeURIComponent(id)}`,
          token,
        );
        return { isfollowed: Array.isArray(resp) ? !!resp[0] : false, isowner: false };
      }
    } catch {
      /* ignore */
    }
    return { isfollowed: false, isowner: false };
  }

  public async setFollowState(
    service: string,
    user: string,
    itemId: string,
    follow: boolean,
  ): Promise<void> {
    const provider = this.resolveProvider(service, user);
    if (!provider || !this.isRealSpotifyProvider(provider)) return;
    const parsed = this.parseSpotifyId(itemId);
    if (!parsed) return;
    const token = await provider.fetchAccessToken();
    if (!token) return;

    const { type, id } = parsed;
    const method = follow ? 'PUT' : 'DELETE';

    try {
      if (type === 'playlist') {
        await this.doRequest(
          `${SPOTIFY_API_BASE}/playlists/${encodeURIComponent(id)}/followers`,
          token,
          method,
          follow ? { public: false } : undefined,
        );
        return;
      }
      if (type === 'artist' || type === 'show') {
        await this.doRequest(
          `${SPOTIFY_API_BASE}/me/following?type=${type}&ids=${encodeURIComponent(id)}`,
          token,
          method,
        );
        return;
      }
      if (type === 'album') {
        await this.doRequest(
          `${SPOTIFY_API_BASE}/me/albums?ids=${encodeURIComponent(id)}`,
          token,
          method,
        );
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Exposes a Spotify access token for a given account (or the first available account).
   */
  public async getAccessTokenForAccount(accountId?: string, forceRefresh = false): Promise<string | null> {
    const provider = this.resolveProvider('spotify', accountId ?? '');
    if (!provider) {
      const fallback = this.accounts[0];
      if (!fallback) {
        return null;
      }
      const fallbackProvider = this.providers.get(this.providerIdFor(fallback.id));
      if (!this.isRealSpotifyProvider(fallbackProvider)) {
        if (fallbackProvider) {
          this.log.debug('bridge provider skipped for spotify access token', {
            provider: fallbackProvider.providerId,
          });
        }
        return null;
      }
      return fallbackProvider.fetchAccessToken(forceRefresh);
    }
    if (!this.isRealSpotifyProvider(provider)) {
      this.log.debug('bridge provider skipped for spotify access token', {
        provider: provider.providerId,
      });
      return null;
    }
    return provider.fetchAccessToken(forceRefresh);
  }

  /**
   * Returns the first configured Spotify account id (if any).
   */
  public getDefaultAccountId(): string | null {
    return this.accounts[0]?.id ?? null;
  }

  /**
   * Checks if a provider (real or bridge) exists for the given service id.
   */
  public hasProvider(service: string): boolean {
    if (!service) return false;
    const trimmed = service.trim();
    const candidates = [trimmed, this.normalizeServiceId(trimmed)];
    const withoutFilters = trimmed.split(':')[0] || '';
    if (withoutFilters && withoutFilters !== trimmed) {
      candidates.push(withoutFilters);
    }
    return candidates.some((id) => id && this.providers.has(id));
  }

  private resolveProvider(
    service: string,
    user: string,
  ): SpotifyAccountProvider | MusicAssistantBridgeProvider | AppleMusicProvider | DeezerProvider | TidalProvider | null {
    const candidateIds: ProviderId[] = [];
    if (service) {
      candidateIds.push(this.normalizeServiceId(service));
    }
    if (user) {
      candidateIds.push(this.providerIdFor(user));
    }

    for (const id of candidateIds) {
      if (this.providers.has(id)) {
        return this.providers.get(id)!;
      }
    }

    // fallback to first provider
    const first = this.providers.values().next();
    return first.done ? null : first.value;
  }

  private isRealSpotifyProvider(
    provider: SpotifyAccountProvider | MusicAssistantBridgeProvider | AppleMusicProvider | DeezerProvider | TidalProvider | null | undefined,
  ): provider is SpotifyAccountProvider {
    if (!provider || !(provider instanceof SpotifyAccountProvider)) {
      return false;
    }
    const account = provider.getServiceAccount?.();
    if (account?.fake) {
      return false;
    }
    if (account?.provider && account.provider !== 'spotify') {
      return false;
    }
    return true;
  }

  private normalizeServiceId(service: string): ProviderId {
    if (!service) {
      return '';
    }
    const trimmed = service.trim();
    if (trimmed.toLowerCase().startsWith('spotify@')) {
      return trimmed;
    }
    return this.providerIdFor(trimmed);
  }

  /**
   * Check if an account id exists in the configured accounts.
   */
  public hasAccount(accountId: string | null | undefined): boolean {
    if (!accountId) {
      return false;
    }
    const normalized = accountId.trim().toLowerCase();
    return this.accounts.some((acc) => acc.id?.trim().toLowerCase() === normalized);
  }

  /**
    * Resolve an account id by matching username/email/displayName (case-insensitive).
    */
  public findAccountIdByUsername(username: string): string | null {
    if (!username) return null;
    const target = username.trim().toLowerCase();
    const match = this.accounts.find((acc) => {
      const candidates = [
        acc.id,
        acc.user,
        acc.email,
        acc.spotifyId,
        acc.displayName,
        acc.name,
      ]
        .filter(Boolean)
        .map((v) => v!.toString().trim().toLowerCase());
      return candidates.includes(target);
    });
    return match?.id ?? null;
  }

  private providerIdFor(accountId: string | undefined): ProviderId {
    const id = accountId && accountId.trim() ? accountId.trim() : 'nouser';
    return `spotify@${id}`;
  }

  private bridgeProviderId(bridge: SpotifyBridgeConfig): ProviderId {
    return this.providerIdFor(bridge.id);
  }

  private registerBridgeProviders(): void {
    if (!Array.isArray(this.bridges) || this.bridges.length === 0) return;

    for (const bridge of this.bridges) {
      if (!bridge || bridge.enabled === false) continue;
      const providerId = this.bridgeProviderId(bridge);
      const providerType = (bridge.provider || 'spotify').toLowerCase();
      const labelOverride = bridge.label || bridge.id;
      if (this.providers.has(providerId)) {
        this.log.warn('bridge provider skipped; provider id already registered', { providerId });
        continue;
      }

      if (providerType === 'musicassistant') {
        const provider = new MusicAssistantBridgeProvider({
          providerId,
          label: labelOverride,
          host: bridge.host,
          port: bridge.port,
          apiKey: bridge.apiKey,
          accountId: bridge.accountId ?? bridge.id,
        });
        this.providers.set(providerId, provider);
        continue;
      }

      if (providerType === 'applemusic') {
        const provider = new AppleMusicProvider({
          providerId,
          label: labelOverride,
          developerToken: bridge.developerToken,
          userToken: bridge.userToken,
        });
        this.providers.set(providerId, provider);
        continue;
      }

      if (providerType === 'deezer') {
        const provider = new DeezerProvider({
          providerId,
          label: labelOverride,
          arl: bridge.deezerArl,
        });
        this.providers.set(providerId, provider);
        continue;
      }

      if (providerType === 'tidal') {
        const provider = new TidalProvider({
          providerId,
          label: labelOverride,
          accessToken: bridge.tidalAccessToken,
          countryCode: bridge.tidalCountryCode,
        });
        this.providers.set(providerId, provider);
        continue;
      }

      const account = this.resolveBridgeSourceAccount(bridge);
      if (!account) continue;
      const provider = new FakeSpotifyAccountProvider(providerType, labelOverride, {
        providerId,
        account,
        clientId: account.clientId ?? this.clientId,
        persistAccount: this.persistAccountState,
      });
      this.providers.set(providerId, provider);
    }
  }

  private resolveBridgeSourceAccount(bridge: SpotifyBridgeConfig): SpotifyAccountState | null {
    if (!this.accounts.length) {
      this.log.warn('bridge provider skipped; no spotify accounts configured', { bridge: bridge.id });
      return null;
    }
    if (bridge.accountId) {
      const match = this.accounts.find(
        (acc) => acc.id?.trim().toLowerCase() === bridge.accountId?.trim().toLowerCase(),
      );
      if (match) return match;
      this.log.warn('bridge provider account not found; falling back to first account', {
        bridge: bridge.id,
        accountId: bridge.accountId,
      });
    }
    return this.accounts[0];
  }

  private findBridgeByProviderId(providerId: string): SpotifyBridgeConfig | null {
    const normalized = providerId.trim().toLowerCase();
    return (
      this.bridges.find(
        (bridge) =>
          bridge &&
          this.bridgeProviderId(bridge).trim().toLowerCase() === normalized,
      ) ?? null
    );
  }

  private resolveProviderIcon(provider: string): string {
    const key = (provider || '').toLowerCase();
    return PROVIDER_ICONS[key] || PROVIDER_ICONS.spotify;
  }

  private resolveProviderName(provider: string): string {
    const key = (provider || '').toLowerCase();
    return PROVIDER_NAMES[key] || PROVIDER_NAMES.spotify || 'Spotify';
  }

  private sanitizeSpotifyId(value: string): string {
    if (!value) return '';
    let cleaned = value.trim();
    try {
      cleaned = decodeURIComponent(cleaned);
    } catch {
      /* ignore */
    }
    return cleaned.replace(/\]+$/, '').replace(/\/+$/, '');
  }

  private parseSpotifyId(itemId: string): { type: 'track' | 'album' | 'artist' | 'playlist' | 'show'; id: string } | null {
    let cleaned = this.sanitizeSpotifyId(itemId);
    if (!cleaned) {
      return null;
    }
    const match = cleaned.match(/spotify@[^:]+:(track|album|artist|playlist|show|episode):(.+)/i);
    if (match) {
      const type = match[1].toLowerCase();
      const id = match[2];
      if (type === 'episode') {
        return { type: 'show', id }; // episodes follow show subscriptions
      }
      return { type: type as any, id };
    }
    const plain = cleaned.match(/^(track|album|artist|playlist|show):(.+)/i);
    if (plain) {
      const type = plain[1].toLowerCase();
      const id = plain[2];
      if (type === 'episode') {
        return { type: 'show', id };
      }
      return { type: type as any, id };
    }
    return null;
  }

  private async doRequest(
    url: string,
    token: string,
    method: 'GET' | 'PUT' | 'DELETE',
    body?: unknown,
  ): Promise<void> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    await fetch(url, init);
  }

  private async fetchJson<T>(url: string, token: string): Promise<T | null> {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  }

  private displayLabel(acc: SpotifyAccountState): string {
    return (
      acc.displayName ||
      acc.name ||
      acc.user ||
      acc.email ||
      acc.id
    );
  }

  /**
   * Persist refresh-token updates to the stored config.
   */
  private readonly persistAccountState: PersistAccountCallback = async (
    accountId,
    patch,
  ) => {
    let updated: SpotifyAccountConfig | null = null;

    await this.configPort.updateConfig((cfg) => {
      const accounts = cfg.content.spotify.accounts || [];
      const idx = accounts.findIndex(
        (acc) =>
          (acc.id && acc.id === accountId) ||
          (acc.user && acc.user === accountId) ||
          (acc.email && acc.email === accountId),
      );

      if (idx >= 0) {
        accounts[idx] = { ...accounts[idx], ...patch };
        updated = accounts[idx];
      } else {
        const acc: SpotifyAccountConfig = { id: accountId, ...patch };
        accounts.push(acc);
        updated = acc;
      }

      cfg.content.spotify.accounts = accounts;
    });

    // also update in-memory copy for existing provider
    const providerId = this.providerIdFor(accountId);
    const provider = this.providers.get(providerId);
    if (provider && updated && provider instanceof SpotifyAccountProvider) {
      provider.updateAccount(updated);
    }

    return updated;
  };
}

function normalizeSpotifyConfig(
  spotifyCfg: { accounts?: SpotifyAccountConfig[]; clientId?: string; bridges?: SpotifyBridgeConfig[] } | undefined,
): { accounts: SpotifyAccountConfig[]; clientId?: string; bridges: SpotifyBridgeConfig[] } {
  const cfg = spotifyCfg ?? { accounts: [], bridges: [] };
  return {
    accounts: cfg.accounts ?? [],
    clientId: cfg.clientId,
    bridges: cfg.bridges ?? [],
  };
}

function loadSpotifyConfig(
  configPort: ConfigPort,
): { accounts: SpotifyAccountConfig[]; clientId?: string; bridges: SpotifyBridgeConfig[] } {
  try {
    const cfg = configPort.getConfig();
    return normalizeSpotifyConfig(cfg.content?.spotify);
  } catch {
    return { accounts: [], bridges: [] };
  }
}

export function buildSpotifyManagerFromConfig(configPort: ConfigPort): SpotifyServiceManager {
  const cfg = loadSpotifyConfig(configPort);
  return new SpotifyServiceManager(configPort, cfg.accounts, cfg.clientId, cfg.bridges);
}

/**
 * Keeps a shared Spotify manager instance bound to a specific ConfigPort.
 */
export class SpotifyServiceManagerProvider {
  private manager: SpotifyServiceManager | null = null;

  constructor(private readonly configPort: ConfigPort) {}

  public get(): SpotifyServiceManager {
    if (!this.manager) {
      this.manager = buildSpotifyManagerFromConfig(this.configPort);
    }
    return this.manager;
  }

  public reload(): SpotifyServiceManager {
    const cfg = loadSpotifyConfig(this.configPort);
    if (this.manager) {
      this.manager.reload(cfg.accounts ?? [], cfg.clientId, cfg.bridges ?? []);
      return this.manager;
    }
    this.manager = new SpotifyServiceManager(this.configPort, cfg.accounts ?? [], cfg.clientId, cfg.bridges ?? []);
    return this.manager;
  }
}
