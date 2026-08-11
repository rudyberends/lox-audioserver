/**
 * `GET /api/v1/items/{id}/about` — the story around an item.
 *
 * Specified in `docs/PROPOSAL-item-about.md`, which the player filed while its own client sat
 * dormant waiting for a server to answer. This is that server side.
 *
 * Two jobs, and they are deliberately separate:
 *
 * - **The prose** comes from `aboutSource` (MusicBrainz → Wikidata → Wikipedia) and is about an
 *   artist, not about a provider's copy of one. It is cached under the name alone, so the same
 *   biography serves the local library's Björk and Apple Music's.
 * - **`similar`** comes from the service itself where it can say — Apple Music has an editorial
 *   *similar artists* view, and "who else would I like" is a catalogue owner's answer, not a
 *   metadata database's. MusicBrainz only knows who *played in* a band, so a shelf built from it
 *   is a list of former members: factually beside the artist, not music to try next. It is the
 *   fallback for services with no notion of the kind, and it stays strict about names.
 *   Either way the entries are *items*, not captions: ids the caller can browse and play, and a
 *   name this house has no copy of is dropped rather than listed.
 *
 * **A cold request does not wait indefinitely.** Assembling a story is four rate-limited upstream
 * calls plus a search per related act, which is seconds — longer than a browse page should ever
 * hang, and longer than the player's own request timeout. So a miss starts the work in the
 * background and the route answers with whatever is ready within a short deadline; 404 otherwise,
 * which the contract already documents as the ordinary answer and every client already renders as
 * "nothing here". The next visit finds it cached.
 */
import { fetchAlbumStory, fetchArtistStory, type AboutStory } from '@/adapters/content/enrichment/aboutSource';
import type { AboutStore } from '@/adapters/content/enrichment/aboutStore';
import { decodeBrowseRef } from '@/domain/media/browseRef';
import type { ApiBrowseItem, ApiItemAbout, ApiSearchResult } from '@/domain/zones/apiTypes';
import { createLogger } from '@/shared/logging/logger';

/**
 * How long the route waits for a cold story before answering "nothing yet".
 *
 * Measured rather than guessed: a cold artist takes two rate-limited MusicBrainz calls, a Wikidata
 * lookup, a Wikipedia extract and one provider call — 2.7 to 2.8 seconds when nothing else is
 * queued. Three seconds therefore *usually* made it and sometimes did not, which is the worst
 * possible answer: the panel appeared or not depending on what else was asking. Eight leaves room
 * for a busy queue and still lands inside the player's own ten-second request timeout, and nothing
 * is blocked meanwhile — the listing has already rendered; only this panel is outstanding.
 */
const DEADLINE_MS = 8_000;

/** How many resolved neighbours are worth a shelf. Beyond this the row is a directory. */
const MAX_SIMILAR = 8;

/** Kinds anyone writes about. A playlist is somebody's collection; there is no article about it. */
const TELLABLE = new Set(['artist', 'album']);

export type AboutSourcePort = {
  fetchArtistStory(artist: string): Promise<AboutStory | null>;
  fetchAlbumStory(album: string, artist: string | null): Promise<AboutStory | null>;
};

export type AboutServiceDeps = {
  describeItem(id: string): Promise<ApiBrowseItem | null>;
  /**
   * The service's own related artists, when it has them. Optional: a server wired without it
   * simply falls back to what the metadata source can derive.
   */
  relatedArtists?(id: string, limit: number): Promise<ApiBrowseItem[]>;
  search(request: {
    query: string;
    kinds: string[];
    services: string[];
    limit: number;
  }): Promise<ApiSearchResult>;
  store: AboutStore;
  /** Injectable so tests can tell the story without the internet. */
  source?: AboutSourcePort;
};

export class AboutService {
  private readonly log = createLogger('Api', 'About');
  private readonly source: AboutSourcePort;
  /** In-flight fills, so twenty panels asking at once cost one upstream round. */
  private readonly filling = new Map<string, Promise<ApiItemAbout | null>>();

