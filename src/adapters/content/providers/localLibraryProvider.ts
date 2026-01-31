import type { Dirent, Stats } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as mm from 'music-metadata';
import { Jimp, JimpMime } from 'jimp';
import { createLogger } from '@/shared/logging/logger';
import { ensureDir, resolveDataDir } from '@/shared/utils/file';
import { bestEffort, bestEffortSync } from '@/shared/bestEffort';
import type {
  ContentFolder,
  ContentFolderItem,
  ContentItemMetadata,
  ScanStatus,
} from '@/ports/ContentTypes';
import type { SearchLimits } from '@/adapters/content/utils/searchLimits';
import { ensureNasMounts, listStorages } from '@/adapters/content/storage/storageManager';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { NotifierPort } from '@/ports/NotifierPort';
import {
  LocalLibraryStore,
  type AlbumRow,
  type AlbumCoverRow,
  type ArtistRow,
  type StoredTrack,
} from '@/adapters/content/providers/localLibraryStore';

const FILE_TYPE_FOLDER = 1;
const FILE_TYPE_FILE = 2;
const COVER_CANDIDATES = ['cover.jpg', 'cover.png'];
const NAS_DIR_TIMEOUT_MS = 3000;

interface RescanOptions {
  silent?: boolean;
}

export interface LibraryStats {
  tracks: number;
  albums: number;
  artists: number;
}

export interface LibraryCoverSample {
  album: string;
  artist: string;
  coverurl: string;
}

interface LocalTrack {
  id: string;
  relPath: string;
  storageId: string;
  title: string;
  album: string;
  artist: string;
  audiopath: string;
  cover?: string | null;
  duration?: number;
}

interface SafeTags {
  title: string;
  album: string;
  artist: string;
  picture?: mm.IPicture;
  duration?: number;
}

type AlbumIdPayload = { storageId: string; artist: string; album: string };
type ArtistIdPayload = { storageId: string; artist: string };

/**
 * Local-library implementation backed by a lightweight on-disk database.
 * - Persists tracks/albums/artists keyed by storage id
 * - Exposes Loxone-compatible media folders
 * - Emits `rescan_event` notifications just like the real AudioServer
 */
export class LocalLibraryProvider {
  private readonly log = createLogger('Content', 'Library');
  private readonly baseDir = resolveDataDir('music');
  private readonly store = new LocalLibraryStore();
  private notifier: NotifierPort;
  private readonly configPort: ConfigPort;
  private scanStatus: ScanStatus = 0;
  private scanning = false;
  private initialized = false;
  private stats: LibraryStats | null = null;

  constructor(notifier: NotifierPort, configPort: ConfigPort) {
    this.notifier = notifier;
    this.configPort = configPort;
  }

