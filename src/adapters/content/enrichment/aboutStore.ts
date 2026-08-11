/**
 * The persistent cache behind `GET /items/{id}/about`.
 *
 * Three properties decide the shape, and all three come from what is being cached:
 *
 * - **It survives restarts.** A biography took four upstream requests and a couple of seconds of
 *   rate-limited waiting to assemble; losing that because a container was restarted would make
 *   every panel in the house re-earn it.
 * - **It remembers misses.** Most items have no article, and an unremembered miss is the
 *   expensive case: a browse page full of local albums would re-ask MusicBrainz about all of them
 *   on every visit. A miss is cheap to store and is the answer far more often than a hit.
 * - **It expires slowly.** A biography changes on the timescale of a career.
 *
 * SQLite rather than a JSON file because a JSON file is rewritten whole on every write, and this
 * is written once per item ever seen. `better-sqlite3` is already a dependency for the library
 * index; the file is separate from `library.db` because nothing here belongs to the local
 * library — an Apple Music artist has a story too.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from '@/shared/logging/logger';
import { resolveDataDir } from '@/shared/utils/file';

const log = createLogger('Content', 'AboutStore');

/** A hit keeps for a month; prose about a band does not churn. */
const HIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A miss keeps for a week — long enough to stop the re-asking, short enough that an artist who
 * gets a Wikipedia article this month is not invisible until next year.
 */
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type CachedAbout<T> = { value: T | null; fresh: boolean };

export class AboutStore {
  private db: Database.Database | null = null;
  private broken = false;
  private readonly dbPath: string;

  public constructor(options: { dbPath?: string } = {}) {
    this.dbPath = options.dbPath ?? resolveDataDir('enrichment', 'about.db');
  }

  /**
   * Opens on first use rather than at boot.
   *
   * A cache nobody asks about should not create a file, and this one is only reached from a route
   * that many installations never call. Opening lazily also keeps the failure local: a disk that
   * will not take the database costs the about panel and nothing else.
   */
  private open(): Database.Database | null {
    if (this.db) {
      return this.db;
    }
    if (this.broken) {
      return null;
    }
    try {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
      const db = new Database(this.dbPath);
      db.pragma('journal_mode = WAL');
      db.exec(`
        CREATE TABLE IF NOT EXISTS about_cache (
          key TEXT PRIMARY KEY,
          payload TEXT,
          fetched_at INTEGER NOT NULL
        );
      `);
      this.db = db;
      return db;
    } catch (error) {
      // Once, not on every lookup: a broken cache degrades to "always a miss", and saying so a
      // thousand times would bury the reason it broke.
      this.broken = true;
      log.warn('about cache unavailable', {
        dbPath: this.dbPath,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * What is stored for a key.
   *
   * `value: null` is a remembered miss, which is why the two are reported separately from
   * `fresh`: a caller has to be able to tell "we know there is nothing" from "we do not know",
   * and only the second is worth an upstream request. A stale row is returned anyway — serving
   * last month's biography beats serving nothing while four requests are in flight.
   */
  public get<T>(key: string): CachedAbout<T> | null {
    const db = this.open();
    if (!db) {
      return null;
    }
    try {
      const row = db
        .prepare('SELECT payload, fetched_at FROM about_cache WHERE key = ?')
        .get(key) as { payload: string | null; fetched_at: number } | undefined;
      if (!row) {
        return null;
      }
      const age = Date.now() - Number(row.fetched_at);
      const ttl = row.payload === null ? MISS_TTL_MS : HIT_TTL_MS;
      const value = row.payload === null ? null : (JSON.parse(row.payload) as T);
      return { value, fresh: age < ttl };
    } catch (error) {
      log.debug('about cache read failed', {
        key,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Stores a story, or a miss when there is none. */
  public put(key: string, value: unknown | null): void {
    const db = this.open();
    if (!db) {
      return;
    }
    try {
      db.prepare(
        `INSERT INTO about_cache (key, payload, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
      ).run(key, value === null ? null : JSON.stringify(value), Date.now());
    } catch (error) {
      log.debug('about cache write failed', {
        key,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public close(): void {
    this.db?.close();
    this.db = null;
  }
}
