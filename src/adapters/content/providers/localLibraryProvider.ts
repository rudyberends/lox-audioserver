import type { Dirent, Stats } from 'node:fs';
import fsp from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
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
  type TrackFileRow,
} from '@/adapters/content/providers/localLibraryStore';

const FILE_TYPE_FOLDER = 1;
const FILE_TYPE_FILE = 2;
const COVER_CANDIDATES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp'];
const NAS_DIR_TIMEOUT_MS = 3000;
const MUSICBRAINZ_ENDPOINT = 'https://musicbrainz.org/ws/2/release/';
const MUSICBRAINZ_USER_AGENT = 'lox-audioserver/1.0 (library-cover-fallback)';
const COVER_ART_ARCHIVE_RELEASE = 'https://coverartarchive.org/release';
const COVER_ART_MAX_BYTES = 8 * 1024 * 1024;
const ALERTS_PUBLIC_DIR = path.resolve(process.cwd(), 'public', 'alerts');
const SD_ROOT_FOLDER_ID = 'library-sd';
const SD_ALERTS_FOLDER_ID = 'library-sd-alerts';
const SD_EVENT_SOUNDS_FOLDER_ID = 'library-sd-event-sounds';

interface RescanOptions {
  silent?: boolean;
}

export interface LibraryStats {
  tracks: number;
  albums: number;
  artists: number;
}

export interface LibraryCoverSample {
  id: string;
  album: string;
  artist: string;
  coverurl: string;
}

export interface LibraryDeleteResult {
  deletedTracks: number;
  deletedFiles: number;
  missingFiles: number;
}

interface LocalTrack {
  id: string;
  relPath: string;
  storageId: string;
  title: string;
  album: string;
  artist: string;
  albumArtist?: string;
  audiopath: string;
  cover?: string | null;
  duration?: number;
}

interface SafeTags {
  title: string;
  album: string;
  artist: string;
  albumArtist: string;
  compilation: boolean;
  picture?: mm.IPicture;
  duration?: number;
}

