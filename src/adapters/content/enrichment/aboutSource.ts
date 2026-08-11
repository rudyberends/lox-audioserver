/**
 * Where the story around an item comes from: MusicBrainz → Wikidata → Wikipedia.
 *
 * The chain is chosen for what it does *not* need. Every other option — TheAudioDB, fanart.tv,
 * last.fm — wants an API key, and a key is a thing every operator of this server would have to
 * register for themselves before an artist page said anything at all. This chain needs none, is
 * freely licensed, and is already how the library finds artist photographs.
 *
 * What each link contributes:
 *
 * - **MusicBrainz** identifies the artist or album (a name is not an identity — there are four
 *   bands called Low) and carries the relations: the Wikidata link, and the other artists this
 *   one is actually connected to.
 * - **Wikidata** turns that link into a Wikipedia page title, in the language asked for.
 * - **Wikipedia** provides the prose, as the article's intro — the part that says who someone is
 *   rather than which festival they played in 2014.
 *
 * `relatedNames` are *names*, not items: turning them into things a caller can open means asking
 * the configured providers, which is a content-layer concern and lives in `AboutService`. A name
 * this house has no copy of resolves to nothing and is dropped, because a tile you cannot open is
 * a caption.
 */
import {
  escapeMusicBrainzQuery,
  musicBrainzJson,
  MUSICBRAINZ_USER_AGENT,
} from '@/adapters/content/enrichment/musicBrainz';
import { createLogger } from '@/shared/logging/logger';

const log = createLogger('Content', 'About');

/**
 * How many candidates to weigh before deciding which entity was meant.
 *
 * One is not enough, and the failure is quiet: a search for *The Fat of the Land* scores
 * *The Fat of the Land 25th Anniversary – Remixes* at 100, which is a perfectly good match for a
 * different record. Asking for a handful and preferring the one whose title actually is the one
 * asked for costs the same single request.
 */
const CANDIDATES = 10;

/**
 * How many related acts to carry out of MusicBrainz.
 *
 * A well-connected artist has dozens of relations, each one costing a provider search later.
 * Twelve leaves room for the shelf to fill after the ones this house does not own are dropped.
 */
const MAX_RELATED = 12;

/** Long enough for any intro worth reading; a guard against an article that is a book. */
const MAX_DESCRIPTION = 4000;

export type AboutStory = {
  description: string | null;
  source: { name: string; url: string | null } | null;
  /** Related acts by name, still to be resolved against the configured providers. */
  relatedNames: string[];
};

type MbRelation = {
  'target-type'?: string;
  type?: string;
  url?: { resource?: string };
  artist?: { id?: string; name?: string };
};

/**
 * Which artist-to-artist relations belong on a "beside this" shelf.
 *
 * MusicBrainz links people as thoroughly as it links music: managers, spouses, siblings and
 * teachers are all relations, and every one of them would arrive as a tile under a heading that
 * promises music you might play next. An allowlist rather than a denylist, because the set of
 * musical relations is small and known while the set of everything else keeps growing.
 */
const MUSICAL_RELATIONS = new Set([
  'member of band',
  'collaboration',
  'founder',
  'supporting musician',
  'subgroup',
  'tribute',
]);

/** The story about an artist, or null when MusicBrainz cannot even identify them. */
export async function fetchArtistStory(artist: string): Promise<AboutStory | null> {
  const trimmed = artist.trim();
  if (!trimmed) {
    return null;
  }

  const search = await musicBrainzJson<{
    artists?: Array<{ id?: string; score?: number; name?: string }>;
  }>('artist', {
    query: `artist:"${escapeMusicBrainzQuery(trimmed)}"`,
    limit: String(CANDIDATES),
  });
  const mbid = pickMbid(search?.artists, trimmed, (candidate) => candidate.name);
  if (!mbid) {
    return null;
  }

  const detail = await musicBrainzJson<{ relations?: MbRelation[] }>(`artist/${mbid}`, {
    inc: 'url-rels+artist-rels',
  });
  const relations = detail?.relations ?? [];

  const relatedNames = dedupeNames(
    relations
      .filter(
        (relation) =>
          relation['target-type'] === 'artist' &&
          MUSICAL_RELATIONS.has((relation.type ?? '').toLowerCase()),
      )
      .map((relation) => relation.artist?.name ?? '')
      .filter((name) => name && name.toLowerCase() !== trimmed.toLowerCase()),
  ).slice(0, MAX_RELATED);

  const prose = await proseFromRelations(relations);
  if (!prose && relatedNames.length === 0) {
    return null;
  }
  return { description: prose?.text ?? null, source: prose?.source ?? null, relatedNames };
}

