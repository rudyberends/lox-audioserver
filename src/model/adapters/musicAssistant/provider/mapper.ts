import type { Album, Artist, Playlist, Track } from '../types/musicAssistantTypes';
import { MusicAssistantApi } from '../api';
import logger from '@/utils/troxorLogger';
import { extractCover } from '../utils/imageUtils';
import {
  mapAlbum,
  mapArtist,
  mapPlaylist,
  mapTrack,
  //mapRecentlyPlayedItem,
} from '../mappers/contentMapper';
import type { ServiceFolderItem, ServiceFolderResponse } from '@/core/types/content';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

type FolderType = 'album' | 'playlist' | 'artist' | 'radio';
type DetailType = Exclude<FolderType, 'radio'>;

interface ProviderInit {
  providerId: string;
  ip: string;
  port?: number;
}

interface FolderRule {
  match: readonly string[];
  service: string;
  mode: 'root' | 'detail';
  type: FolderType;
  detailId?: string;
}

/* -------------------------------------------------------------------------- */
/* Mapper Implementation                                                      */
/* -------------------------------------------------------------------------- */

export class MusicAssistantContentProviderMapper {
  private readonly api: MusicAssistantApi;
  private readonly providerId: string;

  private static readonly FOLDER_MAP: readonly FolderRule[] = [
    { match: ['start'], service: 'local', mode: 'root', type: 'radio' },
    { match: ['5', 'albums'], service: 'spotify', mode: 'root', type: 'album' },
    { match: ['3', 'playlists'], service: 'spotify', mode: 'root', type: 'playlist' },
    { match: ['6', 'artists'], service: 'spotify', mode: 'root', type: 'artist' },
    { match: ['4'], service: 'spotify', mode: 'detail', type: 'playlist', detailId: '1' }, // favorites
  ] as const;

  constructor(init: ProviderInit) {
    this.providerId = init.providerId;
    this.api = MusicAssistantApi.acquire(init.ip, init.port ?? 8095);
  }

  async initialize(): Promise<void> {
    this.api.connect();
  }

  async dispose(): Promise<void> {
    this.api.release();
  }

  /* -------------------------------------------------------------------------- */
  /* Spotify façade                                                             */
  /* -------------------------------------------------------------------------- */

  async getAvailableServices() {
    logger.debug('[MusicAssistantProviderMapper] Returning available services [Fake Spotify]');
    return [
      {
        cmd: 'spotify',
        config: [
          { name: 'Username', regex: '%2F', type: 'text' },
          { link: 'https://w.c/l', name: 'EULA', type: 'eula' },
        ],
        helplink: 'http://o.c/h',
        icon: 'http://e.k',
        name: 'Spotify',
        registerlink: 'https://w/s',
      },
    ];
  }

  async getServices() {
    logger.debug('[MusicAssistantProviderMapper] Returning active services [Fake Spotify]');
    return [
      {
        asdefault: [3],
        cmd: 'spotify',
        configerror: false,
        email: 'nouser@test.com',
        icon: 'https://e',
        id: 'spotify',
        name: 'Spotify',
        offline_storage: [],
        product: 'premium',
        user: 'Music Assistant',
      },
    ];
  }

  /* -------------------------------------------------------------------------- */
  /* Recently Played                                                            */
  /* -------------------------------------------------------------------------- */

  async getRecentlyPlayed(zoneId: number, limit = 50): Promise<ServiceFolderResponse> {
    logger.debug(`[MusicAssistantProviderMapper] getRecentlyPlayed() for zone ${zoneId}, limit=${limit}`);
    // Todo: fix recently played
    return {
      'id': 'recentlyPlayed',
      'name': 'Recently Played',
      'start': 0,
      'totalitems': 0,
      'items': [],
    };

    /*
    try {
      const { items } = await this.api.getRecentlyPlayed(limit, 0);
      const mapped: ServiceFolderItem[] = (Array.isArray(items) ? items : []).map((obj, index) =>
        mapRecentlyPlayedItem(obj, this.providerId, index),
      );

      return {
        id: 'recentlyPlayed',
        name: 'Recently Played',
        start: 0,
        totalitems: mapped.length,
        items: mapped,
      };
    } catch (err) {
      logger.warn(`[MusicAssistantProviderMapper] getRecentlyPlayed failed: ${String(err)}`);
      return this.emptyResponse('recentlyPlayed', 'Recently Played');
    }*/
  }

