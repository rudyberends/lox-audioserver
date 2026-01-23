import Database from 'better-sqlite3';
import path from 'node:path';
import { ensureDir, resolveDataDir } from '@/shared/utils/file';

export interface TrackInsert {
  storageId: string;
  relPath: string;
  title: string;
  album: string;
  artist: string;
  audiopath: string;
  cover?: string;
  mtime?: number;
  size?: number;
  duration?: number;
}

export interface StoredTrack {
  id: number;
  storage_id: string;
  rel_path: string;
  title: string;
  album: string;
  artist: string;
  audiopath: string;
  cover?: string | null;
  mtime?: number | null;
  size?: number | null;
  duration?: number | null;
}

export interface PagedResult<T> {
  total: number;
  items: T[];
}

export interface AlbumRow {
  storage_id: string;
  album: string;
  artist: string;
  track_count: number;
  cover: string | null;
  rel_path: string | null;
}

export interface AlbumCoverRow {
  storage_id: string;
  album: string;
  artist: string;
  cover: string | null;
  rel_path: string | null;
  last_mtime: number | null;
}

export interface ArtistRow {
  storage_id: string;
  name: string;
  track_count: number;
}

export class LocalLibraryStore {
  private db: Database.Database | null = null;
  private readonly dbPath = resolveDataDir('music', 'library.db');

  public async init(): Promise<void> {
    await ensureDir(path.dirname(this.dbPath));
    if (this.db) {
      return;
    }
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -64000');
    this.migrate();
  }

  public reset(): void {
    const db = this.requireDb();
    db.exec('DELETE FROM tracks;');
  }

  public insertTrack(track: TrackInsert): void {
    const db = this.requireDb();
    const stmt = db.prepare(`
      INSERT INTO tracks (storage_id, rel_path, title, album, artist, audiopath, cover, mtime, size, duration)
      VALUES (@storageId, @relPath, @title, @album, @artist, @audiopath, @cover, @mtime, @size, @duration)
      ON CONFLICT(storage_id, rel_path) DO UPDATE SET
        title = excluded.title,
        album = excluded.album,
        artist = excluded.artist,
        audiopath = excluded.audiopath,
        cover = excluded.cover,
        mtime = excluded.mtime,
        size = excluded.size,
        duration = excluded.duration
    `);
    stmt.run(track);
  }

  public getStats(): { tracks: number; albums: number; artists: number } {
    const db = this.requireDb();
    const trackCount = db.prepare('SELECT COUNT(*) AS count FROM tracks').get() as { count: number };
    const albumCount = db
      .prepare(
        'SELECT COUNT(*) AS count FROM (SELECT storage_id, artist, album FROM tracks GROUP BY storage_id, artist, album)',
      )
      .get() as { count: number };
    const artistCount = db
      .prepare(
        'SELECT COUNT(*) AS count FROM (SELECT storage_id, artist FROM tracks GROUP BY storage_id, artist)',
      )
      .get() as { count: number };
    return { tracks: trackCount.count, albums: albumCount.count, artists: artistCount.count };
  }

  public getStatsForStorage(storageId: string): { tracks: number; albums: number; artists: number } {
    const db = this.requireDb();
    const trackCount = db
      .prepare('SELECT COUNT(*) AS count FROM tracks WHERE storage_id = ?')
      .get(storageId) as { count: number };
    const albumCount = db
      .prepare(
        'SELECT COUNT(*) AS count FROM (SELECT storage_id, artist, album FROM tracks WHERE storage_id = ? GROUP BY storage_id, artist, album)',
      )
      .get(storageId) as { count: number };
    const artistCount = db
      .prepare(
        'SELECT COUNT(*) AS count FROM (SELECT storage_id, artist FROM tracks WHERE storage_id = ? GROUP BY storage_id, artist)',
      )
      .get(storageId) as { count: number };
    return { tracks: trackCount.count, albums: albumCount.count, artists: artistCount.count };
  }

