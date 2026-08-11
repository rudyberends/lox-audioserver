/**
 * Shared access to MusicBrainz — one queue for the whole process.
 *
 * MusicBrainz asks for one request per second per application, and it means per *application*:
 * two callers each politely waiting a second between their own requests still send two a second
 * between them, which is how a server ends up rate-limited while every caller believes it is
 * behaving. So the gate lives here, module-scoped, and both the library's artist-art fetcher and
 * the about lookups pass through it.
 *
 * No API key, deliberately: MusicBrainz, Wikidata and Wikipedia are the one enrichment chain that
 * needs none, which is what makes it shippable in an open server that anyone can run.
 */
import { createLogger } from '@/shared/logging/logger';

const log = createLogger('Content', 'MusicBrainz');

const ENDPOINT = 'https://musicbrainz.org/ws/2';

/**
 * Identifies us to MusicBrainz, as their policy requires.
 *
 * A contact URL rather than an email: it is the same information, published once, and it does not
 * put a person's address in every request a stranger's server makes.
 */
export const MUSICBRAINZ_USER_AGENT = 'sonn-core/1.0 (+https://github.com/sonn-audio)';

/** A little over a second, because their limiter counts arrival time and ours counts departure. */
const MIN_INTERVAL_MS = 1100;

let nextAllowedAt = 0;

/**
 * Waits until this process may send another MusicBrainz request.
 *
 * The slot is claimed *before* awaiting, so callers queue in the order they arrived rather than
 * all waking to the same instant — safe because the arithmetic runs to completion before any
 * other caller can observe it.
 */
export async function waitForMusicBrainzSlot(): Promise<void> {
  const now = Date.now();
  const waitMs = Math.max(0, nextAllowedAt - now);
  nextAllowedAt = now + waitMs + MIN_INTERVAL_MS;
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

/**
 * Raised when the question could not be asked, as opposed to answered with "nothing".
 *
 * The distinction is the whole point of the type: a caller that caches a miss for a week must not
 * cache a rate-limited minute as one. Anything transient — 429, 5xx, a dropped connection, a
 * timeout — arrives as this rather than as an empty answer.
 */
export class EnrichmentUnavailable extends Error {
  public constructor(detail: string) {
    super(`enrichment source unavailable: ${detail}`);
    this.name = 'EnrichmentUnavailable';
  }
}

/**
 * One rate-limited MusicBrainz call.
 *
 * Null means MusicBrainz answered and had nothing — an unknown artist. A failure to *reach* it
 * throws {@link EnrichmentUnavailable} instead, because the two deserve opposite treatment
 * upstream: one is a fact worth remembering, the other is a minute worth forgetting.
 */
export async function musicBrainzJson<T>(
  path: string,
  params: Record<string, string>,
): Promise<T | null> {
  await waitForMusicBrainzSlot();
  const url = new URL(`${ENDPOINT}/${path}`);
  url.searchParams.set('fmt', 'json');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  try {
    const response = await fetch(url.toString(), {
      headers: { 'User-Agent': MUSICBRAINZ_USER_AGENT, Accept: 'application/json' },
    });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      log.debug('musicbrainz request failed', { path, status: response.status });
      throw new EnrichmentUnavailable(`musicbrainz ${response.status}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof EnrichmentUnavailable) {
      throw error;
    }
    log.debug('musicbrainz request error', {
      path,
      message: error instanceof Error ? error.message : String(error),
    });
    throw new EnrichmentUnavailable(error instanceof Error ? error.message : String(error));
  }
}

/** Escapes a name for a Lucene query, which is what MusicBrainz search speaks. */
export function escapeMusicBrainzQuery(value: string): string {
  return value.replace(/(["\\])/g, '\\$1');
}