type AlbumIdPayload = { storageId: string; artist: string; album: string };
type ArtistIdPayload = { storageId: string; artist: string };
type FolderIdPayload = { storageId: string; relPath: string };

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
  private readonly coverLookupCache = new Map<string, string | null>();
  private musicBrainzNextAllowedAt = 0;

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
    const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.round(limit)) : 8;
    // Best-effort sample read; failure yields an empty list.
    return bestEffortSync(
      () => {
        const rows = this.store.getAlbumCoverSamples(safeLimit === 0 ? 1_000_000 : safeLimit);
        return rows.map((row) => this.mapCoverSample(row));
      },
      { fallback: [], onError: 'debug', log: this.log, label: 'cover sample read failed' },
    );
  }

  public getStorageCoverSamples(storageId: string, limit = 8): LibraryCoverSample[] {
    if (!storageId) {
      return [];
    }
    const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.round(limit)) : 8;
    // Best-effort sample read; failure yields an empty list.
    return bestEffortSync(
      () => {
        const rows = this.store.getAlbumCoverSamplesForStorage(
          storageId,
          safeLimit === 0 ? 1_000_000 : safeLimit,
        );
        return rows.map((row) => this.mapCoverSample(row));
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
    const buffer = Buffer.from(base64Data, 'base64');
    const requestedSubdir = path.dirname(safeRelative);
    const autoSubdir =
      !requestedSubdir || requestedSubdir === '.'
        ? await this.resolveUploadSubdirFromMetadata(buffer, fileName)
        : '';
    const targetSubdir =
      requestedSubdir && requestedSubdir !== '.'
        ? requestedSubdir
        : autoSubdir;
    const targetDir = path.join(this.baseDir, 'local');
    const finalDir =
      targetSubdir && targetSubdir !== '.'
        ? path.join(targetDir, targetSubdir)
        : targetDir;
    await ensureDir(finalDir);
    const finalName = await ensureUniqueFilename(finalDir, fileName);
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

  private async resolveUploadSubdirFromMetadata(
    data: Buffer,
    fileName: string,
  ): Promise<string> {
    try {
      const metadata = await mm.parseBuffer(data, undefined, { duration: false });
      const artistRaw = metadata.common.artist?.trim() ?? '';
      const albumRaw = metadata.common.album?.trim() ?? '';
      if (!artistRaw || !albumRaw) {
        return '';
      }
      if (/^unknown\b/i.test(artistRaw) || /^unknown\b/i.test(albumRaw)) {
        return '';
      }
      const artistDir = sanitizePathSegment(artistRaw);
      const albumDir = sanitizePathSegment(albumRaw);
      if (!artistDir || !albumDir) {
        return '';
      }
      return path.join(artistDir, albumDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.debug('upload metadata parse failed for folder grouping', { fileName, message });
      return '';
    }
  }

  public async deleteTrackByAudiopath(audiopath: string): Promise<LibraryDeleteResult> {
    const safeAudiopath = String(audiopath || '').trim();
    if (!safeAudiopath) {
      throw new Error('invalid-audiopath');
    }

    const rows = this.store.getTrackFilesForAudiopath(safeAudiopath);
    if (rows.length === 0) {
      throw new Error('track-not-found');
    }

    const fileResult = await this.deleteAudioFiles(rows);
    const deletedTracks = this.store.deleteTracksByAudiopath(safeAudiopath);
    this.stats = null;
    return { ...fileResult, deletedTracks };
  }

  public async deleteAlbumByFolderId(albumId: string): Promise<LibraryDeleteResult> {
    const safeId = String(albumId || '').trim();
    if (!safeId.startsWith('library:album:')) {
      throw new Error('invalid-album-id');
    }
    const payload = decodeAlbumKey(safeId.slice('library:album:'.length));
    if (!payload) {
      throw new Error('invalid-album-id');
    }

    const rows = this.store.getTrackFilesForAlbum(payload.storageId, payload.artist, payload.album);
    if (rows.length === 0) {
      throw new Error('album-not-found');
    }

    const fileResult = await this.deleteAudioFiles(rows);
    const deletedTracks = this.store.deleteTracksForAlbum(payload.storageId, payload.artist, payload.album);
    this.stats = null;
    return { ...fileResult, deletedTracks };
  }

  public async deleteArtistByFolderId(artistId: string): Promise<LibraryDeleteResult> {
    const safeId = String(artistId || '').trim();
    if (!safeId.startsWith('library:artist:')) {
      throw new Error('invalid-artist-id');
    }
    const payload = decodeArtistKey(safeId.slice('library:artist:'.length));
    if (!payload) {
      throw new Error('invalid-artist-id');
    }

    const rows = this.store.getTrackFilesForArtist(payload.storageId, payload.artist);
    if (rows.length === 0) {
      throw new Error('artist-not-found');
    }

    const fileResult = await this.deleteAudioFiles(rows);
    const deletedTracks = this.store.deleteTracksForArtist(payload.storageId, payload.artist);
    this.stats = null;
    return { ...fileResult, deletedTracks };
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

    if (normalized === SD_ROOT_FOLDER_ID || normalized === 'library:sd') {
      return this.buildSdFolder(offset, limit);
    }

    if (normalized === 'library-local') {
      return this.buildStorageFolder('local', 'Local Media', offset, limit);
    }

    if (normalized === SD_ALERTS_FOLDER_ID || normalized === 'alerts://') {
      return this.buildAlertFilesFolder(SD_ALERTS_FOLDER_ID, 'alerts', '', offset, limit);
    }

    if (
      normalized === SD_EVENT_SOUNDS_FOLDER_ID ||
      normalized === 'alerts://Event_Sounds' ||
      normalized === 'alerts://Event_Sounds/'
    ) {
      return this.buildAlertFilesFolder(
        SD_EVENT_SOUNDS_FOLDER_ID,
        'Event_Sounds',
        'Event_Sounds',
        offset,
        limit,
      );
    }

    if (normalized.startsWith('library-nas-') && !/-albums$|-artists$|-tracks$|-folders$/.test(normalized)) {
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

    if (normalized.endsWith('-folders')) {
      const storageId = this.extractStorageId(normalized, '-folders');
      if (!storageId) {
        return null;
      }
      return this.buildDriveFolder(storageId, '', offset, limit);
    }

    if (normalized.startsWith('library:album:')) {
      const key = normalized.slice('library:album:'.length);
      return this.buildAlbumTracks(key, offset, limit);
    }

    if (normalized.startsWith('library:artist:')) {
      const key = normalized.slice('library:artist:'.length);
      return this.buildArtistTracks(key, offset, limit);
    }

    if (normalized.startsWith('library:folder:')) {
      const key = normalized.slice('library:folder:'.length);
      const payload = decodeFolderKey(key);
      if (!payload) {
        return null;
      }
      return this.buildDriveFolder(payload.storageId, payload.relPath, offset, limit);
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
      this.sdSpecialFolderItem(SD_ALERTS_FOLDER_ID, 'alerts', 'alerts://'),
      this.sdSpecialFolderItem(SD_EVENT_SOUNDS_FOLDER_ID, 'Event_Sounds', 'alerts://Event_Sounds'),
      ...storages.map((storage) => this.storageRootItem(String(storage.id), storage.name)),
    ];
    return this.buildFolder('root', 'Local Media', items, offset, limit);
  }

  private async buildSdFolder(offset: number, limit: number): Promise<ContentFolder> {
    const items: ContentFolderItem[] = [
      this.sdSpecialFolderItem(SD_ALERTS_FOLDER_ID, 'alerts', 'alerts://'),
      this.sdSpecialFolderItem(SD_EVENT_SOUNDS_FOLDER_ID, 'Event_Sounds', 'alerts://Event_Sounds'),
    ];
    return this.buildFolder(SD_ROOT_FOLDER_ID, 'SD Card', items, offset, limit);
  }

  private async buildStorageFolder(
    storageId: string,
    label: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder> {
    const prefix = storageId === 'local' ? 'library-local' : `library-nas-${storageId}`;
    const items: ContentFolderItem[] = [
      this.categoryItem(prefix, 'Folders', 'folders', storageId, { tag: 'nas', nas: true }),
      this.categoryItem(prefix, 'Albums', 'albums', storageId, { tag: 'nas', nas: true }),
      this.categoryItem(prefix, 'Artists', 'artists', storageId, { tag: 'nas', nas: true }),
      this.categoryItem(prefix, 'Tracks', 'tracks', storageId, { tag: 'nas', nas: true }),
    ];
    return this.buildFolder(prefix, label, items, offset, limit);
  }

  private async buildAlertFilesFolder(
    id: string,
    name: string,
    relativeDir: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder> {
    const files = await this.listAlertAudioFiles(relativeDir);
    const items = files.map((file) => this.alertFileItem(file.relativePath, file.name, file.duration));
    return this.buildFolder(id, name, items, offset, limit);
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

  private async buildDriveFolder(
    storageId: string,
    relPath: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    const storageRoot = this.getStorageRootRelativePath(storageId);
    const safeRelPath = sanitizeFolderRelPath(relPath);
    const relativeDir = safeRelPath ? path.join(storageRoot, safeRelPath) : storageRoot;
    const absoluteDir = this.resolveSafeLibraryPath(relativeDir);

    let entries: Dirent[];
    try {
      entries = await fsp.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return null;
    }

    const folders = entries
      .filter((entry) => entry.isDirectory())
      .sort(compareDirentNames)
      .map((entry) => this.driveFolderItem(storageId, safeRelPath, entry.name));
    const files = entries
      .filter((entry) => entry.isFile() && isAudioFile(entry.name))
      .sort(compareDirentNames)
      .map((entry) => this.driveTrackItem(storageId, storageRoot, safeRelPath, entry.name));
    const items = [...folders, ...files];
    const folderName = safeRelPath ? path.basename(safeRelPath) : 'Folders';
    const id = safeRelPath
      ? buildFolderId(storageId, safeRelPath)
      : storageId === 'local'
        ? 'library-local-folders'
        : `library-nas-${storageId}-folders`;
    return this.buildFolder(id, folderName, items, offset, limit);
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
    const isLocal = storageId === 'local';
    const id = isLocal ? 'library-local' : `library-nas-${storageId}`;
    const audiopath = isLocal ? 'library:local' : `library:nas:${storageId}`;
    return {
      id,
      name: label,
      type: FILE_TYPE_FOLDER,
      items: 4,
      provider: 'library',
      title: label,
      audiopath,
      nas: true,
      origin: storageId,
      tag: 'nas',
    };
  }

  private sdSpecialFolderItem(id: string, name: string, uri: string): ContentFolderItem {
    return {
      id,
      name,
      type: FILE_TYPE_FOLDER,
      provider: 'library',
      title: name,
      audiopath: uri,
      origin: 'local',
      tag: 'sd',
    };
  }

  private categoryItem(
    prefix: string,
    label: string,
    suffix: 'albums' | 'artists' | 'tracks' | 'folders',
    storageId: string,
    options?: { tag?: string; nas?: boolean },
  ) {
    const audiopath = `library:nas:${storageId}:${suffix}`;
    return {
      id: `${prefix}-${suffix}`,
      name: label,
      type: FILE_TYPE_FOLDER,
      provider: 'library',
      title: label,
      audiopath,
      nas: options?.nas,
      origin: storageId,
      tag: options?.tag,
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
      tag: track.storageId === 'local' ? 'sd' : 'nas',
    };
  }

  private driveFolderItem(storageId: string, parentRelPath: string, name: string): ContentFolderItem {
    const relPath = parentRelPath ? path.join(parentRelPath, name) : name;
    const id = buildFolderId(storageId, relPath);
    return {
      id,
      name,
      type: FILE_TYPE_FOLDER,
      provider: 'library',
      title: name,
      audiopath: id,
      nas: storageId !== 'local',
      origin: storageId,
      tag: storageId === 'local' ? 'sd' : 'nas',
    };
  }

  private driveTrackItem(
    storageId: string,
    storageRoot: string,
    parentRelPath: string,
    fileName: string,
  ): ContentFolderItem {
    const relPath = path.join(storageRoot, parentRelPath, fileName);
    const stored = bestEffortSync(
      () => this.store.findByStoragePath(storageId, relPath),
      { fallback: null, onError: 'debug', log: this.log, label: 'folder track lookup failed' },
    );
    if (stored) {
      return this.trackItem(this.normalizeTrack(stored));
    }
    const baseInfo = createTrackFromPath(relPath);
    const track: LocalTrack = {
      id: relPath,
      relPath,
      storageId,
      title: baseInfo.title,
      album: baseInfo.album,
      artist: baseInfo.artist,
      audiopath: '',
    };
    track.audiopath = this.buildAudiopath(track);
    return this.trackItem(track);
  }

  private alertFileItem(relativePath: string, name: string, duration?: number): ContentFolderItem {
    const uri = `alerts://${encodePath(relativePath)}`;
    return {
      id: `library:alerts:${encodeURIComponent(relativePath)}`,
      name,
      type: FILE_TYPE_FILE,
      audiopath: buildAudiopath(uri, 'track', 'library:local'),
      origin: 'local',
      tag: 'sd',
      duration: typeof duration === 'number' && duration > 0 ? duration : undefined,
    };
  }

  private async listAlertAudioFiles(relativeDir: string): Promise<Array<{ name: string; relativePath: string; duration?: number }>> {
    const baseDir = relativeDir ? path.join(ALERTS_PUBLIC_DIR, relativeDir) : ALERTS_PUBLIC_DIR;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(baseDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const audioEntries = entries.filter((entry) => entry.isFile() && isAudioFile(entry.name));
    const mapped = await Promise.all(
      audioEntries.map(async (entry) => {
        const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
        const absolutePath = path.join(baseDir, entry.name);
        let duration: number | undefined;
        try {
          const meta = await mm.parseFile(absolutePath);
          if (typeof meta.format.duration === 'number' && meta.format.duration > 0) {
            duration = Math.round(meta.format.duration);
          }
        } catch {
          // Ignore probe failures; duration fallback logic will remain active.
        }
        return {
          name: entry.name,
          relativePath,
          duration,
        };
      }),
    );
    return mapped
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  private getStorageRootRelativePath(storageId: string): string {
    return storageId === 'local' ? 'local' : path.join('nas', storageId);
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

  private mapCoverSample(row: AlbumCoverRow): LibraryCoverSample {
    const cacheBust =
      typeof row.last_mtime === 'number' && Number.isFinite(row.last_mtime)
        ? Math.max(0, Math.round(row.last_mtime))
        : undefined;
    const coverurl = row.cover && row.rel_path
      ? this.buildCoverUrl({ relPath: row.rel_path, cover: row.cover }, cacheBust)
      : '';
    return {
      id: buildAlbumId(row.storage_id, row.artist, row.album),
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
      albumArtist: track.album_artist,
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

  private buildCoverUrl(
    track: { relPath: string; cover?: string | null },
    cacheBust?: number,
  ): string {
    if (!track?.cover) {
      return '';
    }
    const host = this.resolveCoverHost();
    const dir = path.dirname(track.relPath);
    const baseUrl = `http://${host}:7090/music/${encodePath(path.join(dir, track.cover))}`;
    if (typeof cacheBust === 'number' && Number.isFinite(cacheBust) && cacheBust > 0) {
      return `${baseUrl}?cb=${cacheBust}`;
    }
    return baseUrl;
  }

  private resolveCoverHost(): string {
    const configured = this.getConfigPort().getSystemConfig().audioserver.ip?.trim();
    if (configured && !isLoopbackHost(configured)) {
      return configured;
    }
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal && net.address && !isLoopbackHost(net.address)) {
          return net.address;
        }
      }
    }
    return configured || '127.0.0.1';
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
    const artist = metadata.artist || baseInfo.artist;

    const track: LocalTrack = {
      id: relPath,
      relPath,
      storageId,
      title: metadata.title || baseInfo.title,
      album: metadata.album || baseInfo.album,
      artist,
      albumArtist: resolveAlbumArtist(metadata, baseInfo, artist),
      audiopath: '',
      duration: metadata.duration,
    };

    track.audiopath = this.buildAudiopath(track);
    track.cover = await this.safeEnsureCoverArt(relPath, metadata.picture, track);

    this.store.insertTrack({
      storageId,
      relPath,
      title: track.title,
      album: track.album,
      artist: track.artist,
      albumArtist: track.albumArtist,
      audiopath: track.audiopath,
      cover: track.cover ?? undefined,
      mtime: fileStat?.mtimeMs ? Math.floor(fileStat.mtimeMs) : undefined,
      size: fileStat?.size,
      duration: track.duration,
    });
  }

  private async safeEnsureCoverArt(
    relPath: string,
    picture: mm.IPicture | undefined,
    track: Pick<LocalTrack, 'title' | 'album' | 'artist'>,
  ): Promise<string | undefined> {
    try {
      return await this.ensureCoverArt(relPath, picture, track);
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
        albumArtist: metadata.common.albumartist || metadata.common.albumartists?.join(', ') || '',
        compilation: metadata.common.compilation === true,
        picture: metadata.common.picture?.[0],
        duration: metadata.format.duration ? Math.round(metadata.format.duration) : undefined,
      };
    } catch {
      return { title: '', album: '', artist: '', albumArtist: '', compilation: false };
    }
  }

  private async ensureCoverArt(
    relPath: string,
    picture: mm.IPicture | undefined,
    track: Pick<LocalTrack, 'title' | 'album' | 'artist'>,
  ): Promise<string | undefined> {
    const dir = path.join(this.baseDir, path.dirname(relPath));

    for (const candidate of COVER_CANDIDATES) {
      if (await fileExists(path.join(dir, candidate))) {
        return candidate;
      }
    }

    if (!picture?.data?.length) {
      return this.fetchAndStoreRemoteCoverArt(relPath, track);
    }

    const extension = resolveCoverExtension(picture.format);
    const fileName = `cover${extension}`;
    const outPath = path.join(dir, fileName);

    await ensureDir(dir);
    const rawBuffer = Buffer.from(picture.data);
    try {
      const image = await Jimp.read(rawBuffer);
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
    } catch (error) {
      // Some embedded cover formats are not decoded by Jimp; store raw bytes as fallback.
      const message = error instanceof Error ? error.message : String(error);
      this.log.debug('cover resize failed; using raw embedded art', { relPath, message });
      await fsp.writeFile(outPath, rawBuffer);
    }
    return fileName;
  }

  private async fetchAndStoreRemoteCoverArt(
    relPath: string,
    track: Pick<LocalTrack, 'title' | 'album' | 'artist'>,
  ): Promise<string | undefined> {
    const album = track.album?.trim() ?? '';
    const artist = track.artist?.trim() ?? '';
    if (!album || !artist) {
      return undefined;
    }
    if (/^unknown\b/i.test(album) || /^unknown\b/i.test(artist)) {
      return undefined;
    }

    const cacheKey = `${album.toLowerCase()}|||${artist.toLowerCase()}`;
    const cached = this.coverLookupCache.get(cacheKey);
    if (cached === null) {
      return undefined;
    }

    let coverUrl = cached;
    if (!coverUrl) {
      const mbid = await this.lookupMusicBrainzReleaseMbid(album, artist);
      if (!mbid) {
        this.log.debug('remote cover lookup: no musicbrainz match', { relPath, artist, album });
        this.coverLookupCache.set(cacheKey, null);
        return undefined;
      }
      coverUrl = `${COVER_ART_ARCHIVE_RELEASE}/${encodeURIComponent(mbid)}/front-500`;
      this.log.info('remote cover lookup: matched musicbrainz release', {
        relPath,
        artist,
        album,
        mbid,
      });
      this.coverLookupCache.set(cacheKey, coverUrl);
    }

    try {
      const response = await fetch(coverUrl);
      if (!response.ok) {
        if (response.status === 404) {
          this.coverLookupCache.set(cacheKey, null);
        }
        this.log.debug('remote cover download failed', {
          relPath,
          artist,
          album,
          status: response.status,
          url: coverUrl,
        });
        return undefined;
      }
      const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();
      const ext = contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : '.jpg';
      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength <= 0 || arrayBuffer.byteLength > COVER_ART_MAX_BYTES) {
        return undefined;
      }
      const outDir = path.join(this.baseDir, path.dirname(relPath));
      const fileName = `cover${ext}`;
      const outPath = path.join(outDir, fileName);
      await ensureDir(outDir);
      await fsp.writeFile(outPath, Buffer.from(arrayBuffer));
      this.log.info('remote cover stored', {
        relPath,
        artist,
        album,
        fileName,
        bytes: arrayBuffer.byteLength,
      });
      return fileName;
    } catch {
      this.log.debug('remote cover download error', { relPath, artist, album, url: coverUrl });
      return undefined;
    }
  }

  private async lookupMusicBrainzReleaseMbid(album: string, artist: string): Promise<string | null> {
    await this.waitForMusicBrainzRateLimit();
    const query = `release:"${escapeMusicBrainzQuery(album)}" AND artist:"${escapeMusicBrainzQuery(artist)}"`;
    const url = new URL(MUSICBRAINZ_ENDPOINT);
    url.searchParams.set('query', query);
    url.searchParams.set('fmt', 'json');
    url.searchParams.set('limit', '5');
    try {
      const response = await fetch(url.toString(), {
        headers: {
          'User-Agent': MUSICBRAINZ_USER_AGENT,
          Accept: 'application/json',
        },
      });
      if (!response.ok) {
        return null;
      }
      const payload = (await response.json()) as {
        releases?: Array<{
          id?: string;
          title?: string;
          score?: number | string;
          'artist-credit'?: Array<{ name?: string; artist?: { name?: string } }>;
        }>;
      };
      const releases = Array.isArray(payload?.releases) ? payload.releases : [];
      if (releases.length === 0) {
        return null;
      }
      const targetAlbum = normalizeMetaText(album);
      const targetArtist = normalizeMetaText(artist);
      const exact = releases.find((release) => {
        const releaseTitle = normalizeMetaText(String(release.title ?? ''));
        const releaseArtist = normalizeMetaText(
          String(release['artist-credit']?.[0]?.name ?? release['artist-credit']?.[0]?.artist?.name ?? ''),
        );
        return releaseTitle === targetAlbum && releaseArtist === targetArtist && release.id;
      });
      if (exact?.id) {
        return exact.id;
      }
      releases.sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));
      return releases[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  private async waitForMusicBrainzRateLimit(): Promise<void> {
    const now = Date.now();
    const waitMs = Math.max(0, this.musicBrainzNextAllowedAt - now);
    this.musicBrainzNextAllowedAt = now + waitMs + 1100;
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
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

  private async deleteAudioFiles(rows: TrackFileRow[]): Promise<{ deletedFiles: number; missingFiles: number }> {
    let deletedFiles = 0;
    let missingFiles = 0;

    for (const row of rows) {
      const filePath = this.resolveSafeLibraryPath(row.rel_path);
      try {
        await fsp.unlink(filePath);
        deletedFiles += 1;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') {
          missingFiles += 1;
          continue;
        }
        throw err;
      }
    }

    return { deletedFiles, missingFiles };
  }

  private resolveSafeLibraryPath(relPath: string): string {
    const normalizedRelPath = String(relPath || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
    const resolved = path.resolve(this.baseDir, normalizedRelPath);
    const baseDir = path.resolve(this.baseDir) + path.sep;
    if (!resolved.startsWith(baseDir)) {
      throw new Error('invalid-library-path');
    }
    return resolved;
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

function buildFolderId(storageId: string, relPath: string): string {
  const key = encodeFolderKey({ storageId, relPath });
  return `library:folder:${key}`;
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

function sanitizeFolderRelPath(value: string): string {
  return String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/');
}

function compareDirentNames(a: Dirent, b: Dirent): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
}

function resolveAlbumArtist(
  metadata: SafeTags,
  baseInfo: Pick<LocalTrack, 'artist'>,
  trackArtist: string,
): string {
  const explicit = metadata.albumArtist.trim();
  if (explicit) {
    return explicit;
  }
  if (metadata.compilation) {
    return 'Various Artists';
  }
  const pathArtist = baseInfo.artist.trim();
  if (pathArtist && !/^unknown\b/i.test(pathArtist)) {
    return pathArtist;
  }
  return trackArtist;
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

function sanitizePathSegment(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\.+/g, '.')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .slice(0, 96)
    .trim();
}

function resolveCoverExtension(format: string | undefined): '.jpg' | '.png' | '.webp' {
  const value = String(format ?? '').toLowerCase();
  if (value.includes('png')) return '.png';
  if (value.includes('webp')) return '.webp';
  return '.jpg';
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function escapeMusicBrainzQuery(value: string): string {
  return value.replace(/[\\"]/g, '\\$&').trim();
}

function normalizeMetaText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
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

function encodeFolderKey(payload: FolderIdPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeFolderKey(raw: string): FolderIdPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as FolderIdPayload;
    if (parsed.storageId && parsed.relPath !== undefined) {
      return { storageId: parsed.storageId, relPath: sanitizeFolderRelPath(parsed.relPath) };
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
