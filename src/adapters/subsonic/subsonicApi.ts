import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { ContentPort } from '@/ports/ContentPort';
import type { EnginePort } from '@/ports/EnginePort';
import type { ContentFolderItem } from '@/ports/ContentTypes';
import type { BrowsableService } from '@/adapters/content/browsableServices';
import { SubsonicCatalog } from '@/adapters/subsonic/subsonicCatalog';
import { SubsonicStreamHandler } from '@/adapters/subsonic/subsonicStreamHandler';
import { SubsonicAuthenticator } from '@/adapters/subsonic/subsonicAuthenticator';
import {
  decodeEntityId,
  encodeContainerId,
  musicFolderId,
  type SubsonicRef,
} from '@/adapters/subsonic/subsonicIds';
import {
  SubsonicError,
  SubsonicErrorCode,
  resolveFormat,
  sendSubsonic,
  sendSubsonicError,
  type SubsonicNode,
  type SubsonicRequestFormat,
} from '@/adapters/subsonic/subsonicResponse';

/** Base path of the Subsonic REST surface. */
const BASE = '/rest';

/** Max body we read from a POSTing client before giving up. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Subsonic API server.
 *
 * Exposes the whole content layer — local library, radio and every enabled
 * streaming bridge — through the Subsonic REST protocol, so any Subsonic client
 * (Symfonium, DSub, play:Sub, Amperfy, Feishin, …) can browse and play it.
 *
 * Both Subsonic browse models are served, because clients are split between them:
 * the folder model maps directly onto the content layer's paged folder walk, and
 * the ID3 model is built over each service's *collection* (saved albums, followed
 * artists) since a streaming catalogue has no enumerable artist or album set. See
 * {@link SubsonicCatalog} for that mapping.
 *
 * Three protocol realities shape the implementation:
 *   - `getMusicDirectory` has no paging, so a directory is materialised in one
 *     go up to a configurable cap (`content.subsonic.directoryLimit`).
 *   - annotations (star/rating/play counts) have no storage here yet; those
 *     endpoints accept and acknowledge without persisting, which keeps clients
 *     working instead of showing errors on every tap.
 *   - every request carries credentials (there is no session), which is why
 *     {@link SubsonicAuthenticator} caches verifications rather than asking the
 *     Miniserver again for each one.
 */
export class SubsonicApi {
  private readonly log = createLogger('Subsonic');
  private readonly catalog: SubsonicCatalog;
  private readonly stream: SubsonicStreamHandler;
  private readonly auth: SubsonicAuthenticator;

  constructor(
    private readonly config: ConfigPort,
    private readonly contentManager: ContentManager,
    content: ContentPort,
    engine: EnginePort,
  ) {
    this.catalog = new SubsonicCatalog(config, contentManager);
    this.stream = new SubsonicStreamHandler(engine, content);
    this.auth = new SubsonicAuthenticator(config);
  }

  public isEnabled(): boolean {
    return this.config.getConfig().content.subsonic?.enabled === true;
  }

  public matches(pathname: string): boolean {
    return pathname === BASE || pathname.startsWith(`${BASE}/`);
  }