  public setNotifier(notifier: NotifierPort): void {
    this.notifier = notifier;
  }

  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.ensureBaseStructure({ includeNasStorages: false });
    await this.store.init();
    this.initialized = true;
    this.rescan({ silent: true }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('initial library scan failed', { message });
    });
  }

  public getScanStatus(): ScanStatus {
    return this.scanStatus;
  }

  public getLibraryStats(): LibraryStats | null {
    if (this.stats) {
      return this.stats;
    }
    // Best-effort stats read; if the store is unavailable return null.
    return bestEffortSync(
      () => {
        const stats = this.store.getStats();
        this.stats = stats;
        return stats;
      },
      { fallback: null, onError: 'debug', log: this.log, label: 'library stats read failed' },
    );
  }

  public getStorageStats(storageId: string): LibraryStats | null {
    if (!storageId) {
      return null;
    }
    // Best-effort stats read; missing storage yields null.
    return bestEffortSync(
      () => this.store.getStatsForStorage(storageId),
      {
        fallback: null,
        onError: 'debug',
        log: this.log,
        label: 'storage stats read failed',
        context: { storageId },
      },
    );
  }

  public getCoverSamples(limit = 8): LibraryCoverSample[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 24)) : 8;
    // Best-effort sample read; failure yields an empty list.
    return bestEffortSync(
      () => {
        const rows = this.store.getAlbumCoverSamples(safeLimit);
        return rows
          .map((row) => this.mapCoverSample(row))
          .filter((entry): entry is LibraryCoverSample => Boolean(entry));
      },
      { fallback: [], onError: 'debug', log: this.log, label: 'cover sample read failed' },
    );
  }

  public getStorageCoverSamples(storageId: string, limit = 8): LibraryCoverSample[] {
    if (!storageId) {
      return [];
    }
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 24)) : 8;
    // Best-effort sample read; failure yields an empty list.
    return bestEffortSync(
      () => {
        const rows = this.store.getAlbumCoverSamplesForStorage(storageId, safeLimit);
        return rows
          .map((row) => this.mapCoverSample(row))
          .filter((entry): entry is LibraryCoverSample => Boolean(entry));
      },
      {
        fallback: [],
        onError: 'debug',
        log: this.log,
        label: 'storage cover sample read failed',
        context: { storageId },
      },
    );
  }

  public async uploadLocalAudio(
    relativePath: string,
    base64Data: string,
  ): Promise<{ relPath: string; filename: string }> {
    if (!relativePath) {
      throw new Error('invalid-filename');
    }
    if (!base64Data) {
      throw new Error('invalid-audio-data');
    }
    const safeRelative = sanitizeRelativePath(relativePath);
    if (!safeRelative) {
      throw new Error('invalid-filename');
    }
    const fileName = path.basename(safeRelative);
    if (!fileName || !isAudioFile(fileName)) {
      throw new Error('invalid-audio-extension');
    }
    const targetDir = path.join(this.baseDir, 'local');
    const targetSubdir = path.dirname(safeRelative);
    const finalDir =
      targetSubdir && targetSubdir !== '.'
        ? path.join(targetDir, targetSubdir)
        : targetDir;
    await ensureDir(finalDir);
    const finalName = await ensureUniqueFilename(finalDir, fileName);
    const buffer = Buffer.from(base64Data, 'base64');
    await fsp.writeFile(path.join(finalDir, finalName), buffer);
    const relPath =
      targetSubdir && targetSubdir !== '.'
        ? path.join('local', targetSubdir, finalName)
        : path.join('local', finalName);
    return {
      relPath,
      filename: finalName,
    };
  }

  /**
   * Triggers a full rescan of /data/music including NAS storages.
   */
  public async rescan(options: RescanOptions = {}): Promise<void> {
    if (this.scanning) {
      this.log.debug('ignoring rescan request; job already running');
      return;
    }

    this.scanning = true;
    this.stats = null;
    const silent = options.silent ?? false;
    this.updateScanStatus(1, silent);

    try {
      await this.ensureBaseStructure({ includeNasStorages: true });
      await ensureNasMounts(this.baseDir);
      await this.store.init();
      this.store.reset();

      await this.scanStorage('local', 'local');

      // Best-effort storage listing; if missing, scan local only.
      const storages = await bestEffort(() => listStorages(), {
        fallback: [],
        onError: 'debug',
        log: this.log,
        label: 'list storages failed',
      });
      for (const storage of storages) {
        const storageId = String(storage.id);
        await this.scanStorage(storageId, path.join('nas', storageId));
      }

      const stats: LibraryStats = this.store.getStats();
      this.stats = stats;
      this.log.info('library scan complete', { ...stats });
      this.updateScanStatus(2, silent, stats);
      this.updateScanStatus(2, silent, stats); // audio server emits duplicated "finished" events
      this.updateScanStatus(0, silent, stats);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error('library scan failed', { message });
      this.stats = null;
      this.updateScanStatus(0, silent);
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Returns a Loxone-compatible media folder payload.
   */
  public async getMediaFolder(
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    const normalized = this.normalizeFolderId(folderId);

    if (normalized === 'root') {
      return this.buildRootFolder(offset, limit);
    }

    if (normalized === 'library-local') {
      return this.buildStorageFolder('local', 'Local Media', offset, limit);
    }

    if (normalized.startsWith('library-nas-') && !/-albums$|-artists$|-tracks$/.test(normalized)) {
      const storageId = normalized.replace('library-nas-', '');
      return this.buildStorageFolder(storageId, await this.getStorageLabel(storageId), offset, limit);
    }

    if (normalized.endsWith('-albums')) {
      const storageId = this.extractStorageId(normalized, '-albums');
      return this.buildAlbumFolder(storageId, offset, limit);
    }

    if (normalized.endsWith('-artists')) {
      const storageId = this.extractStorageId(normalized, '-artists');
      return this.buildArtistFolder(storageId, offset, limit);
    }

    if (normalized.endsWith('-tracks')) {
      const storageId = this.extractStorageId(normalized, '-tracks');
      return this.buildTrackFolder(storageId, offset, limit);
    }

    if (normalized.startsWith('library:album:')) {
      const key = normalized.slice('library:album:'.length);
      return this.buildAlbumTracks(key, offset, limit);
    }

    if (normalized.startsWith('library:artist:')) {
      const key = normalized.slice('library:artist:'.length);
      return this.buildArtistTracks(key, offset, limit);
    }

    return null;
  }

  private async buildRootFolder(offset: number, limit: number): Promise<ContentFolder> {
    // Best-effort storage listing; empty list means local-only view.
    const storages = await bestEffort(() => listStorages(), {
      fallback: [],
      onError: 'debug',
      log: this.log,
      label: 'list storages failed',
    });
    const items: ContentFolderItem[] = [
      this.storageRootItem('local', 'Local Media'),
      ...storages.map((storage) => this.storageRootItem(String(storage.id), storage.name)),
    ];
    return this.buildFolder('root', 'Local Media', items, offset, limit);
  }

  private async buildStorageFolder(
    storageId: string,
    label: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder> {
    const prefix = storageId === 'local' ? 'library-local' : `library-nas-${storageId}`;
    const items: ContentFolderItem[] = [
      this.categoryItem(prefix, 'Albums', 'albums', storageId),
      this.categoryItem(prefix, 'Artists', 'artists', storageId),
      this.categoryItem(prefix, 'Tracks', 'tracks', storageId),
    ];
    return this.buildFolder(prefix, label, items, offset, limit);
  }

  private async buildAlbumFolder(
    storageId: string | null,
    offset: number,
    limit: number,
  ): Promise<ContentFolder> {
    const { items, total } = this.store.getAlbums(storageId, offset, limit);
    const folderItems = items.map((album) => this.albumItem(album));
    const name = storageId === 'local' ? 'Albums' : `${this.getStorageName(storageId)} Albums`;
    const id =
      storageId === 'local' ? 'library-local-albums' : `library-nas-${storageId}-albums`;
    return this.buildFolder(id, name, folderItems, offset, limit, total, true);
  }

  private async buildArtistFolder(
    storageId: string | null,
    offset: number,
    limit: number,
  ): Promise<ContentFolder> {
    const { items, total } = this.store.getArtists(storageId, offset, limit);
    const folderItems = items.map((artist) => this.artistItem(artist));
    const name = storageId === 'local' ? 'Artists' : `${this.getStorageName(storageId)} Artists`;
    const id =
      storageId === 'local' ? 'library-local-artists' : `library-nas-${storageId}-artists`;
    return this.buildFolder(id, name, folderItems, offset, limit, total, true);
  }

  private async buildTrackFolder(
    storageId: string | null,
    offset: number,
    limit: number,
  ): Promise<ContentFolder> {
    const { items, total } = this.store.getTracks(storageId, offset, limit);
    const folderItems = items.map((track) => this.trackItem(this.normalizeTrack(track)));
    const name = storageId === 'local' ? 'Tracks' : `${this.getStorageName(storageId)} Tracks`;
    const id =
      storageId === 'local' ? 'library-local-tracks' : `library-nas-${storageId}-tracks`;
    return this.buildFolder(id, name, folderItems, offset, limit, total, true);
  }

  private async buildAlbumTracks(
    albumKey: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    const payload = decodeAlbumKey(albumKey);
    if (!payload) {
      return null;
    }

    const { items, total } = this.store.getTracksForAlbum(
      payload.storageId,
      payload.artist,
      payload.album,
      offset,
      limit,
    );
    const folderItems = items.map((track) => this.trackItem(this.normalizeTrack(track)));
    return this.buildFolder(`library:album:${albumKey}`, payload.album, folderItems, offset, limit, total, true);
  }

  private async buildArtistTracks(
    artistKey: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    const payload = decodeArtistKey(artistKey);
    if (!payload) {
      return null;
    }

    const { items, total } = this.store.getTracksForArtist(
      payload.storageId,
      payload.artist,
      offset,
      limit,
    );
    const folderItems = items.map((track) => this.trackItem(this.normalizeTrack(track)));
    return this.buildFolder(`library:artist:${artistKey}`, payload.artist, folderItems, offset, limit, total, true);
  }

  public search(
    query: string,
    limits: SearchLimits,
  ): {
    track: ContentFolderItem[];
    album: ContentFolderItem[];
    artist: ContentFolderItem[];
    playlist: ContentFolderItem[];
    folder: ContentFolderItem[];
  } {
    const safeQuery = query?.trim();
    if (!safeQuery) {
      return { track: [], album: [], artist: [], playlist: [], folder: [] };
    }
    const getLimit = (key: string, fallback = 10) => {
      const value = limits[key];
      return Number.isFinite(value) && value > 0 ? Math.min(Number(value), 50) : fallback;
    };

    const tracks = this.store.searchTracks(safeQuery, getLimit('track'));
    const albums = this.store.searchAlbums(safeQuery, getLimit('album'));
    const artists = this.store.searchArtists(safeQuery, getLimit('artist'));

    return {
      track: tracks.map((t) => this.trackItem(this.normalizeTrack(t))),
      album: albums.map((a) => this.albumItem(a)),
      artist: artists.map((a) => this.artistItem(a)),
      playlist: [],
      folder: [],
    };
  }

  private buildFolder(
    id: string,
    name: string,
    items: ContentFolderItem[],
    offset: number,
    limit: number,
    totalItems?: number,
    itemsPrePaged = false,
  ): ContentFolder {
    const safeOffset = Number.isFinite(offset) && offset > 0 ? offset : 0;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 50;
    const pagedItems = itemsPrePaged ? items : items.slice(safeOffset, safeOffset + safeLimit);
    return {
      id,
      name,
      start: safeOffset,
      totalitems: totalItems ?? items.length,
      items: pagedItems,
    };
  }

  private storageRootItem(storageId: string, label: string): ContentFolderItem {
    const id = storageId === 'local' ? 'library-local' : `library-nas-${storageId}`;
    const audiopath = storageId === 'local' ? 'library:local' : `library:nas:${storageId}`;
    return {
      id,
      name: label,
      type: FILE_TYPE_FOLDER,
      items: 3,
      provider: 'library',
      title: label,
      audiopath,
      nas: true,
      origin: storageId,
      tag: 'nas',
    };
  }

  private categoryItem(
    prefix: string,
    label: string,
    suffix: 'albums' | 'artists' | 'tracks',
    storageId: string,
  ) {
    const audiopath =
      storageId === 'local'
        ? `library:nas:${storageId}:${suffix}`
        : `library:nas:${storageId}:${suffix}`;
    return {
      id: `${prefix}-${suffix}`,
      name: label,
      type: FILE_TYPE_FOLDER,
      provider: 'library',
      title: label,
      audiopath,
      nas: true,
      origin: storageId,
      tag: 'nas',
    };
  }

  private normalizeFolderId(folderId: string): string {
    if (!folderId || folderId === '0') {
      return 'root';
    }
    return folderId.trim();
  }

  private extractStorageId(folderId: string, suffix: string): string | null {
    if (folderId.startsWith('library-local')) {
      return 'local';
    }
    if (folderId.startsWith('library-nas-') && folderId.endsWith(suffix)) {
      return folderId.slice('library-nas-'.length, -suffix.length);
    }
    return null;
  }

  private trackItem(track: LocalTrack): ContentFolderItem {
    return {
      id: track.audiopath,
      name: track.title,
      type: FILE_TYPE_FILE,
      audiopath: track.audiopath,
      coverurl: this.buildCoverUrl(track),
      artist: track.artist ?? '',
      album: track.album ?? '',
      duration: typeof track.duration === 'number' ? Math.round(track.duration) : undefined,
    };
  }

  private albumItem(album: AlbumRow): ContentFolderItem {
    const id = buildAlbumId(album.storage_id, album.artist, album.album);
    let firstTrack: LocalTrack | null = null;
    if (album.rel_path) {
      firstTrack = {
        id: album.rel_path,
        relPath: album.rel_path,
        storageId: album.storage_id,
        title: '',
        album: album.album,
        artist: album.artist,
        audiopath: '',
        cover: album.cover,
      };
    }
    return {
      id,
      name: album.album,
      type: FILE_TYPE_FOLDER,
      coverurl: firstTrack ? this.buildCoverUrl(firstTrack) : '',
      items: album.track_count,
    };
  }

  private mapCoverSample(row: AlbumCoverRow): LibraryCoverSample | null {
    if (!row.cover || !row.rel_path) {
      return null;
    }
    const coverurl = this.buildCoverUrl({ relPath: row.rel_path, cover: row.cover });
    if (!coverurl) {
      return null;
    }
    return {
      album: row.album,
      artist: row.artist,
      coverurl,
    };
  }

  private artistItem(artist: ArtistRow): ContentFolderItem {
    const id = buildArtistId(artist.storage_id, artist.name);
    return {
      id,
      name: artist.name,
      type: FILE_TYPE_FOLDER,
      items: artist.track_count,
    };
  }

  private normalizeTrack(track: StoredTrack): LocalTrack {
    return {
      id: String(track.id),
      relPath: track.rel_path,
      storageId: track.storage_id,
      title: track.title,
      album: track.album,
      artist: track.artist,
      audiopath: track.audiopath,
      cover: track.cover ?? undefined,
      duration: typeof track.duration === 'number' ? Math.round(track.duration) : undefined,
    };
  }

  private buildAudiopath(track: LocalTrack): string {
    const encodedPath = encodePath(track.relPath);
    const uri = `library://${encodedPath}`;
    return buildAudiopath(uri, 'track', 'library:local');
  }

  private buildCoverUrl(track: { relPath: string; cover?: string | null }): string {
    if (!track?.cover) {
      return '';
    }
    const host = this.getConfigPort().getSystemConfig().audioserver.ip || '127.0.0.1';
    const dir = path.dirname(track.relPath);
    return `http://${host}:7090/music/${encodePath(path.join(dir, track.cover))}`;
  }

  private getConfigPort(): ConfigPort {
    return this.configPort;
  }

  private updateScanStatus(status: ScanStatus, silent: boolean, stats?: LibraryStats): void {
    this.scanStatus = status;
    if (stats) {
      this.stats = stats;
    }
    if (!silent) {
      this.notifier.notifyRescan(status, stats?.albums, stats?.tracks);
    }
  }

  private async ensureBaseStructure(options: { includeNasStorages?: boolean } = {}): Promise<void> {
    await ensureDir(this.baseDir);
    await ensureDir(path.join(this.baseDir, 'local'));
    await this.ensureNasDir(path.join(this.baseDir, 'nas'), { scope: 'nas-root' });

    if (options.includeNasStorages ?? true) {
      // Best-effort storage listing; skip NAS if unavailable.
      const storages = await bestEffort(() => listStorages(), {
        fallback: [],
        onError: 'debug',
        log: this.log,
        label: 'list storages failed',
      });
      await Promise.all(
        storages.map((storage) =>
          this.ensureNasDir(path.join(this.baseDir, 'nas', String(storage.id)), {
            scope: 'nas-storage',
            storageId: storage.id,
            name: storage.name,
          }),
        ),
      );
    }
  }

  private async ensureNasDir(dir: string, meta: Record<string, unknown>): Promise<void> {
    try {
      await withTimeout(ensureDir(dir), NAS_DIR_TIMEOUT_MS, 'ensure nas dir');
    } catch (err) {
      if (err instanceof Error && err.message.includes('timed out')) {
        this.log.warn('nas path unavailable; skipping directory creation', {
          dir,
          code: 'ETIMEDOUT',
          ...meta,
        });
        return;
      }
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EHOSTDOWN' || code === 'ENOTCONN' || code === 'EIO') {
        this.log.warn('nas path unavailable; skipping directory creation', {
          dir,
          code,
          ...meta,
        });
        return;
      }
      throw err;
    }
  }

  private async scanStorage(storageId: string, relRoot: string): Promise<void> {
    const absRoot = path.join(this.baseDir, relRoot);
    let entries: Dirent[];

    try {
      entries = await fsp.readdir(absRoot, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const nextRel = path.join(relRoot, entry.name);

      if (entry.isDirectory()) {
        await this.scanStorage(storageId, nextRel);
        continue;
      }

      if (!entry.isFile() || !isAudioFile(entry.name)) {
        continue;
      }

      await this.addTrack(storageId, nextRel);
    }
  }

  private async addTrack(storageId: string, relPath: string): Promise<void> {
    const fullPath = path.join(this.baseDir, relPath);

    let fileStat: Stats | null = null;
    try {
      fileStat = await fsp.stat(fullPath);
    } catch {
      return;
    }

    const metadata = await this.readMetadata(fullPath);
    const baseInfo = createTrackFromPath(relPath);

    const track: LocalTrack = {
      id: relPath,
      relPath,
      storageId,
      title: metadata.title || baseInfo.title,
      album: metadata.album || baseInfo.album,
      artist: metadata.artist || baseInfo.artist,
      audiopath: '',
      duration: metadata.duration,
    };

    track.audiopath = this.buildAudiopath(track);
    track.cover = await this.safeEnsureCoverArt(relPath, metadata.picture);

    this.store.insertTrack({
      storageId,
      relPath,
      title: track.title,
      album: track.album,
      artist: track.artist,
      audiopath: track.audiopath,
      cover: track.cover ?? undefined,
      mtime: fileStat?.mtimeMs ? Math.floor(fileStat.mtimeMs) : undefined,
      size: fileStat?.size,
      duration: track.duration,
    });
  }

  private async safeEnsureCoverArt(relPath: string, picture?: mm.IPicture): Promise<string | undefined> {
    try {
      return await this.ensureCoverArt(relPath, picture);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('cover extraction failed', { relPath, message });
      return undefined;
    }
  }

  private async readMetadata(filePath: string): Promise<SafeTags> {
    try {
      const metadata = await mm.parseFile(filePath);
      return {
        title: metadata.common.title ?? '',
        album: metadata.common.album ?? '',
        artist: metadata.common.artist ?? '',
        picture: metadata.common.picture?.[0],
        duration: metadata.format.duration ? Math.round(metadata.format.duration) : undefined,
      };
    } catch {
      return { title: '', album: '', artist: '' };
    }
  }

  private async ensureCoverArt(relPath: string, picture?: mm.IPicture): Promise<string | undefined> {
    const dir = path.join(this.baseDir, path.dirname(relPath));

    for (const candidate of COVER_CANDIDATES) {
      if (await fileExists(path.join(dir, candidate))) {
        return candidate;
      }
    }

    if (!picture?.data?.length) {
      return undefined;
    }

    const extension = picture.format?.toLowerCase().includes('png') ? '.png' : '.jpg';
    const fileName = `cover${extension}`;
    const outPath = path.join(dir, fileName);

    await ensureDir(dir);
    const image = await Jimp.read(Buffer.from(picture.data));
    const maxSize = 500;
    const width = image.bitmap.width;
    const height = image.bitmap.height;
    const scale = Math.min(1, maxSize / width, maxSize / height);
    if (scale < 1) {
      image.scale(scale);
    }
    const buffer =
      extension === '.png'
        ? await image.getBuffer(JimpMime.png)
        : await image.getBuffer(JimpMime.jpeg, { quality: 85 });

    await fsp.writeFile(outPath, Buffer.from(buffer));
    return fileName;
  }

  private async getStorageLabel(storageId: string): Promise<string> {
    // Best-effort storage listing; missing config falls back to local only.
    const storages = await bestEffort(() => listStorages(), {
      fallback: [],
      onError: 'debug',
      log: this.log,
      label: 'list storages failed',
    });
    return storages.find((storage) => storage.id === storageId)?.name ?? this.getStorageName(storageId);
  }

  private getStorageName(storageId: string | null): string {
    if (!storageId || storageId === 'local') {
      return 'Local';
    }
    return `NAS ${storageId}`;
  }

  public resolveItem(audiopath: string): ContentItemMetadata | null {
    const track = this.store.findByAudiopath(audiopath);
    if (!track) {
      return null;
    }
    const normalized = this.normalizeTrack(track);
    return {
      title: normalized.title,
      artist: normalized.artist,
      album: normalized.album,
      coverurl: this.buildCoverUrl(normalized),
      duration: normalized.duration,
    };
  }
}

function buildAlbumId(storageId: string, artist: string, album: string): string {
  const key = encodeAlbumKey({ storageId, artist, album });
  return `library:album:${key}`;
}

function buildArtistId(storageId: string, artist: string): string {
  const key = encodeArtistKey({ storageId, artist });
  return `library:artist:${key}`;
}

function encodePath(relative: string): string {
  return relative
    .split(path.sep)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function isAudioFile(name: string): boolean {
  return ['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav'].includes(
    path.extname(name).toLowerCase(),
  );
}

function createTrackFromPath(relPath: string): Pick<LocalTrack, 'title' | 'album' | 'artist'> {
  const segments = relPath.split(/[\\/]/).filter(Boolean);
  const file = segments.pop() ?? relPath;
  const baseName = file.replace(path.extname(file), '');

  if (segments.length >= 2) {
    return {
      title: baseName,
      artist: segments[segments.length - 2],
      album: segments[segments.length - 1],
    };
  }

  return {
    title: baseName,
    artist: 'Unknown Artist',
    album: 'Unknown Album',
  };
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name);
  return base.replace(/[^A-Za-z0-9._-]/g, '_');
}

function sanitizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => part.replace(/[^A-Za-z0-9._-]/g, '_'));
  return parts.join('/');
}

async function ensureUniqueFilename(dir: string, filename: string): Promise<string> {
  const ext = path.extname(filename);
  const base = filename.slice(0, -ext.length) || 'upload';
  let candidate = filename;
  let index = 1;
  while (await fileExists(path.join(dir, candidate))) {
    candidate = `${base}-${Date.now()}-${index}${ext}`;
    index += 1;
  }
  return candidate;
}

function encodeAlbumKey(payload: AlbumIdPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeAlbumKey(raw: string): AlbumIdPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as AlbumIdPayload;
    if (parsed.storageId && parsed.artist !== undefined && parsed.album !== undefined) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function encodeArtistKey(payload: ArtistIdPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeArtistKey(raw: string): ArtistIdPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as ArtistIdPayload;
    if (parsed.storageId && parsed.artist !== undefined) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function buildAudiopath(uri: string, itemType: string, providerPrefix: string): string {
  const encoded = Buffer.from(uri).toString('base64');
  return `${providerPrefix}:${itemType}:b64_${encoded}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}