  async clearRecentlyPlayed(zoneId?: number): Promise<void> {
    try {
      await this.api.clearRecentlyPlayed();
      logger.debug(
        `[MusicAssistantProviderMapper] Cleared recently played items${zoneId ? ` for zone ${zoneId}` : ''}`,
      );
    } catch (err) {
      logger.warn(`[MusicAssistantProviderMapper] clearRecentlyPlayed failed: ${String(err)}`);
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Helpers                                                                    */
  /* -------------------------------------------------------------------------- */

  private normalizeFolderId(folderId: string): string {
    return decodeURIComponent(folderId ?? '')
      .toLowerCase()
      .replace(/^spotify\/nouser\//, '')
      .trim();
  }

  private normalizeId(id: string): string {
    return id
      .replace(/^library:\/\/(album|playlist|artist|track)\//, '')
      .replace(/^spotify@[^:]+:(album|playlist|artist|track):/, '')
      .trim();
  }

  private matchesFolder(folderId: string, aliases: readonly string[]): boolean {
    const id = this.normalizeFolderId(folderId);
    return aliases.includes(id);
  }

  private mapItem(obj: Record<string, unknown>, type: FolderType): ServiceFolderItem {
    const coverurl = extractCover(obj) || '';
    const name = (obj as any).name ?? (obj as any).title ?? '';

    if (type === 'radio') {
      const id = (obj as any).item_id ?? (obj as any).id ?? '';
      return {
        id: `tunein:station:${id}`,
        name,
        title: name,
        station: name,
        sort: '',
        contentType: 'Playlists',
        coverurl,
        type: 2,
        tag: 'radio',
        audiopath: (obj as any).uri ?? '',
      };
    }

    const artist =
      (Array.isArray((obj as any).artists) && (obj as any).artists[0]?.name) ||
      (obj as any).artist ||
      '';
    return {
      id: (obj as any).uri ?? (obj as any).item_id ?? '',
      name,
      title: name,
      artist,
      tag: type,
      type: 7,
      coverurl,
      thumbnail: coverurl,
      audiopath: (obj as any).uri ?? '',
    };
  }

  private mapRootResult(type: FolderType, res: { items: unknown[]; total?: number }, offset: number): ServiceFolderResponse {
    const items = (res.items ?? []).map((obj) => this.mapItem(obj as Record<string, unknown>, type));
    const total = res.total ?? items.length ?? 0;
    return {
      id: this.mapTypeToFolderId(type),
      name: `${type.charAt(0).toUpperCase() + type.slice(1)}s`,
      service: type === 'radio' ? 'local' : this.providerId,
      start: offset,
      totalitems: total,
      items,
    };
  }

  /* -------------------------------------------------------------------------- */
  /* Root / Detail                                                              */
  /* -------------------------------------------------------------------------- */

  private async getRoot(type: FolderType, offset = 0, limit = 50): Promise<ServiceFolderResponse> {
    try {
      const fetchers: Record<FolderType, () => Promise<{ items: unknown[]; total?: number }>> = {
        album: () => this.api.getLibraryAlbums(limit, offset),
        playlist: () => this.api.getLibraryPlaylists(limit, offset),
        artist: () => this.api.getLibraryArtists(limit, offset),
        radio: () => this.api.getLibraryRadios(limit, offset),
      };
      const res = await fetchers[type]();
      return this.mapRootResult(type, res, offset);
    } catch (err) {
      logger.warn(`[MusicAssistantProviderMapper] Failed to load ${type}s: ${String(err)}`);
      return this.emptyResponse(this.mapTypeToFolderId(type), `${type}s`, offset);
    }
  }

  private async getDetail(
    type: DetailType,
    id: string,
    offset = 0,
    limit = 50,
  ): Promise<ServiceFolderResponse> {
    try {
      const normalizedId = this.normalizeId(id);
      const fetchers: Record<DetailType, () => Promise<[any, any]>> = {
        album: () =>
          Promise.all([
            this.api.getAlbum('library', normalizedId),
            this.api.getAlbumTracks('library', normalizedId, offset, limit),
          ]),
        playlist: () =>
          Promise.all([
            this.api.getPlaylist('library', normalizedId),
            this.api.getPlaylistTracks(normalizedId, 'library'),
          ]),
        artist: () =>
          Promise.all([
            this.api.getArtist('library', normalizedId),
            this.api.getArtistTracks('library', normalizedId, offset, limit),
          ]),
      };

      const [info, tracksResult] = await fetchers[type]();
      return this.mapDetailResult(type, id, info, tracksResult, offset);
    } catch (err) {
      logger.warn(`[MusicAssistantProviderMapper] Failed to load ${type} detail (${id}): ${String(err)}`);
      return this.emptyResponse(id, type, offset);
    }
  }

  private mapDetailResult(
    type: DetailType,
    id: string,
    info: Record<string, any>,
    tracksResult: Record<string, any> | Track[],
    offset: number,
  ): ServiceFolderResponse {
    const tracks: Track[] = Array.isArray(tracksResult)
      ? tracksResult
      : (tracksResult.items ?? []) as Track[];

    const total =
      Array.isArray(tracksResult) && !(tracksResult as any).total
        ? tracks.length
        : Number((tracksResult as any).total ?? tracks.length);

    const coverurl = extractCover(info);
    const artist =
      (Array.isArray(info?.artists) && info.artists[0]?.name) || info.artist || '';

    const items: ServiceFolderItem[] = tracks.map((track) => mapTrack(track, this.providerId));

    return {
      id: info.uri ?? id,
      name: info.name ?? '',
      service: this.providerId,
      artist,
      coverurl,
      thumbnail: coverurl,
      tag: type,
      type: 7,
      start: offset,
      totalitems: total,
      items,
    };
  }

  /* -------------------------------------------------------------------------- */
  /* Router                                                                     */
  /* -------------------------------------------------------------------------- */

  async getServiceFolder(
    service: string,
    user: string,
    orgFolderId: string,
    offset = 0,
    limit = 50,
  ): Promise<ServiceFolderResponse> {
    const folderId = orgFolderId.startsWith('spotify@')
      ? orgFolderId.split('@')[1]
      : orgFolderId;

    logger.debug(
      `[MusicAssistantProviderMapper] getServiceFolder → service=${service} user=${user} folder=${folderId}`,
    );

    try {
      for (const r of MusicAssistantContentProviderMapper.FOLDER_MAP) {
        if (this.matchesFolder(folderId, r.match) && r.service === service) {
          return r.mode === 'root'
            ? await this.getRoot(r.type, offset, limit)
            : await this.getDetail(r.type as DetailType, r.detailId!, offset, limit);
        }
      }

      if (folderId.includes(':album:') || folderId.startsWith('library://album/')) {
        return await this.getDetail('album', folderId, offset, limit);
      }
      if (folderId.includes(':playlist:') || folderId.startsWith('library://playlist/')) {
        return await this.getDetail('playlist', folderId, offset, limit);
      }
      if (folderId.includes(':artist:') || folderId.startsWith('library://artist/')) {
        return await this.getDetail('artist', folderId, offset, limit);
      }

      return this.emptyResponse(folderId, 'Unknown', offset);
    } catch (err) {
      logger.warn(`[MusicAssistantProviderMapper] getServiceFolder failed: ${String(err)}`);
      return this.emptyResponse(folderId, 'Error', offset);
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Item resolving & search (typed)                                           */
  /* -------------------------------------------------------------------------- */
  async resolveItem(audiopath: string): Promise<any> {
    try {
    // Expected formats:
    // spotify:track:ID | spotify:album:ID | spotify:playlist:ID | tunein:station:ID | library://radio/ID ...
      let provider: string;
      let type: string;
      let id: string;

      // Spotify-style (spotify:track:xxx)
      const spotifyMatch = audiopath.match(/^([^:]+):([^:]+):(.+)$/);
      // Library-style (library://radio/1)
      const libraryMatch = audiopath.match(/^([^:]+):\/\/([^/]+)\/(.+)$/);

      if (spotifyMatch) {
        provider = spotifyMatch[1];
        type = spotifyMatch[2];
        id = spotifyMatch[3];
      } else if (libraryMatch) {
        provider = libraryMatch[1];
        type = libraryMatch[2];
        id = libraryMatch[3];
      } else {
        provider = 'library';
        type = 'track';
        id = audiopath;
      }

      // Route by type
      const resolverMap: Record<string, (p: string, id: string) => Promise<any>> = {
        radio: this.api.getRadio.bind(this.api),
        station: this.api.getRadio.bind(this.api),
        album: this.api.getAlbum.bind(this.api),
        artist: this.api.getArtist.bind(this.api),
        playlist: this.api.getPlaylist.bind(this.api),
      };

      const resolver = resolverMap[type] ?? this.api.getTrack.bind(this.api);
      const item = await resolver(provider, id);

      if (!item) {
        return undefined;
      }

      const coverurl = extractCover(item);
      return { ...item, coverurl };
    } catch (err) {
      logger.warn(`[MusicAssistantProviderMapper] resolveItem failed for "${audiopath}": ${String(err)}`);
      return undefined;
    }
  }


  async globalSearch(source: string, query: string, unique: string): Promise<{
    error: number;
    result: Record<string, unknown>;
    message?: string;
  }> {
    logger.debug(
      `[MusicAssistantProviderMapper] globalSearch source="${source}" query="${query}" unique=${unique}`,
    );

    const limits: Record<string, number> = {};
    const filterPart = source.split(':')[1] ?? '';
    for (const entry of filterPart.split(',')) {
      const [type, rawLimit] = entry.split('#');
      if (type) {
        limits[type.trim().toLowerCase()] = Number(rawLimit) || 5;
      }
    }

    const values = Object.values(limits);
    const limit = values.length ? Math.max(...values) : 10;

    try {
      const result = await this.api.search(query, limit);
      const raw = (result && (result.result || result)) ?? {};
      const mapped: Record<string, unknown> = {};

      if (Array.isArray(raw.tracks)) {
        mapped.tracks = (raw.tracks as Track[]).map((t) => mapTrack(t, this.providerId));
      }
      if (Array.isArray(raw.albums)) {
        mapped.albums = (raw.albums as Album[]).map((a) => mapAlbum(a, this.providerId));
      }
      if (Array.isArray(raw.artists)) {
        mapped.artists = (raw.artists as Artist[]).map((a) => mapArtist(a, this.providerId));
      }
      if (Array.isArray(raw.playlists)) {
        mapped.playlists = (raw.playlists as Playlist[]).map((p) => mapPlaylist(p, this.providerId));
      }

      return { error: 0, result: mapped };
    } catch (err) {
      logger.warn(`[MusicAssistantProviderMapper] globalSearch failed for "${query}": ${String(err)}`);
      return { error: 1, result: {}, message: String(err) };
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Utilities                                                                  */
  /* -------------------------------------------------------------------------- */

  private mapTypeToFolderId(type: FolderType): string {
    switch (type) {
      case 'album':
        return '5';
      case 'playlist':
        return '3';
      case 'artist':
        return '6';
      case 'radio':
        return 'local';
    }
  }

  private emptyResponse(id: string, name: string, start = 0): ServiceFolderResponse {
    return { id, name, service: this.providerId, start, totalitems: 0, items: [] };
  }
}