  public async handle(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const params = await this.readParams(req);
    const fmt = resolveFormat(params);

    // The whole surface is gated so enabling the role is a deliberate act.
    if (!this.isEnabled()) {
      sendSubsonicError(res, fmt, SubsonicErrorCode.NotAuthorized, 'Subsonic API is disabled');
      return;
    }

    // CORS preflight from browser-based clients.
    if ((req.method ?? 'GET').toUpperCase() === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }

    // Method names are conventionally suffixed `.view`; both forms are accepted.
    const method = pathname
      .slice(BASE.length)
      .replace(/^\//, '')
      .replace(/\.view$/i, '')
      .trim();

    try {
      await this.auth.authenticate(params);
      await this.dispatch(method, req, res, params, fmt);
    } catch (error) {
      if (error instanceof SubsonicError) {
        sendSubsonicError(res, fmt, error.code, error.message);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('request failed', { method, message });
      sendSubsonicError(res, fmt, SubsonicErrorCode.Generic, message);
    }
  }

  // ── Request plumbing ──────────────────────────────────────────────────────

  /** Collect parameters from the query string and, for POSTing clients, the body. */
  private async readParams(req: IncomingMessage): Promise<URLSearchParams> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const params = url.searchParams;
    if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
      return params;
    }
    const contentType = String(req.headers['content-type'] ?? '');
    if (!contentType.includes('application/x-www-form-urlencoded')) {
      return params;
    }
    const body = await this.readBody(req);
    for (const [key, value] of new URLSearchParams(body)) {
      params.set(key, value);
    }
    return params;
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          req.destroy();
          resolve('');
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => resolve(''));
    });
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  private async dispatch(
    method: string,
    req: IncomingMessage,
    res: ServerResponse,
    params: URLSearchParams,
    fmt: SubsonicRequestFormat,
  ): Promise<void> {
    switch (method) {
      // ── System ──
      case 'ping':
        sendSubsonic(res, fmt);
        return;
      case 'getLicense':
        sendSubsonic(res, fmt, { license: { valid: true } });
        return;
      case 'getOpenSubsonicExtensions':
        sendSubsonic(res, fmt, { openSubsonicExtensions: [] });
        return;
      case 'getUser':
        sendSubsonic(res, fmt, { user: this.userNode(params) });
        return;

      // ── Folder browse model ──
      case 'getMusicFolders':
        sendSubsonic(res, fmt, { musicFolders: { musicFolder: this.musicFolderNodes() } });
        return;
      case 'getIndexes':
        sendSubsonic(res, fmt, { indexes: await this.buildIndexes(params) });
        return;
      case 'getMusicDirectory':
        sendSubsonic(res, fmt, { directory: await this.buildDirectory(params) });
        return;

      // ── ID3 browse model ──
      case 'getArtists':
        sendSubsonic(res, fmt, { artists: await this.buildArtists(params) });
        return;
      case 'getArtist':
        sendSubsonic(res, fmt, { artist: await this.buildArtist(params) });
        return;
      case 'getAlbum':
        sendSubsonic(res, fmt, { album: await this.buildAlbum(params) });
        return;
      case 'getSong':
        sendSubsonic(res, fmt, { song: await this.buildSong(params) });
        return;

      // ── Lists ──
      case 'getAlbumList':
        sendSubsonic(res, fmt, { albumList: { album: await this.buildAlbumList(params) } });
        return;
      case 'getAlbumList2':
        sendSubsonic(res, fmt, { albumList2: { album: await this.buildAlbumList(params) } });
        return;
      case 'getRandomSongs':
        sendSubsonic(res, fmt, { randomSongs: { song: await this.buildRandomSongs(params) } });
        return;

      // ── Search ──
      case 'search2':
        sendSubsonic(res, fmt, { searchResult2: await this.buildSearch(params) });
        return;
      case 'search3':
        sendSubsonic(res, fmt, { searchResult3: await this.buildSearch(params) });
        return;

      // ── Playlists ──
      case 'getPlaylists':
        sendSubsonic(res, fmt, { playlists: { playlist: await this.buildPlaylists(params) } });
        return;
      case 'getPlaylist':
        sendSubsonic(res, fmt, { playlist: await this.buildPlaylist(params) });
        return;

      // ── Media retrieval ──
      case 'stream':
      case 'download':
        await this.handleStream(req, res, params, fmt, method === 'download');
        return;
      case 'getCoverArt':
        await this.handleCoverArt(res, params, fmt);
        return;

      // ── Scanning ──
      case 'getScanStatus':
        sendSubsonic(res, fmt, { scanStatus: this.scanStatusNode() });
        return;
      case 'startScan':
        void this.startScan();
        sendSubsonic(res, fmt, { scanStatus: { scanning: true, count: 0 } });
        return;

      // ── Annotations: accepted, not persisted (no annotation store yet) ──
      case 'star':
      case 'unstar':
      case 'setRating':
      case 'scrobble':
        this.log.debug('annotation accepted without persisting', { method });
        sendSubsonic(res, fmt);
        return;

      // ── Endpoints with no data behind them; an empty result beats a fault ──
      case 'getStarred':
        sendSubsonic(res, fmt, { starred: {} });
        return;
      case 'getStarred2':
        sendSubsonic(res, fmt, { starred2: {} });
        return;
      case 'getGenres':
        sendSubsonic(res, fmt, { genres: {} });
        return;
      case 'getSongsByGenre':
        sendSubsonic(res, fmt, { songsByGenre: {} });
        return;
      case 'getNowPlaying':
        sendSubsonic(res, fmt, { nowPlaying: {} });
        return;
      case 'getArtistInfo':
        sendSubsonic(res, fmt, { artistInfo: {} });
        return;
      case 'getArtistInfo2':
        sendSubsonic(res, fmt, { artistInfo2: {} });
        return;
      case 'getAlbumInfo':
      case 'getAlbumInfo2':
        sendSubsonic(res, fmt, { albumInfo: {} });
        return;
      case 'getSimilarSongs':
        sendSubsonic(res, fmt, { similarSongs: {} });
        return;
      case 'getSimilarSongs2':
        sendSubsonic(res, fmt, { similarSongs2: {} });
        return;
      case 'getTopSongs':
        sendSubsonic(res, fmt, { topSongs: {} });
        return;
      case 'getLyrics':
        sendSubsonic(res, fmt, { lyrics: {} });
        return;
      case 'getVideos':
        sendSubsonic(res, fmt, { videos: {} });
        return;
      case 'getPodcasts':
        sendSubsonic(res, fmt, { podcasts: {} });
        return;
      case 'getBookmarks':
        sendSubsonic(res, fmt, { bookmarks: {} });
        return;
      case 'getInternetRadioStations':
        sendSubsonic(res, fmt, { internetRadioStations: {} });
        return;

      default:
        throw new SubsonicError(
          SubsonicErrorCode.NotFound,
          `Unsupported method: ${method || '(none)'}`,
        );
    }
  }

  // ── System nodes ──────────────────────────────────────────────────────────

  private userNode(params: URLSearchParams): SubsonicNode {
    return {
      username: params.get('u') ?? '',
      // Read-only: playback happens on the server, and there is no annotation or
      // playlist-mutation storage behind this API yet.
      scrobblingEnabled: false,
      adminRole: false,
      settingsRole: false,
      downloadRole: true,
      uploadRole: false,
      playlistRole: false,
      coverArtRole: true,
      commentRole: false,
      podcastRole: false,
      streamRole: true,
      jukeboxRole: false,
      shareRole: false,
    };
  }

  private scanStatusNode(): SubsonicNode {
    const status = this.contentScanStatus();
    return { scanning: status === 1, count: 0 };
  }

  private contentScanStatus(): number {
    try {
      return this.contentManager.getScanStatus();
    } catch {
      return 0;
    }
  }

  private async startScan(): Promise<void> {
    try {
      await this.contentManager.rescanLibrary();
      // A rescan can change which collection folders exist.
      this.catalog.invalidateProbes();
    } catch (error) {
      this.log.warn('rescan failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Folder browse model ───────────────────────────────────────────────────

  private musicFolderNodes(): SubsonicNode[] {
    return this.catalog.services().map((service) => ({
      id: musicFolderId(service.key),
      name: service.title,
    }));
  }

  /**
   * `getIndexes` is the folder model's entry point: an alphabetical index of the
   * top-level entries in a music folder. Without `musicFolderId` a client expects
   * everything, so each service contributes its own top level.
   */
  private async buildIndexes(params: URLSearchParams): Promise<SubsonicNode> {
    const requested = this.catalog.serviceByMusicFolderId(params.get('musicFolderId'));
    const services = requested ? [requested] : this.catalog.services();

    const buckets = new Map<string, SubsonicNode[]>();
    const children: SubsonicNode[] = [];

    for (const service of services) {
      const { items } = await this.catalog.collectChildren(service, service.rootFolderId);
      for (const item of items) {
        if (this.catalog.isTrack(item)) {
          // Loose tracks at a service's top level are legal in the folder model.
          children.push(
            this.catalog.song(
              item,
              encodeContainerId('dir', service.key, service.rootFolderId),
            ),
          );
          continue;
        }
        const node = this.catalog.artist(item, service);
        const letter = indexLetter(String(node.name ?? ''));
        const bucket = buckets.get(letter);
        if (bucket) {
          bucket.push(node);
        } else {
          buckets.set(letter, [node]);
        }
      }
    }

    const index = [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, artist]) => ({ name, artist }));

    return {
      lastModified: 0,
      ignoredArticles: '',
      index,
      ...(children.length ? { child: children } : {}),
    };
  }

  private async buildDirectory(params: URLSearchParams): Promise<SubsonicNode> {
    const { ref, service } = this.requireContainer(params);
    const { items } = await this.catalog.collectChildren(service, ref.folderId);
    const selfId = encodeContainerId(ref.kind, service.key, ref.folderId);
    const isServiceRoot = ref.folderId === service.rootFolderId;

    return {
      id: selfId,
      parent: isServiceRoot ? undefined : encodeContainerId('dir', service.key, service.rootFolderId),
      name: isServiceRoot ? service.title : await this.folderTitle(service, ref.folderId),
      child: items.map((item) => this.catalog.child(item, service, selfId)),
    };
  }

  /**
   * A directory's own display name. The content layer names a folder in its
   * *listing* response, so ask for a single item and read the folder name off it.
   */
  private async folderTitle(service: BrowsableService, folderId: string): Promise<string> {
    const folder = await this.catalog.page(service, folderId, 0, 1);
    return folder?.name?.trim() || service.title;
  }

  // ── ID3 browse model ──────────────────────────────────────────────────────

  /**
   * ID3 artists. For each service this is its *collection* of artists (the
   * "Artists" folder), not its catalogue — see {@link SubsonicCatalog.id3Roots}.
   * A service without one contributes nothing here and stays folder-browsable.
   */
  private async buildArtists(params: URLSearchParams): Promise<SubsonicNode> {
    const requested = this.catalog.serviceByMusicFolderId(params.get('musicFolderId'));
    const services = requested ? [requested] : this.catalog.services();

    const buckets = new Map<string, SubsonicNode[]>();
    for (const service of services) {
      const roots = await this.catalog.id3Roots(service);
      if (!roots.artists) {
        continue;
      }
      const { items } = await this.catalog.collectChildren(service, roots.artists);
      for (const item of items) {
        if (this.catalog.isTrack(item)) {
          continue;
        }
        const node = this.catalog.artist(item, service);
        const letter = indexLetter(String(node.name ?? ''));
        const bucket = buckets.get(letter);
        if (bucket) {
          bucket.push(node);
        } else {
          buckets.set(letter, [node]);
        }
      }
    }

    const index = [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, artist]) => ({ name, artist }));
    return { ignoredArticles: '', index };
  }

  private async buildArtist(params: URLSearchParams): Promise<SubsonicNode> {
    const { ref, service } = this.requireContainer(params);
    const { items } = await this.catalog.collectChildren(service, ref.folderId);
    const name = await this.folderTitle(service, ref.folderId);

    // An artist folder normally lists albums, but some providers list tracks
    // directly. Present those as a single self-titled album so the client has
    // something to open rather than an empty artist.
    const containers = items.filter((item) => !this.catalog.isTrack(item));
    const selfTitled: ContentFolderItem = {
      id: ref.folderId,
      name,
      type: 1,
      items: items.length,
    };
    const albumItems = containers.length ? containers : items.length ? [selfTitled] : [];
    const albums = albumItems.map((item) => this.catalog.album(item, service));

    return {
      id: encodeContainerId('artist', service.key, ref.folderId),
      name,
      albumCount: albums.length,
      album: albums,
    };
  }

  private async buildAlbum(params: URLSearchParams): Promise<SubsonicNode> {
    const { ref, service } = this.requireContainer(params);
    const { items } = await this.catalog.collectChildren(service, ref.folderId);
    const selfId = encodeContainerId('album', service.key, ref.folderId);
    const name = await this.folderTitle(service, ref.folderId);
    const songs = items
      .filter((item) => this.catalog.isTrack(item))
      .map((item) => this.catalog.song(item, selfId));
    const duration = songs.reduce(
      (sum, song) => sum + (typeof song.duration === 'number' ? song.duration : 0),
      0,
    );

    return {
      id: selfId,
      name,
      album: name,
      artist: songs.length ? String(songs[0]?.artist ?? service.title) : service.title,
      coverArt: selfId,
      songCount: songs.length,
      duration,
      song: songs,
    };
  }

  private async buildSong(params: URLSearchParams): Promise<SubsonicNode> {
    const ref = this.requireRef(params);
    if (ref.kind !== 'song') {
      throw new SubsonicError(SubsonicErrorCode.NotFound, 'Not a song id');
    }
    // Normally a harvest-cache hit from the browse that produced this id.
    const meta = await this.contentManager.resolveMetadata(ref.audiopath);
    const service = this.catalog.services()[0];
    if (!service) {
      throw new SubsonicError(SubsonicErrorCode.NotFound, 'No services configured');
    }
    return this.catalog.song(
      {
        id: '',
        name: meta?.title || 'Track',
        type: 2,
        audiopath: ref.audiopath,
        artist: meta?.artist,
        album: meta?.album,
        coverurl: meta?.coverurl,
        duration: meta?.duration,
      },
      '',
    );
  }

  // ── Lists ─────────────────────────────────────────────────────────────────

  /**
   * `getAlbumList`/`getAlbumList2` over each service's collection albums. The
   * `type` parameter's orderings (newest/frequent/recent/…) need play statistics
   * or release dates we do not have, so every type returns the collection in the
   * content layer's own order, paged by offset/size.
   */
  private async buildAlbumList(params: URLSearchParams): Promise<SubsonicNode[]> {
    const requested = this.catalog.serviceByMusicFolderId(params.get('musicFolderId'));
    const services = requested ? [requested] : this.catalog.services();
    const size = clampInt(params.get('size'), 10, 500, 10);
    const offset = clampInt(params.get('offset'), 0, Number.MAX_SAFE_INTEGER, 0);

    const albums: SubsonicNode[] = [];
    for (const service of services) {
      const roots = await this.catalog.id3Roots(service);
      if (!roots.albums) {
        continue;
      }
      // Paged straight through when a single service was asked for; across
      // services the offset applies to the merged list, so collect then slice.
      const folder = requested
        ? await this.catalog.page(service, roots.albums, offset, size)
        : await this.catalog.page(service, roots.albums, 0, offset + size);
      for (const item of folder?.items ?? []) {
        if (!this.catalog.isTrack(item)) {
          albums.push(this.catalog.album(item, service));
        }
      }
      if (requested) {
        return albums;
      }
    }
    return albums.slice(offset, offset + size);
  }

  /**
   * Random songs. Without a global track index across providers, this samples
   * the services that can enumerate albums and shuffles what it finds.
   */
  private async buildRandomSongs(params: URLSearchParams): Promise<SubsonicNode[]> {
    const requested = this.catalog.serviceByMusicFolderId(params.get('musicFolderId'));
    const services = requested ? [requested] : this.catalog.services();
    const size = clampInt(params.get('size'), 1, 500, 10);

    const songs: SubsonicNode[] = [];
    for (const service of services) {
      const roots = await this.catalog.id3Roots(service);
      if (!roots.albums) {
        continue;
      }
      const albums = await this.catalog.page(service, roots.albums, 0, 20);
      for (const album of albums?.items ?? []) {
        if (songs.length >= size * 3) {
          break;
        }
        const folderId = album.id || album.audiopath;
        if (!folderId || this.catalog.isTrack(album)) {
          continue;
        }
        const tracks = await this.catalog.page(service, folderId, 0, 20);
        const parentId = encodeContainerId('album', service.key, folderId);
        for (const item of tracks?.items ?? []) {
          if (this.catalog.isTrack(item)) {
            songs.push(this.catalog.song(item, parentId));
          }
        }
      }
    }
    return shuffle(songs).slice(0, size);
  }

  // ── Search ────────────────────────────────────────────────────────────────

  /**
   * search2/search3 across every searchable service, merged. Clients rarely set
   * `musicFolderId`, so the default really is "search everything the server can
   * reach" — which for a bridge means that provider's own search API.
   */
  private async buildSearch(params: URLSearchParams): Promise<SubsonicNode> {
    const query = (params.get('query') ?? '').trim();
    const artistCount = clampInt(params.get('artistCount'), 0, 200, 20);
    const albumCount = clampInt(params.get('albumCount'), 0, 200, 20);
    const songCount = clampInt(params.get('songCount'), 0, 500, 20);

    if (!query) {
      return {};
    }

    const requested = this.catalog.serviceByMusicFolderId(params.get('musicFolderId'));
    const services = (requested ? [requested] : this.catalog.services()).filter(
      (service) => service.searchSource,
    );

    const artists: SubsonicNode[] = [];
    const albums: SubsonicNode[] = [];
    const songs: SubsonicNode[] = [];

    const results = await Promise.all(
      services.map(async (service) => ({
        service,
        result: await this.catalog.search(service, query, {
          artist: artistCount,
          album: albumCount,
          song: songCount,
        }),
      })),
    );

    for (const { service, result } of results) {
      const parentId = encodeContainerId('dir', service.key, service.rootFolderId);
      for (const [category, items] of Object.entries(result)) {
        // Providers name their buckets in the plural (`tracks`/`albums`/
        // `artists`); the singular forms are tolerated for any that differ.
        const bucket = category.trim().toLowerCase().replace(/s$/, '');
        for (const item of items ?? []) {
          if (bucket === 'artist') {
            artists.push(this.catalog.artist(item, service));
          } else if (bucket === 'album') {
            albums.push(this.catalog.album(item, service));
          } else if (bucket === 'track' || bucket === 'song') {
            songs.push(this.catalog.song(item, parentId));
          } else if (this.catalog.isTrack(item)) {
            // playlist/station/episode buckets still hold playable items.
            songs.push(this.catalog.song(item, parentId));
          }
        }
      }
    }

    return {
      artist: artists.slice(0, artistCount),
      album: albums.slice(0, albumCount),
      song: songs.slice(0, songCount),
    };
  }

  // ── Playlists ─────────────────────────────────────────────────────────────

  /** Every service's playlist collection, flattened into one Subsonic list. */
  private async buildPlaylists(params: URLSearchParams): Promise<SubsonicNode[]> {
    const playlists: SubsonicNode[] = [];
    for (const service of this.catalog.services()) {
      const roots = await this.catalog.id3Roots(service);
      if (!roots.playlists) {
        continue;
      }
      const { items } = await this.catalog.collectChildren(service, roots.playlists);
      for (const item of items) {
        if (this.catalog.isTrack(item)) {
          continue;
        }
        const folderId = item.id || item.audiopath;
        if (!folderId) {
          continue;
        }
        const name = item.name || item.title || 'Playlist';
        playlists.push({
          id: encodeContainerId('playlist', service.key, folderId),
          name: service.title === name ? name : `${name} (${service.title})`,
          owner: params.get('u') ?? '',
          public: false,
          songCount: typeof item.items === 'number' && item.items > 0 ? item.items : 0,
          duration: 0,
          coverArt: item.coverurl || item.thumbnail
            ? encodeContainerId('playlist', service.key, folderId)
            : undefined,
        });
      }
    }
    return playlists;
  }

  private async buildPlaylist(params: URLSearchParams): Promise<SubsonicNode> {
    const { ref, service } = this.requireContainer(params);
    const { items } = await this.catalog.collectChildren(service, ref.folderId);
    const selfId = encodeContainerId('playlist', service.key, ref.folderId);
    const songs = items
      .filter((item) => this.catalog.isTrack(item))
      .map((item) => this.catalog.song(item, selfId));
    const duration = songs.reduce(
      (sum, song) => sum + (typeof song.duration === 'number' ? song.duration : 0),
      0,
    );
    return {
      id: selfId,
      name: await this.folderTitle(service, ref.folderId),
      owner: params.get('u') ?? '',
      public: false,
      songCount: songs.length,
      duration,
      entry: songs,
    };
  }

  // ── Media retrieval ───────────────────────────────────────────────────────

  private async handleStream(
    req: IncomingMessage,
    res: ServerResponse,
    params: URLSearchParams,
    fmt: SubsonicRequestFormat,
    isDownload: boolean,
  ): Promise<void> {
    const ref = this.requireRef(params);
    if (ref.kind !== 'song') {
      throw new SubsonicError(SubsonicErrorCode.NotFound, 'Not a streamable id');
    }
    const format = (params.get('format') ?? '').trim().toLowerCase();
    const maxBitRate = clampInt(params.get('maxBitRate'), 0, 320, 0);
    // `download` means "give me the file as-is"; a requested non-raw format or a
    // bitrate cap means the client wants us to transcode.
    const transcodeOnly = !isDownload && format !== '' && format !== 'raw';

    const served = await this.stream.serve(req, res, ref.audiopath, {
      maxBitRateKbps: isDownload ? 0 : maxBitRate,
      transcodeOnly,
    });
    if (!served) {
      this.log.debug('no playable source', { audiopath: ref.audiopath });
      sendSubsonicError(res, fmt, SubsonicErrorCode.NotFound, 'Song not found or not playable');
    }
  }

  /**
   * Cover art. Bridge covers live on the provider's CDN and library covers on our
   * own `/music` route, so both are fetched server-side and relayed — a client
   * authenticating against us should not have to reach a third-party host itself.
   */
  private async handleCoverArt(
    res: ServerResponse,
    params: URLSearchParams,
    fmt: SubsonicRequestFormat,
  ): Promise<void> {
    const ref = this.requireRef(params);
    let url: string | null = null;
    if (ref.kind === 'song') {
      url = await this.catalog.coverUrlForSong(ref.audiopath);
    } else {
      const service = this.catalog.serviceByKey(ref.service);
      if (service) {
        url = await this.catalog.coverUrlForContainer(service, ref.folderId);
      }
    }
    if (!url) {
      sendSubsonicError(res, fmt, SubsonicErrorCode.NotFound, 'Cover art not found');
      return;
    }

    try {
      const upstream = await fetch(url);
      if (!upstream.ok || !upstream.body) {
        sendSubsonicError(res, fmt, SubsonicErrorCode.NotFound, 'Cover art not available');
        return;
      }
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(200, {
        'Content-Type': upstream.headers.get('content-type') ?? 'image/jpeg',
        'Content-Length': buffer.length,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(buffer);
    } catch (error) {
      this.log.debug('cover fetch failed', {
        url,
        message: error instanceof Error ? error.message : String(error),
      });
      sendSubsonicError(res, fmt, SubsonicErrorCode.NotFound, 'Cover art not available');
    }
  }

  // ── Shared parameter handling ─────────────────────────────────────────────

  private requireRef(params: URLSearchParams): SubsonicRef {
    const id = params.get('id');
    if (!id) {
      throw new SubsonicError(
        SubsonicErrorCode.MissingParameter,
        'Required parameter id is missing',
      );
    }
    const ref = decodeEntityId(id);
    if (!ref) {
      throw new SubsonicError(SubsonicErrorCode.NotFound, 'Unknown id');
    }
    return ref;
  }

  /**
   * Resolve an id that must denote a container, plus its service.
   *
   * Clients legitimately cross-feed ids between endpoints (a directory id handed
   * to getAlbum, an album id to getMusicDirectory), so the tag is normalised
   * rather than rejected — all container tags address the same folder.
   */
  private requireContainer(params: URLSearchParams): {
    ref: Exclude<SubsonicRef, { kind: 'song' }>;
    service: BrowsableService;
  } {
    const ref = this.requireRef(params);
    if (ref.kind === 'song') {
      throw new SubsonicError(SubsonicErrorCode.NotFound, 'Not a browsable id');
    }
    const service = this.catalog.serviceByKey(ref.service);
    if (!service) {
      throw new SubsonicError(SubsonicErrorCode.NotFound, 'Unknown or disabled service');
    }
    return { ref, service };
  }
}

function clampInt(
  raw: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

/** The alphabetical bucket a name belongs to in getIndexes/getArtists. */
function indexLetter(name: string): string {
  const first = name.trim().charAt(0).toUpperCase();
  if (!first) {
    return '#';
  }
  return /[A-Z]/.test(first) ? first : '#';
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