  public getAlbums(
    storageId: string | null,
    offset: number,
    limit: number,
  ): PagedResult<AlbumRow> {
    const db = this.requireDb();
    const params: (string | number)[] = [];
    let where = '';
    if (storageId) {
      where = 'WHERE storage_id = ?';
      params.push(storageId);
    }
    const total = db
      .prepare(
        `SELECT COUNT(*) AS count FROM (SELECT storage_id, artist, album FROM tracks ${where} GROUP BY storage_id, artist, album)`,
      )
      .get(...params) as { count: number };

    const rows = db
      .prepare(
        `
        SELECT storage_id, album, artist,
          COUNT(*) AS track_count,
          MAX(NULLIF(cover, '')) AS cover,
          MIN(rel_path) AS rel_path
        FROM tracks
        ${where}
        GROUP BY storage_id, artist, album
        ORDER BY LOWER(album), LOWER(artist)
        LIMIT ? OFFSET ?
      `,
      )
      .all(...params, limit, offset) as AlbumRow[];

    return { total: total.count, items: rows };
  }

  public getAlbumCoverSamples(limit: number): AlbumCoverRow[] {
    const db = this.requireDb();
    return db
      .prepare(
        `
        SELECT storage_id, album, artist,
          MAX(NULLIF(cover, '')) AS cover,
          MIN(rel_path) AS rel_path,
          MAX(mtime) AS last_mtime
        FROM tracks
        WHERE cover IS NOT NULL AND cover <> ''
        GROUP BY storage_id, artist, album
        ORDER BY last_mtime DESC, LOWER(album)
        LIMIT ?
      `,
      )
      .all(limit) as AlbumCoverRow[];
  }

  public getAlbumCoverSamplesForStorage(storageId: string, limit: number): AlbumCoverRow[] {
    const db = this.requireDb();
    return db
      .prepare(
        `
        SELECT storage_id, album, artist,
          MAX(NULLIF(cover, '')) AS cover,
          MIN(rel_path) AS rel_path,
          MAX(mtime) AS last_mtime
        FROM tracks
        WHERE storage_id = ? AND cover IS NOT NULL AND cover <> ''
        GROUP BY storage_id, artist, album
        ORDER BY last_mtime DESC, LOWER(album)
        LIMIT ?
      `,
      )
      .all(storageId, limit) as AlbumCoverRow[];
  }

  public getArtists(
    storageId: string | null,
    offset: number,
    limit: number,
  ): PagedResult<ArtistRow> {
    const db = this.requireDb();
    const params: (string | number)[] = [];
    let where = '';
    if (storageId) {
      where = 'WHERE storage_id = ?';
      params.push(storageId);
    }
    const total = db
      .prepare(
        `SELECT COUNT(*) AS count FROM (SELECT storage_id, artist FROM tracks ${where} GROUP BY storage_id, artist)`,
      )
      .get(...params) as { count: number };

    const rows = db
      .prepare(
        `
        SELECT storage_id, artist AS name, COUNT(*) AS track_count
        FROM tracks
        ${where}
        GROUP BY storage_id, artist
        ORDER BY LOWER(artist)
        LIMIT ? OFFSET ?
      `,
      )
      .all(...params, limit, offset) as ArtistRow[];

    return { total: total.count, items: rows };
  }

  public getTracks(
    storageId: string | null,
    offset: number,
    limit: number,
  ): PagedResult<StoredTrack> {
    const db = this.requireDb();
    const params: (string | number)[] = [];
    let where = '';
    if (storageId) {
      where = 'WHERE storage_id = ?';
      params.push(storageId);
    }
    const total = db
      .prepare(`SELECT COUNT(*) AS count FROM tracks ${where}`)
      .get(...params) as { count: number };
    const rows = db
      .prepare(
        `
        SELECT * FROM tracks
        ${where}
        ORDER BY LOWER(artist), LOWER(album), LOWER(title)
        LIMIT ? OFFSET ?
      `,
      )
      .all(...params, limit, offset) as StoredTrack[];
    return { total: total.count, items: rows };
  }

