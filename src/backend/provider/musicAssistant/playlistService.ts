import logger from '../../../utils/troxorlogger';
import { config } from '../../../config/config';
import { PlaylistItem } from '../types';
import { MusicAssistantProviderClient } from './providerClient';

const DEFAULT_REFRESH_INTERVAL_MS = Number(process.env.MUSICASSISTANT_PLAYLIST_REFRESH_MS || 60_000);

/**
 * MusicAssistantPlaylistService – caches playlist listings and resolves entries by id so
 * repeated lookups stay responsive even when Music Assistant is remote.
 */
export class MusicAssistantPlaylistService {
  private playlists: PlaylistItem[] = [];
  private lookup = new Map<string, PlaylistItem>();
  private loading?: Promise<void>;
  private lastRefresh = 0;

  constructor(
    private readonly client: MusicAssistantProviderClient,
    private readonly refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
  ) {
    this.loading = this.refreshPlaylists();
  }

  /** Provide a slice of cached playlists, refreshing in the background when stale. */
  async getPlaylists(offset: number, limit: number): Promise<{ items: PlaylistItem[]; total: number }> {
    await this.ensureLoaded();
    return {
      total: this.playlists.length,
      items: this.playlists.slice(offset, offset + limit),
    };
  }

  /** Resolve a playlist identifier to the cached metadata variant used in playback. */
  resolvePlaylist(playlistId: string): PlaylistItem | undefined {
    const keys = normalizePlaylistKeys(playlistId);
    for (const key of keys) {
      const found = this.lookup.get(key);
      if (found) return found;
    }
    return undefined;
  }

  /** Ensures playlists are fetched at least once per refresh interval. */
  private async ensureLoaded(): Promise<void> {
    const stale = Date.now() - this.lastRefresh > this.refreshIntervalMs;
    if (!this.loading && (stale || this.playlists.length === 0)) {
      this.loading = this.refreshPlaylists();
    }

    if (this.loading) {
      try {
        await this.loading;
      } catch {
        // errors already logged in refreshPlaylists
      } finally {
        this.loading = undefined;
      }
    }
  }

  /** Pulls fresh playlist data from Music Assistant and warms the lookup map. */
  private async refreshPlaylists(): Promise<void> {
    try {
      const rawPlaylists = await this.loadPlaylists();
      const items = rawPlaylists.map((playlist, idx) => this.toPlaylistItem(playlist, idx));
      this.playlists = items;
      this.lookup.clear();
      items.forEach((item, idx) => {
        const keys = normalizePlaylistKeys(item.id);
        keys.forEach((key) => this.lookup.set(key, item));
      });
      this.lastRefresh = Date.now();
      logger.info(`[MusicAssistantProvider] Loaded ${items.length} playlists`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[MusicAssistantProvider] Failed to load playlists: ${message}`);
    }
  }

  /** Executes the RPC call that retrieves playlist metadata. */
  private async loadPlaylists(): Promise<any[]> {
    try {
      const limit = Number(process.env.MUSICASSISTANT_PLAYLIST_LIMIT || 200);
      const response = await this.client.rpc('music/playlists/library_items', {
        search: '',
        limit,
        offset: 0,
        order_by: 'name',
      });

      if (Array.isArray(response)) return response;
      if (response?.items && Array.isArray(response.items)) return response.items;
    } catch (error) {
      logger.warn(
        `[MusicAssistantProvider] music/playlists/library_items failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return [];
  }

  /** Normalizes Music Assistant playlist payloads into the shared PlaylistItem shape. */
  private toPlaylistItem(playlist: any, index: number): PlaylistItem {
    const uri = toStringValue(playlist?.uri ?? playlist?.item_id ?? playlist?.path ?? '');
    const id = uri ? uri : toStringValue(playlist?.item_id ?? playlist?.name ?? `playlist-${index}`);
    const normalizedId = id.startsWith('playlist:') || id.startsWith('library://') ? id : `playlist:${id}`;
    const audiopath = uri && uri.startsWith('library://') ? uri : normalizedId;
    const name = toStringValue(playlist?.name ?? id);
    const items = Number(playlist?.items ?? playlist?.track_count ?? 0);
    const coverurl = this.extractCoverUrl(normalizedId, playlist);
    const provider = toStringValue(playlist?.provider);

    return {
      id: normalizedId,
      name,
      audiopath,
      coverurl,
      items,
      type: 11,
      provider: provider || 'musicassistant',
    };
  }

  /** Resolves an artwork URL, falling back to the image proxy when necessary. */
  private extractCoverUrl(id: string, playlist: any): string {
    const metaImages = Array.isArray(playlist?.metadata?.images) ? playlist.metadata.images : [];
    const firstImage = metaImages.length > 0 ? toStringValue(metaImages[0]?.path || metaImages[0]?.url) : '';
    if (firstImage) return firstImage;

    const iconHost =
      process.env.RADIO_ICON_HOST ||
      config.audioserver?.ip ||
      process.env.AUDIOSERVER_IP ||
      '127.0.0.1';
    const proxyId = process.env.RADIO_ICON_PROXY || 'musicassistant';

    return `http://${iconHost}:7091/imgcache/?item=${encodeURIComponent(id)}&viaproxy=${proxyId}`;
  }
}

/** Stringifies primitive/array values while stripping falsy entries. */
function toStringValue(value: any): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return value.map((entry) => toStringValue(entry)).filter(Boolean).join(', ');
  }
  return '';
}

/** Builds a set of keys used to resolve cached playlists by id or canonical URI. */
function normalizePlaylistKeys(value: string): string[] {
  if (!value) return [];
  const decoded = decodeURIComponent(value).trim();
  if (!decoded) return [];

  const lower = decoded.toLowerCase();
  const withoutParams = lower.split(/[?#]/)[0];
  const results = new Set<string>();

  const add = (val: string) => {
    if (val) results.add(val);
  };

  add(withoutParams);

  if (withoutParams.startsWith('playlist:')) {
    add(withoutParams.replace('playlist:', ''));
  }

  if (withoutParams.startsWith('library://')) {
    const simple = withoutParams.replace('library://', '');
    add(simple);
  }

  return Array.from(results);
}