/**
 * The story about an album.
 *
 * Fewer albums than artists have an article, so this returns null far more often — which is the
 * ordinary answer, not a failure. The artist narrows the search: album titles collide constantly
 * (`Greatest Hits`), and the wrong album's review is worse than none.
 */
export async function fetchAlbumStory(
  album: string,
  artist: string | null,
): Promise<AboutStory | null> {
  const trimmed = album.trim();
  if (!trimmed) {
    return null;
  }

  // The artist is a hint, not a filter. Anded in, it *removed* the right answer: MusicBrainz
  // credits The Prodigy's own album to "Prodigy", so `AND artist:"The Prodigy"` left only a
  // remix edition released under the other spelling — a perfect-scoring match for the wrong
  // record. As a loose term it merely ranks the right one up, and the check below decides.
  const terms = [`releasegroup:"${escapeMusicBrainzQuery(trimmed)}"`];
  if (artist?.trim()) {
    terms.push(`artist:"${escapeMusicBrainzQuery(artist.trim())}"`);
  }
  const search = await musicBrainzJson<{
    'release-groups'?: Array<{
      id?: string;
      score?: number;
      title?: string;
      'artist-credit'?: Array<{ name?: string; artist?: { name?: string } }>;
    }>;
  }>('release-group', { query: terms.join(' '), limit: String(CANDIDATES) });
  const mbid = pickMbid(
    search?.['release-groups'],
    trimmed,
    (candidate) => candidate.title,
    artist
      ? (candidate) =>
        (candidate['artist-credit'] ?? [])
          .map((credit) => credit.artist?.name ?? credit.name ?? '')
          .some((name) => sameAct(name, artist))
      : undefined,
  );
  if (!mbid) {
    return null;
  }

  const detail = await musicBrainzJson<{ relations?: MbRelation[] }>(`release-group/${mbid}`, {
    inc: 'url-rels',
  });
  const prose = await proseFromRelations(detail?.relations ?? []);
  if (!prose) {
    return null;
  }
  return { description: prose.text, source: prose.source, relatedNames: [] };
}

/**
 * The candidate that is actually the thing asked for, or null.
 *
 * Not by score — by name. MusicBrainz ranks a remix edition of the same title at 100 and the
 * album itself at 69, so a score threshold keeps the wrong record and throws away the right one.
 * The title (and the credit, where the caller knows it) is the check instead: loose enough to
 * survive punctuation and accents, and no looser, because a near miss here is a biography of the
 * wrong band — which reads as data and is worse than the blank page it replaced.
 */
function pickMbid<T extends { id?: string; score?: number }>(
  candidates: T[] | undefined,
  wanted: string,
  titleOf: (candidate: T) => string | undefined,
  byArtist?: (candidate: T) => boolean,
): string | null {
  const target = normalizeTitle(wanted);
  for (const candidate of candidates ?? []) {
    if (!candidate.id) {
      continue;
    }
    if (normalizeTitle(titleOf(candidate) ?? '') !== target) {
      continue;
    }
    if (byArtist && !byArtist(candidate)) {
      continue;
    }
    return candidate.id;
  }
  return null;
}

/**
 * Whether two credits name the same act.
 *
 * A leading article is dropped on both sides because catalogues disagree about it constantly —
 * *The Prodigy* on Apple Music is *Prodigy* in MusicBrainz — and no two different bands are told
 * apart by it alone.
 */
function sameAct(a: string, b: string): boolean {
  return normalizeTitle(a.replace(/^the\s+/i, '')) === normalizeTitle(b.replace(/^the\s+/i, ''));
}