  public getTracksForAlbum(
    storageId: string,
    artist: string,
    album: string,
    offset: number,
    limit: number,
  ): PagedResult<StoredTrack> {
    const db = this.requireDb();
    const total = db
      .prepare(
        'SELECT COUNT(*) AS count FROM tracks WHERE storage_id = ? AND artist = ? AND album = ?',
      )
      .get(storageId, artist, album) as { count: number };
    const rows = db
      .prepare(
        `
        SELECT * FROM tracks
        WHERE storage_id = ? AND artist = ? AND album = ?
        ORDER BY LOWER(rel_path)
        LIMIT ? OFFSET ?
      `,
      )
      .all(storageId, artist, album, limit, offset) as StoredTrack[];
    return { total: total.count, items: rows };
  }

  public getTracksForArtist(
    storageId: string,
    artist: string,
    offset: number,
    limit: number,
  ): PagedResult<StoredTrack> {
    const db = this.requireDb();
    const total = db
      .prepare(
        'SELECT COUNT(*) AS count FROM tracks WHERE storage_id = ? AND artist = ?',
      )
      .get(storageId, artist) as { count: number };
    const rows = db
      .prepare(
        `
        SELECT * FROM tracks
        WHERE storage_id = ? AND artist = ?
        ORDER BY LOWER(album), LOWER(rel_path)
        LIMIT ? OFFSET ?
      `,
      )
      .all(storageId, artist, limit, offset) as StoredTrack[];
    return { total: total.count, items: rows };
  }

  public findByAudiopath(audiopath: string): StoredTrack | null {
    const db = this.requireDb();
    const row = db
      .prepare('SELECT * FROM tracks WHERE audiopath = ? LIMIT 1')
      .get(audiopath) as StoredTrack | undefined;
    return row ?? null;
  }

  public searchTracks(query: string, limit: number): StoredTrack[] {
    const db = this.requireDb();
    const like = `%${query.toLowerCase()}%`;
    return db
      .prepare(
        `
        SELECT * FROM tracks
        WHERE LOWER(title) LIKE ? OR LOWER(artist) LIKE ? OR LOWER(album) LIKE ?
        ORDER BY LOWER(artist), LOWER(album), LOWER(title)
        LIMIT ?
      `,
      )
      .all(like, like, like, limit) as StoredTrack[];
  }

  public searchAlbums(query: string, limit: number): AlbumRow[] {
    const db = this.requireDb();
    const like = `%${query.toLowerCase()}%`;
    return db
      .prepare(
        `
        SELECT storage_id,
               album,
               artist,
               COUNT(*) AS track_count,
               MAX(cover) AS cover,
               MAX(rel_path) AS rel_path
        FROM tracks
        WHERE LOWER(album) LIKE ? OR LOWER(artist) LIKE ?
        GROUP BY storage_id, artist, album
        ORDER BY LOWER(artist), LOWER(album)
        LIMIT ?
      `,
      )
      .all(like, like, limit) as AlbumRow[];
  }

  public searchArtists(query: string, limit: number): ArtistRow[] {
    const db = this.requireDb();
    const like = `%${query.toLowerCase()}%`;
    return db
      .prepare(
        `
        SELECT storage_id,
               artist AS name,
               COUNT(*) AS track_count
        FROM tracks
        WHERE LOWER(artist) LIKE ?
        GROUP BY storage_id, artist
        ORDER BY LOWER(artist)
        LIMIT ?
      `,
      )
      .all(like, limit) as ArtistRow[];
  }

  private migrate(): void {
    const db = this.requireDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        storage_id TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        title TEXT NOT NULL,
        album TEXT NOT NULL,
        artist TEXT NOT NULL,
        audiopath TEXT NOT NULL,
        cover TEXT,
        mtime INTEGER,
        size INTEGER,
        duration REAL,
        UNIQUE(storage_id, rel_path)
      );
      CREATE INDEX IF NOT EXISTS idx_tracks_storage ON tracks(storage_id);
      CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(storage_id, album);
      CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(storage_id, artist);
      CREATE INDEX IF NOT EXISTS idx_tracks_audiopath ON tracks(audiopath);
    `);
  }

  private requireDb(): Database.Database {
    if (!this.db) {
      throw new Error('LocalLibraryStore not initialized');
    }
    return this.db;
  }
}
