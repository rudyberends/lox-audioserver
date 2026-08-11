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
 * One rate-limited MusicBrainz call, or null when it did not answer usefully.
 *
 * Null rather than a throw for every failure a caller cannot act on differently — an unknown
 * artist, a 503, a timeout — because the only response to any of them is "no story here".
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
    if (!response.ok) {
      log.debug('musicbrainz request failed', { path, status: response.status });
      return null;
    }
    return (await response.json()) as T;
  } catch (error) {
    log.debug('musicbrainz request error', {
      path,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Escapes a name for a Lucene query, which is what MusicBrainz search speaks. */
export function escapeMusicBrainzQuery(value: string): string {
  return value.replace(/(["\\])/g, '\\$1');
}
