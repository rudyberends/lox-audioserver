import Database from 'better-sqlite3';
import path from 'node:path';
import { ensureDir, resolveDataDir } from '@/shared/utils/file';

export interface TrackInsert {
  storageId: string;
  relPath: string;
  title: string;
  album: string;
  artist: string;
  albumArtist?: string;
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
  album_artist: string;
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
  cover: string | null;
  rel_path: string | null;
  last_mtime: number | null;
}

export interface ArtistCoverInsert {
  storageId: string;
  name: string;
  cover: string;
  relPath: string;
  mtime?: number;
}

export interface TrackFileRow {
  storage_id: string;
  rel_path: string;
  cover: string | null;
}

export class LocalLibraryStore {
  private db: Database.Database | null = null;
  private readonly dbPath: string;

  // Schema versions for `PRAGMA user_version`.
  private static readonly SCHEMA_V2 = 2; // adds FTS5 search table + triggers
  private static readonly SCHEMA_V3 = 3; // adds album artist for album grouping
  private static readonly SCHEMA_V4 = 4; // adds artist_covers sidecar table

  public constructor(options: { dbPath?: string } = {}) {
    this.dbPath = options.dbPath ?? resolveDataDir('music', 'library.db');
  }

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
    db.exec('DELETE FROM artist_covers;');
  }

  public upsertArtistCover(entry: ArtistCoverInsert): void {
    const db = this.requireDb();
    db.prepare(
      `
      INSERT INTO artist_covers (storage_id, name, cover, rel_path, last_mtime)
      VALUES (@storageId, @name, @cover, @relPath, @mtime)
      ON CONFLICT(storage_id, name) DO UPDATE SET
        cover = excluded.cover,
        rel_path = excluded.rel_path,
        last_mtime = excluded.last_mtime
    `,
    ).run({
      storageId: entry.storageId,
      name: entry.name,
      cover: entry.cover,
      relPath: entry.relPath,
      mtime: typeof entry.mtime === 'number' ? entry.mtime : null,
    });
  }

  public insertTrack(track: TrackInsert): void {
    const db = this.requireDb();
    const params = {
      ...track,
      albumArtist: normalizeGroupArtist(track.albumArtist || track.artist),
    };
    const stmt = db.prepare(`
      INSERT INTO tracks (storage_id, rel_path, title, album, artist, album_artist, audiopath, cover, mtime, size, duration)
      VALUES (@storageId, @relPath, @title, @album, @artist, @albumArtist, @audiopath, @cover, @mtime, @size, @duration)
      ON CONFLICT(storage_id, rel_path) DO UPDATE SET
        title = excluded.title,
        album = excluded.album,
        artist = excluded.artist,
        album_artist = excluded.album_artist,
        audiopath = excluded.audiopath,
        cover = excluded.cover,
        mtime = excluded.mtime,
        size = excluded.size,
        duration = excluded.duration
    `);
    stmt.run(params);
  }

  public getStats(): { tracks: number; albums: number; artists: number } {
    const db = this.requireDb();
    const trackCount = db.prepare('SELECT COUNT(*) AS count FROM tracks').get() as { count: number };
    const albumCount = db
      .prepare(
        `SELECT COUNT(*) AS count FROM (
          SELECT storage_id, ${ALBUM_GROUP_EXPR} AS album_group_artist, album
          FROM tracks
          GROUP BY storage_id, album_group_artist, album
        )`,
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
        `SELECT COUNT(*) AS count FROM (
          SELECT storage_id, ${ALBUM_GROUP_EXPR} AS album_group_artist, album
          FROM tracks
          WHERE storage_id = ?
          GROUP BY storage_id, album_group_artist, album
        )`,
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
        `SELECT COUNT(*) AS count FROM (
          SELECT storage_id, ${ALBUM_GROUP_EXPR} AS album_group_artist, album
          FROM tracks
          ${where}
          GROUP BY storage_id, album_group_artist, album
        )`,
      )
      .get(...params) as { count: number };

    const rows = db
      .prepare(
        `
        SELECT storage_id, album, ${ALBUM_GROUP_EXPR} AS artist,
          COUNT(*) AS track_count,
          MAX(NULLIF(cover, '')) AS cover,
          MIN(rel_path) AS rel_path
        FROM tracks
        ${where}
        GROUP BY storage_id, ${ALBUM_GROUP_EXPR}, album
        ORDER BY LOWER(album), LOWER(${ALBUM_GROUP_EXPR})
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
        SELECT storage_id, album, ${ALBUM_GROUP_EXPR} AS artist,
          MAX(NULLIF(cover, '')) AS cover,
          MIN(rel_path) AS rel_path,
          MAX(mtime) AS last_mtime
        FROM tracks
        GROUP BY storage_id, ${ALBUM_GROUP_EXPR}, album
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
        SELECT storage_id, album, ${ALBUM_GROUP_EXPR} AS artist,
          MAX(NULLIF(cover, '')) AS cover,
          MIN(rel_path) AS rel_path,
          MAX(mtime) AS last_mtime
        FROM tracks
        WHERE storage_id = ?
        GROUP BY storage_id, ${ALBUM_GROUP_EXPR}, album
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
        SELECT t.storage_id AS storage_id,
               t.artist AS name,
               COUNT(*) AS track_count,
               ac.cover AS cover,
               ac.rel_path AS rel_path,
               ac.last_mtime AS last_mtime
        FROM tracks t
        LEFT JOIN artist_covers ac
          ON ac.storage_id = t.storage_id AND ac.name = t.artist
        ${where ? where.replace(/storage_id/g, 't.storage_id') : ''}
        GROUP BY t.storage_id, t.artist
        ORDER BY LOWER(t.artist)
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
    albumArtist: string,
    album: string,
    offset: number,
    limit: number,
  ): PagedResult<StoredTrack> {
    const db = this.requireDb();
    const total = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM tracks
         WHERE storage_id = ? AND ${ALBUM_GROUP_EXPR} = ? AND album = ?`,
      )
      .get(storageId, albumArtist, album) as { count: number };
    const rows = db
      .prepare(
        `
        SELECT * FROM tracks
        WHERE storage_id = ? AND ${ALBUM_GROUP_EXPR} = ? AND album = ?
        ORDER BY LOWER(rel_path)
        LIMIT ? OFFSET ?
      `,
      )
      .all(storageId, albumArtist, album, limit, offset) as StoredTrack[];
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

  public findByStoragePath(storageId: string, relPath: string): StoredTrack | null {
    const db = this.requireDb();
    const row = db
      .prepare('SELECT * FROM tracks WHERE storage_id = ? AND rel_path = ? LIMIT 1')
      .get(storageId, relPath) as StoredTrack | undefined;
    return row ?? null;
  }

  public getTrackFilesForAudiopath(audiopath: string): TrackFileRow[] {
    const db = this.requireDb();
    return db
      .prepare(
        `
        SELECT storage_id, rel_path, cover
        FROM tracks
        WHERE audiopath = ?
      `,
      )
      .all(audiopath) as TrackFileRow[];
  }

  public getTrackFilesForAlbum(storageId: string, albumArtist: string, album: string): TrackFileRow[] {
    const db = this.requireDb();
    return db
      .prepare(
        `
        SELECT storage_id, rel_path, cover
        FROM tracks
        WHERE storage_id = ? AND ${ALBUM_GROUP_EXPR} = ? AND album = ?
      `,
      )
      .all(storageId, albumArtist, album) as TrackFileRow[];
  }

  public getTrackFilesForArtist(storageId: string, artist: string): TrackFileRow[] {
    const db = this.requireDb();
    return db
      .prepare(
        `
        SELECT storage_id, rel_path, cover
        FROM tracks
        WHERE storage_id = ? AND artist = ?
      `,
      )
      .all(storageId, artist) as TrackFileRow[];
  }

  public deleteTracksByAudiopath(audiopath: string): number {
    const db = this.requireDb();
    const result = db.prepare('DELETE FROM tracks WHERE audiopath = ?').run(audiopath);
    return result.changes;
  }

  public deleteTracksForAlbum(storageId: string, albumArtist: string, album: string): number {
    const db = this.requireDb();
    const result = db
      .prepare(`DELETE FROM tracks WHERE storage_id = ? AND ${ALBUM_GROUP_EXPR} = ? AND album = ?`)
      .run(storageId, albumArtist, album);
    return result.changes;
  }

  public deleteTracksForArtist(storageId: string, artist: string): number {
    const db = this.requireDb();
    const result = db
      .prepare('DELETE FROM tracks WHERE storage_id = ? AND artist = ?')
      .run(storageId, artist);
    return result.changes;
  }

  public searchTracks(query: string, limit: number): StoredTrack[] {
    const db = this.requireDb();
    const fts = this.toFtsQuery(query);
    if (fts) {
      try {
        return db
          .prepare(
            `
            SELECT t.* FROM tracks_fts
            JOIN tracks t ON t.id = tracks_fts.rowid
            WHERE tracks_fts MATCH ?
            ORDER BY LOWER(t.artist), LOWER(t.album), LOWER(t.title)
            LIMIT ?
          `,
          )
          .all(fts, limit) as StoredTrack[];
      } catch {
        // FTS missing/disabled; fall back to LIKE.
      }
    }

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
    const fts = this.toFtsQuery(query);
    if (fts) {
      try {
        return db
          .prepare(
            `
            SELECT t.storage_id,
                   t.album,
                   ${ALBUM_GROUP_EXPR_T} AS artist,
                   COUNT(*) AS track_count,
                   MAX(t.cover) AS cover,
                   MAX(t.rel_path) AS rel_path
            FROM tracks_fts
            JOIN tracks t ON t.id = tracks_fts.rowid
            WHERE tracks_fts MATCH ?
            GROUP BY t.storage_id, ${ALBUM_GROUP_EXPR_T}, t.album
            ORDER BY LOWER(${ALBUM_GROUP_EXPR_T}), LOWER(t.album)
            LIMIT ?
          `,
          )
          .all(fts, limit) as AlbumRow[];
      } catch {
        // fall back to LIKE
      }
    }

    const like = `%${query.toLowerCase()}%`;
    return db
      .prepare(
        `
          SELECT storage_id,
                 album,
                 ${ALBUM_GROUP_EXPR} AS artist,
                 COUNT(*) AS track_count,
                 MAX(cover) AS cover,
                 MAX(rel_path) AS rel_path
          FROM tracks
          WHERE LOWER(album) LIKE ? OR LOWER(artist) LIKE ? OR LOWER(album_artist) LIKE ?
          GROUP BY storage_id, ${ALBUM_GROUP_EXPR}, album
          ORDER BY LOWER(${ALBUM_GROUP_EXPR}), LOWER(album)
          LIMIT ?
        `,
      )
      .all(like, like, like, limit) as AlbumRow[];
  }

  public searchArtists(query: string, limit: number): ArtistRow[] {
    const db = this.requireDb();
    const fts = this.toFtsQuery(query);
    if (fts) {
      try {
        return db
          .prepare(
            `
            SELECT t.storage_id AS storage_id,
                   t.artist AS name,
                   COUNT(*) AS track_count,
                   ac.cover AS cover,
                   ac.rel_path AS rel_path,
                   ac.last_mtime AS last_mtime
            FROM tracks_fts
            JOIN tracks t ON t.id = tracks_fts.rowid
            LEFT JOIN artist_covers ac
              ON ac.storage_id = t.storage_id AND ac.name = t.artist
            WHERE tracks_fts MATCH ?
            GROUP BY t.storage_id, t.artist
            ORDER BY LOWER(t.artist)
            LIMIT ?
          `,
          )
          .all(fts, limit) as ArtistRow[];
      } catch {
        // fall back to LIKE
      }
    }

    const like = `%${query.toLowerCase()}%`;
    return db
      .prepare(
        `
          SELECT t.storage_id AS storage_id,
                 t.artist AS name,
                 COUNT(*) AS track_count,
                 ac.cover AS cover,
                 ac.rel_path AS rel_path,
                 ac.last_mtime AS last_mtime
          FROM tracks t
          LEFT JOIN artist_covers ac
            ON ac.storage_id = t.storage_id AND ac.name = t.artist
          WHERE LOWER(t.artist) LIKE ?
          GROUP BY t.storage_id, t.artist
          ORDER BY LOWER(t.artist)
          LIMIT ?
        `,
      )
      .all(like, limit) as ArtistRow[];
  }

  private migrate(): void {
    const db = this.requireDb();
    const baseSchema = `
      CREATE TABLE IF NOT EXISTS tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        storage_id TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        title TEXT NOT NULL,
        album TEXT NOT NULL,
        artist TEXT NOT NULL,
        album_artist TEXT NOT NULL DEFAULT '',
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
    `;
    db.exec(baseSchema);

    db.exec(`
      CREATE TABLE IF NOT EXISTS artist_covers (
        storage_id TEXT NOT NULL,
        name TEXT NOT NULL,
        cover TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        last_mtime INTEGER,
        PRIMARY KEY (storage_id, name)
      );
    `);

    const userVersion = Number(db.pragma('user_version', { simple: true }) ?? 0);
    this.ensureAlbumArtistColumn(db);
    db.exec('CREATE INDEX IF NOT EXISTS idx_tracks_album_artist ON tracks(storage_id, album_artist, album);');
    db.exec(`UPDATE tracks SET album_artist = artist WHERE NULLIF(TRIM(album_artist), '') IS NULL;`);

    // Add FTS-backed searching for large libraries. If FTS5 is unavailable, we keep the LIKE fallback.
    if (userVersion >= LocalLibraryStore.SCHEMA_V2 && userVersion < LocalLibraryStore.SCHEMA_V3) {
      this.recreateFts(db);
    } else if (userVersion < LocalLibraryStore.SCHEMA_V2) {
      const enabled = this.tryEnableFts(db);
      if (enabled) {
        // Build the index once for existing databases.
        try {
          db.exec(`INSERT INTO tracks_fts(tracks_fts) VALUES('rebuild');`);
        } catch {
          /* ignore */
        }
      }
    } else {
      // Ensure the virtual table still exists even if user_version was bumped previously.
      this.tryEnableFts(db);
    }

    if (userVersion < LocalLibraryStore.SCHEMA_V4) {
      db.pragma(`user_version = ${LocalLibraryStore.SCHEMA_V4}`);
    }
  }

  private ensureAlbumArtistColumn(db: Database.Database): void {
    const columns = db.prepare('PRAGMA table_info(tracks)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'album_artist')) {
      db.exec(`ALTER TABLE tracks ADD COLUMN album_artist TEXT NOT NULL DEFAULT '';`);
    }
  }

  private recreateFts(db: Database.Database): boolean {
    try {
      db.exec(`
        DROP TRIGGER IF EXISTS tracks_ai;
        DROP TRIGGER IF EXISTS tracks_ad;
        DROP TRIGGER IF EXISTS tracks_au;
        DROP TABLE IF EXISTS tracks_fts;
      `);
    } catch {
      return false;
    }
    const enabled = this.tryEnableFts(db);
    if (enabled) {
      try {
        db.exec(`INSERT INTO tracks_fts(tracks_fts) VALUES('rebuild');`);
      } catch {
        /* ignore */
      }
    }
    return enabled;
  }

  private tryEnableFts(db: Database.Database): boolean {
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts
        USING fts5(title, album, artist, album_artist, content='tracks', content_rowid='id');

        CREATE TRIGGER IF NOT EXISTS tracks_ai AFTER INSERT ON tracks BEGIN
          INSERT INTO tracks_fts(rowid, title, album, artist, album_artist)
          VALUES (new.id, new.title, new.album, new.artist, new.album_artist);
        END;

        CREATE TRIGGER IF NOT EXISTS tracks_ad AFTER DELETE ON tracks BEGIN
          INSERT INTO tracks_fts(tracks_fts, rowid, title, album, artist, album_artist)
          VALUES('delete', old.id, old.title, old.album, old.artist, old.album_artist);
        END;

        CREATE TRIGGER IF NOT EXISTS tracks_au AFTER UPDATE ON tracks BEGIN
          INSERT INTO tracks_fts(tracks_fts, rowid, title, album, artist, album_artist)
          VALUES('delete', old.id, old.title, old.album, old.artist, old.album_artist);
          INSERT INTO tracks_fts(rowid, title, album, artist, album_artist)
          VALUES (new.id, new.title, new.album, new.artist, new.album_artist);
        END;
      `);
      // Touch the table to ensure it's usable.
      db.prepare('SELECT 1 FROM tracks_fts LIMIT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  private toFtsQuery(query: string): string | null {
    const raw = String(query || '').trim().toLowerCase();
    if (!raw) return null;
    const tokens = raw.match(/[a-z0-9]+/g) ?? [];
    if (!tokens.length) return null;
    // Prefix matching keeps "typed as you go" searches responsive.
    return tokens.map((t) => `${t}*`).join(' ');
  }

  private requireDb(): Database.Database {
    if (!this.db) {
      throw new Error('LocalLibraryStore not initialized');
    }
    return this.db;
  }
}

const ALBUM_GROUP_EXPR = "COALESCE(NULLIF(TRIM(album_artist), ''), artist)";
const ALBUM_GROUP_EXPR_T = "COALESCE(NULLIF(TRIM(t.album_artist), ''), t.artist)";

function normalizeGroupArtist(value: string): string {
  const normalized = String(value || '').trim();
  return normalized || 'Unknown Artist';
}