function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function dedupeNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const key = name.trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(name.trim());
  }
  return out;
}

/**
 * Prose for whatever these relations point at.
 *
 * Wikidata first because it survives renames — a Wikipedia article that moves keeps its Wikidata
 * item, and MusicBrainz's direct Wikipedia links are often the old title. The direct link is the
 * fallback for entries that have one and no Wikidata item.
 */
async function proseFromRelations(
  relations: MbRelation[],
): Promise<{ text: string; source: { name: string; url: string | null } } | null> {
  const urls = relations.map((relation) => relation.url?.resource ?? '').filter(Boolean);

  const wikidataId = urls.map(matchWikidataId).find(Boolean);
  if (wikidataId) {
    const title = await wikipediaTitleForWikidata(wikidataId);
    if (title) {
      const prose = await wikipediaIntro(title);
      if (prose) {
        return prose;
      }
    }
  }

  const direct = urls.map(matchWikipediaTitle).find(Boolean);
  if (direct) {
    return await wikipediaIntro(direct);
  }
  return null;
}

function matchWikidataId(url: string): string | null {
  return /wikidata\.org\/wiki\/(Q\d+)/.exec(url)?.[1] ?? null;
}

function matchWikipediaTitle(url: string): string | null {
  const match = /^https?:\/\/en\.wikipedia\.org\/wiki\/([^?#]+)/.exec(url);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/** The English Wikipedia article a Wikidata item points at, if it has one. */
async function wikipediaTitleForWikidata(id: string): Promise<string | null> {
  const url = new URL('https://www.wikidata.org/w/api.php');
  url.searchParams.set('action', 'wbgetentities');
  url.searchParams.set('ids', id);
  url.searchParams.set('props', 'sitelinks');
  url.searchParams.set('sitefilter', 'enwiki');
  url.searchParams.set('format', 'json');
  const payload = await getJson<{
    entities?: Record<string, { sitelinks?: { enwiki?: { title?: string } } }>;
  }>(url);
  return payload?.entities?.[id]?.sitelinks?.enwiki?.title ?? null;
}

/**
 * An article's intro, as plain text.
 *
 * `exintro` rather than the whole article: the lead section is the part that answers "who is
 * this", and everything after it is a discography the browse page is already showing.
 */
async function wikipediaIntro(
  title: string,
): Promise<{ text: string; source: { name: string; url: string | null } } | null> {
  const url = new URL('https://en.wikipedia.org/w/api.php');
  url.searchParams.set('action', 'query');
  url.searchParams.set('prop', 'extracts');
  url.searchParams.set('exintro', '1');
  url.searchParams.set('explaintext', '1');
  url.searchParams.set('redirects', '1');
  url.searchParams.set('format', 'json');
  url.searchParams.set('titles', title);

  const payload = await getJson<{
    query?: { pages?: Record<string, { title?: string; extract?: string; missing?: unknown }> };
  }>(url);
  const page = Object.values(payload?.query?.pages ?? {})[0];
  // Wikipedia's plain-text extract leaves the holes where the markup was — a pronunciation
  // block or a birth-name template becomes a run of spaces mid-sentence. Paragraph breaks are
  // load-bearing (the client splits on them), so only runs *within* a line are collapsed.
  const text = (page?.extract ?? '')
    .replace(/[^\S\n]{2,}/g, ' ')
    .replace(/[^\S\n]+([,.;:])/g, '$1')
    .trim();
  if (!text || page?.missing !== undefined) {
    return null;
  }
  const canonical = page?.title ?? title;
  return {
    text: text.slice(0, MAX_DESCRIPTION),
    source: {
      // The licence requires attribution, and the article is where a reader goes to check it.
      name: 'Wikipedia',
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(canonical.replace(/ /g, '_'))}`,
    },
  };
}

async function getJson<T>(url: URL): Promise<T | null> {
  try {
    const response = await fetch(url.toString(), {
      headers: { 'User-Agent': MUSICBRAINZ_USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok) {
      log.debug('enrichment request failed', { host: url.host, status: response.status });
      return null;
    }
    return (await response.json()) as T;
  } catch (error) {
    log.debug('enrichment request error', {
      host: url.host,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