  public constructor(private readonly deps: AboutServiceDeps) {
    this.source = deps.source ?? { fetchArtistStory, fetchAlbumStory };
  }

  /** The about panel for an id, or null when there is nothing to tell — which is a 404. */
  public async describeAbout(id: string): Promise<ApiItemAbout | null> {
    const item = await this.deps.describeItem(id).catch(() => null);
    if (!item) {
      return null;
    }
    // The kind comes from the id, not from the description. `describeItem` reports the kind the
    // *content layer* resolved the folder to, and for several providers that is `album` for an
    // artist — harmless in a listing, wrong here, where it decides whether we go looking for a
    // biography or for a record review. The id carries the kind browse handed the caller.
    const kind = decodeBrowseRef(id)?.kind ?? item.kind;
    if (!TELLABLE.has(kind)) {
      return null;
    }
    const name = this.nameOf(kind, item);
    if (!name) {
      // Several providers cannot name a container they did not list the parent of. Asking
      // MusicBrainz about an empty string would match something, which is worse than nothing.
      return null;
    }

    const key = this.cacheKey(kind, item, name);
    const cached = this.deps.store.get<ApiItemAbout>(key);
    if (cached?.fresh) {
      return cached.value;
    }

    const fill = this.fill(key, kind, item, name);
    if (cached) {
      // Stale but present: serve it and let the refresh land for next time. A month-old
      // biography is not worth making anyone wait for.
      void fill.catch(() => null);
      return cached.value;
    }
    return await this.within(fill);
  }

  /**
   * Assembles and stores a story, once per key at a time.
   *
   * Deduplicated because the shape of the traffic is a wall of panels opening the same artist
   * page: without this, one browse page could put a dozen identical MusicBrainz lookups in the
   * queue and each of them would wait on the one before it.
   */
  private fill(
    key: string,
    kind: string,
    item: ApiBrowseItem,
    name: string,
  ): Promise<ApiItemAbout | null> {
    const existing = this.filling.get(key);
    if (existing) {
      return existing;
    }
    const run = (async () => {
      try {
        const story = await this.tellStory(kind, item, name);
        if (!story) {
          // A remembered miss: most items have none, and forgetting that is what turns a
          // browse page into a burst of upstream requests on every visit.
          this.deps.store.put(key, null);
          return null;
        }
        const similar = await this.similarFor(kind, item, story.relatedNames);
        const about: ApiItemAbout = {
          description: story.description,
          similar,
          source: story.source,
        };
        if (!about.description && similar.length === 0) {
          this.deps.store.put(key, null);
          return null;
        }
        this.deps.store.put(key, about);
        this.log.debug('about stored', {
          key,
          described: Boolean(about.description),
          similar: similar.length,
        });
        return about;
      } catch (error) {
        // Deliberately *not* remembered. A source that could not be reached has told us nothing
        // about this artist, and writing a miss here would file a rate-limited minute away as a
        // fact for a week — which is exactly what happened to one artist during development: a
        // transient failure left an empty panel on a page Wikipedia had an article for.
        this.log.debug('about fill failed, not cached', {
          key,
          message: error instanceof Error ? error.message : String(error),
        });
        return null;
      } finally {
        this.filling.delete(key);
      }
    })();
    this.filling.set(key, run);
    return run;
  }

  /**
   * What to ask the world about.
   *
   * Not simply `item.name`, because for most providers an artist container has no name of its
   * own: the content layer infers one from the first child, so an Apple Music artist comes back
   * called *Viva La Vida or Death and All His Friends*. The child's `artist` is the artist —
   * that is what a track knows about its own container — so for an artist it wins over an
   * inferred title. Where the name is genuinely the artist's (the local library knows its own
   * folders) the two agree and nothing changes.
   */
  private nameOf(kind: string, item: ApiBrowseItem): string {
    const name = item.name.trim();
    const artist = (item.artist ?? '').trim();
    if (kind === 'artist' && artist && artist.toLowerCase() !== name.toLowerCase()) {
      return artist;
    }
    return name;
  }

