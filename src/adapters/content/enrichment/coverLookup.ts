/**
 * A cover for music that arrived without one.
 *
 * Some sources hand over a picture; a phone over Bluetooth does not. AVRCP has carried cover art
 * since 1.6 over a separate OBEX channel, and iOS does not offer it — measured, not assumed: the
 * track dictionary from an iPhone holds title, artist, album, genre, duration and position, and no
 * image handle at all.
 *
 * So the cover is found from the names instead: MusicBrainz for the release, the Cover Art Archive
 * for its front. Both are free and need no key, which is what keeps this shippable in a server
 * anyone can run — the same chain the library already uses for files whose tags carry no artwork.
 *
 * Every answer is remembered, including "there isn't one": the alternative is asking the same
 * question of a rate-limited service every time a track comes round again.
 */
import { createLogger } from '@/shared/logging/logger';
import {
  EnrichmentUnavailable,
  escapeMusicBrainzQuery,
  musicBrainzJson,
} from '@/adapters/content/enrichment/musicBrainz';

const log = createLogger('Content', 'CoverLookup');

const COVER_ART_ARCHIVE = 'https://coverartarchive.org/release';
/** Big enough for a full-screen player, small enough to arrive quickly. */
const COVER_SIZE = 500;
/**
 * How long a "there is no cover" answer stands.
 *
 * A miss is nearly always permanent — an obscure single, a mistagged album — so it is worth
 * remembering for a good while. Not forever, because releases do get artwork added.
 */
const MISS_TTL_MS = 24 * 60 * 60 * 1000;
/** Enough for an evening's listening without growing without bound. */
const MAX_ENTRIES = 500;

type Entry = { url: string | null; at: number };

const cache = new Map<string, Entry>();
/** In-flight lookups, so the same track starting in two rooms asks once. */
const pending = new Map<string, Promise<string | null>>();

type ReleaseSearch = {
  releases?: Array<{ id?: string; score?: number }>;
};

/**
 * The album as a catalogue would list it.
 *
 * Apple appends the release format to the title — "Sweet Memories - Single", "'90s EP - Single" —
 * and MusicBrainz stores neither suffix, so the search finds nothing for exactly the records a
 * phone is most likely to be playing. Taken from what an iPhone actually sent, not from a guess.
 */
function withoutReleaseSuffix(album: string): string {
  return album.replace(/\s*[-–]\s*(single|ep)\s*$/i, '').trim() || album;
}

function key(artist: string, album: string): string {
  // A separator that cannot appear in either name, so "a b" and "c" never collide with "a" and
  // "b c" -- the same trick the playlist collage and the Subsonic token use.
  return [artist.trim().toLowerCase(), album.trim().toLowerCase()].join('\u0000');
}

function remember(cacheKey: string, url: string | null): void {
  if (cache.size >= MAX_ENTRIES) {
    // Oldest first: a Map keeps insertion order, and the track played longest ago is the one least
    // likely to be asked for next.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(cacheKey, { url, at: Date.now() });
}

/**
 * The front cover for an album, or null when there is none to be had.
 *
 * Both names are required. A title alone matches half the catalogue, and a cover that belongs to
 * someone else's record is worse than no cover at all.
 */
export async function lookupCoverUrl(
  artist: string | undefined,
  album: string | undefined,
): Promise<string | null> {
  const cleanArtist = artist?.trim() ?? '';
  const cleanAlbum = album?.trim() ?? '';
  if (!cleanArtist || !cleanAlbum) {
    return null;
  }
  const cacheKey = key(cleanArtist, cleanAlbum);
  const cached = cache.get(cacheKey);
  if (cached && (cached.url !== null || Date.now() - cached.at < MISS_TTL_MS)) {
    return cached.url;
  }
  const inFlight = pending.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const lookup = (async (): Promise<string | null> => {
    try {
      const searchAlbum = withoutReleaseSuffix(cleanAlbum);
      const query = `release:"${escapeMusicBrainzQuery(searchAlbum)}" AND artist:"${escapeMusicBrainzQuery(cleanArtist)}"`;
      const found = await musicBrainzJson<ReleaseSearch>('release', { query, limit: '1' });
      const release = found?.releases?.[0];
      if (!release?.id) {
        log.debug('no release matched', { artist: cleanArtist, album: cleanAlbum });
        remember(cacheKey, null);
        return null;
      }
      const url = `${COVER_ART_ARCHIVE}/${encodeURIComponent(release.id)}/front-${COVER_SIZE}`;
      log.info('cover found', { artist: cleanArtist, album: cleanAlbum, mbid: release.id });
      remember(cacheKey, url);
      return url;
    } catch (error) {
      // Unreachable is not the same as "no cover": remembering a rate-limited minute as a permanent
      // answer would leave a room without artwork until the server restarts.
      if (!(error instanceof EnrichmentUnavailable)) {
        log.debug('cover lookup failed', {
          artist: cleanArtist,
          album: cleanAlbum,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return null;
    } finally {
      pending.delete(cacheKey);
    }
  })();

  pending.set(cacheKey, lookup);
  return lookup;
}

/** Forget everything. For tests, and for a server told its enrichment settings changed. */
export function clearCoverLookupCache(): void {
  cache.clear();
  pending.clear();
}