  private async tellStory(
    kind: string,
    item: ApiBrowseItem,
    name: string,
  ): Promise<AboutStory | null> {
    return kind === 'album'
      ? await this.source.fetchAlbumStory(name, item.artist ?? null)
      : await this.source.fetchArtistStory(name);
  }

  /**
   * The shelf, from the best source that can fill it.
   *
   * The service first, because it is the only one that can answer the question the shelf actually
   * asks. Only when it has nothing — a local folder of files, a provider without the notion — do
   * the metadata source's relations get resolved, and those are a weaker claim: they are people
   * connected to the act rather than music beside it.
   */
  private async similarFor(
    kind: string,
    item: ApiBrowseItem,
    relatedNames: string[],
  ): Promise<ApiBrowseItem[]> {
    if (kind === 'artist' && this.deps.relatedArtists) {
      const native = await this.deps.relatedArtists(item.id, MAX_SIMILAR).catch(() => []);
      const usable = native.filter((entry) => entry.id !== item.id && entry.name.trim());
      if (usable.length > 0) {
        return usable.slice(0, MAX_SIMILAR);
      }
    }
    return await this.resolveSimilar(item, relatedNames);
  }

  /**
   * Names into openable items, asked of the provider the item itself came from.
   *
   * Same service on purpose: a "beside this" shelf under an Apple Music artist that opens local
   * files, or the reverse, is a shelf that behaves differently per tile. Searching one provider
   * is also one upstream call each rather than a fan-out across every account in the house.
   */
  private async resolveSimilar(item: ApiBrowseItem, names: string[]): Promise<ApiBrowseItem[]> {
    const out: ApiBrowseItem[] = [];
    const seen = new Set([item.id]);
    for (const name of names) {
      if (out.length >= MAX_SIMILAR) {
        break;
      }
      const result = await this.deps
        .search({ query: name, kinds: ['artist'], services: [item.service], limit: 1 })
        .catch(() => null);
      const hit = result?.items.artist?.[0];
      // A near-miss is worse than a gap: a search for "Múm" that returns "Mumford & Sons"
      // would put a stranger on the shelf under a heading that says these belong together.
      if (!hit || seen.has(hit.id) || !namesMatch(hit.name, name)) {
        continue;
      }
      seen.add(hit.id);
      out.push(hit);
    }
    return out;
  }

  /** The story if it arrives in time, otherwise nothing — the work continues either way. */
  private async within(fill: Promise<ApiItemAbout | null>): Promise<ApiItemAbout | null> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), DEADLINE_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([fill.catch(() => null), deadline]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Two keys, deliberately: the prose is about an artist and the shelf is about a catalogue.
   *
   * The story itself is not cached separately from the panel — the panel *is* the cached unit —
   * but the key carries the service for exactly that reason: two services asking about the same
   * artist agree about the biography and disagree about which neighbours exist.
   */
  private cacheKey(kind: string, item: ApiBrowseItem, name: string): string {
    const artist = kind === 'album' ? (item.artist ?? '').trim().toLowerCase() : '';
    return [kind, item.service, name.toLowerCase(), artist].join('|');
  }
}

/**
 * Whether a search hit is really the artist that was asked for.
 *
 * Providers answer a search for an unknown name with their closest guess rather than nothing, so
 * the name has to be checked. Case, punctuation and a leading `The` are ignored, because
 * catalogues disagree about all three constantly — but **accents are not**. Folding them let
 * *Julia Martin* match a different artist called *Julia Martín*, and on a shelf that says these
 * belong together a stranger is worse than a gap.
 */
function namesMatch(a: string, b: string): boolean {
  return normalizeName(a) === normalizeName(b);
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFC')
    .replace(/^the\s+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}
