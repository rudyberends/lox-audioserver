/**
 * Spotify content over the pathfinder GraphQL API (api-partner.spotify.com) —
 * the same backend the web player uses. Replaces the Feb-2026-restricted Web API
 * for browse/playlist/album/artist/search.
 *
 * Auth: a `PathfinderSession` mints the tokens (first-party bearer + client-token) and nothing
 * else; all HTTP, persisted-query-hash scraping and parsing live here in TS. Persisted-query
 * hashes rotate per Spotify web-player deploy, so we scrape them from the live bundle, cache
 * them, and re-scrape once on PersistedQueryNotFound.
 */
import { createLogger } from '@/shared/logging/logger';

const log = createLogger('spotify-pathfinder');

const PATHFINDER = 'https://api-partner.spotify.com/pathfinder/v1/query';
const WEB_PLAYER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HTTP_TIMEOUT_MS = 10_000; // never let a slow CDN/API hang content browsing

/** Top-level Genres & Moods landing URI (lists the category cards). */
export const BROWSE_ROOT_URI = 'spotify:genre:browse';

/**
 * The credentials a pathfinder request needs.
 *
 * Exported for `spotifyWebTokens`, which scrapes the pair off the public web player — the only
 * source there is now.
 */
export interface SessionTokens {
  accessToken: string;
  tokenType: string;
  clientToken: string;
  expiresInMs: number;
}

/** Anything that can produce a pair of tokens for a request. */
export interface PathfinderSession {
  getTokens(): Promise<SessionTokens>;
}

// Accept-Language for pathfinder requests, so Spotify localizes content names
// (e.g. "Top 50 - Nederland" instead of "Top 50 - Global"). Set once from the
// account locale; applies to every query.
let acceptLanguage: string | undefined;
export function setPathfinderLocale(locale: string | undefined): void {
  acceptLanguage = locale?.trim() || undefined;
}

// --- token cache (per session) ---

const tokenCache = new WeakMap<PathfinderSession, { tokens: SessionTokens; expiresAt: number }>();

async function getTokens(session: PathfinderSession): Promise<SessionTokens | null> {
  const cached = tokenCache.get(session);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.tokens;
  }
  try {
    const tokens = await session.getTokens();
    // Refresh a minute before the bearer actually expires.
    const ttl = Math.max(30_000, (tokens.expiresInMs || 3_600_000) - 60_000);
    tokenCache.set(session, { tokens, expiresAt: Date.now() + ttl });
    return tokens;
  } catch (error) {
    log.warn('getTokens failed', { message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

// --- persisted-query hash registry (scraped from the web player) ---
//
// Operations live across a few web-player chunks; we scan the main bundle plus
// these route chunks and collect every "<op>","query","<hash>" triple.
const SCRAPE_CHUNKS = ['browse-v2', 'xpui-routes-playlist', 'xpui-routes-search'];
const HASH_TTL_MS = 6 * 60 * 60 * 1000;

let hashRegistry: Record<string, string> = {};
let hashScrapedAt = 0;
let scrapePromise: Promise<Record<string, string>> | null = null;

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': WEB_PLAYER_UA, 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/** Collect every operation->hash triple in a JS blob. */
function collectHashes(js: string, into: Record<string, string>): void {
  for (const m of js.matchAll(/"([a-zA-Z]+)","(?:query|mutation)","([a-f0-9]{64})"/g)) {
    const op = m[1];
    const hash = m[2];
    if (op && hash && !into[op]) {
      into[op] = hash;
    }
  }
}

/** Resolve a named lazy chunk's URL via the webpack name/contenthash maps. */
async function chunkUrls(mainJs: string, base: string, name: string): Promise<string[]> {
  const idMatch = mainJs.match(new RegExp(`(\\d+):"${name}"`));
  if (!idMatch?.[1]) {
    return [];
  }
  const id = idMatch[1];
  const hashes = Array.from(mainJs.matchAll(new RegExp(`${id}:"([a-f0-9]{8,})"`, 'g')), (m) => m[1]);
  return hashes.filter((h): h is string => Boolean(h)).map((h) => `${base}${name}.${h}.js`);
}

async function scrapeHashes(): Promise<Record<string, string>> {
  const home = await fetchText('https://open.spotify.com/');
  const mainMatch = home?.match(/https:\/\/[^"']*\/web-player\/web-player\.[a-f0-9]+\.js/);
  if (!mainMatch) {
    log.debug('hash scrape: main bundle not found');
    return {};
  }
  const mainUrl = mainMatch[0];
  const base = mainUrl.slice(0, mainUrl.lastIndexOf('/') + 1);
  const mainJs = await fetchText(mainUrl);
  if (!mainJs) {
    return {};
  }
  const registry: Record<string, string> = {};
  collectHashes(mainJs, registry); // getAlbum/queryArtistOverview live here
  for (const name of SCRAPE_CHUNKS) {
    for (const url of await chunkUrls(mainJs, base, name)) {
      const chunk = await fetchText(url);
      if (chunk) {
        collectHashes(chunk, registry);
        break; // first 200 for this chunk name wins
      }
    }
  }
  return registry;
}

async function getHash(operationName: string, force: boolean): Promise<string | null> {
  const fresh = !force && Date.now() - hashScrapedAt < HASH_TTL_MS;
  if (fresh && hashRegistry[operationName]) {
    return hashRegistry[operationName];
  }
  if (!scrapePromise) {
    scrapePromise = scrapeHashes()
      .then((reg) => {
        if (Object.keys(reg).length) {
          hashRegistry = reg;
          hashScrapedAt = Date.now();
        }
        return hashRegistry;
      })
      .finally(() => {
        scrapePromise = null;
      });
  }
  const reg = await scrapePromise;
  return reg[operationName] ?? null;
}

// --- pathfinder query ---

/**
 * Run a persisted pathfinder query and return its `data` node, or null on
 * failure. Re-scrapes hashes once on PersistedQueryNotFound (stale after a
 * Spotify deploy).
 */
async function query<T = unknown>(
  session: PathfinderSession,
  operationName: string,
  variables: Record<string, unknown>,
): Promise<T | null> {
  const tokens = await getTokens(session);
  if (!tokens) {
    return null;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const hash = await getHash(operationName, attempt > 0);
    if (!hash) {
      return null;
    }
    const url =
      `${PATHFINDER}?operationName=${encodeURIComponent(operationName)}` +
      `&variables=${encodeURIComponent(JSON.stringify(variables))}` +
      `&extensions=${encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }))}`;
    let body: string;
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `${tokens.tokenType} ${tokens.accessToken}`,
          'client-token': tokens.clientToken,
          'app-platform': 'WebPlayer',
          Accept: 'application/json',
          ...(acceptLanguage ? { 'Accept-Language': acceptLanguage } : {}),
        },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      body = await res.text();
    } catch (error) {
      log.warn('pathfinder request failed', {
        operationName,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    let json: { data?: T; errors?: Array<{ message?: string }> };
    try {
      json = JSON.parse(body);
    } catch {
      return null;
    }
    if (json.errors?.some((e) => e.message === 'PersistedQueryNotFound') && attempt === 0) {
      log.info('pathfinder hash stale; re-scraping', { operationName });
      continue;
    }
    if (json.errors?.length) {
      log.warn('pathfinder query errors', { operationName, errors: json.errors.map((e) => e.message) });
      return null;
    }
    return json.data ?? null;
  }
  return null;
}

// --- shared shapes (only fields we read) ---

interface ArtworkSource {
  url?: string;
}
function firstSource(sources?: ArtworkSource[]): string | undefined {
  return sources?.find((s) => s?.url)?.url;
}

// --- normalized results ---

/** A Genres & Moods category card. */
export interface BrowseCategory {
  uri: string; // spotify:page:... — pass back to browse() to drill in
  title: string;
  cover?: string;
}

/** A playable entry (container or track), a podcast/audiobook, or a drillable
 *  sub-category (e.g. the cards inside the Podcasts/Audiobooks browse pages). */
export interface MediaEntry {
  uri: string;
  kind: 'playlist' | 'album' | 'artist' | 'track' | 'show' | 'episode' | 'category';
  name: string;
  cover?: string;
  owner?: string; // playlist owner / album+track artists
  album?: string; // for tracks
  durationSec?: number; // for tracks
}

// --- browse (Genres & Moods) ---

interface BrowseSectionItem {
  uri?: string;
  content?: {
    data?: {
      __typename?: string;
      uri?: string;
      name?: string | { transformedLabel?: string };
      images?: { items?: Array<{ sources?: ArtworkSource[] }> };
      coverArt?: { sources?: ArtworkSource[] };
      ownerV2?: { data?: { name?: string } };
      artists?: { items?: Array<{ profile?: { name?: string } }> };
      data?: {
        cardRepresentation?: {
          title?: { transformedLabel?: string };
          artwork?: { sources?: ArtworkSource[] };
        };
      };
    };
  };
}
interface BrowseNode {
  __typename?: string;
  sections?: { items?: Array<{ sectionItems?: { items?: BrowseSectionItem[] } }> };
}

function* browseItems(node: BrowseNode): Generator<BrowseSectionItem> {
  for (const section of node.sections?.items ?? []) {
    yield* section.sectionItems?.items ?? [];
  }
}

const KIND_BY_TYPENAME: Record<string, MediaEntry['kind']> = {
  Playlist: 'playlist',
  Album: 'album',
  Artist: 'artist',
  Podcast: 'show',
  PodcastShow: 'show',
  Show: 'show',
  Audiobook: 'show',
  Episode: 'episode',
  PodcastEpisode: 'episode',
};

async function browse(session: PathfinderSession, uri: string, pageLimit = 20, sectionLimit = 50): Promise<BrowseNode | null> {
  const data = await query<{ browse?: BrowseNode }>(session, 'browsePage', {
    uri,
    pagePagination: { offset: 0, limit: pageLimit },
    sectionPagination: { offset: 0, limit: sectionLimit },
    browseEndUserIntegration: 'INTEGRATION_WEB_PLAYER',
    includeEpisodeContentRatingsV2: false,
  });
  const node = data?.browse;
  return node && node.__typename !== 'GenericError' ? node : null;
}

/** Fetch the Genres & Moods category cards. */
export async function fetchBrowseCategories(session: PathfinderSession): Promise<BrowseCategory[]> {
  const node = await browse(session, BROWSE_ROOT_URI, 20, 100);
  if (!node) {
    return [];
  }
  const out: BrowseCategory[] = [];
  for (const item of browseItems(node)) {
    const uri = item.uri || item.content?.data?.uri;
    if (!uri || !uri.startsWith('spotify:page:')) {
      continue;
    }
    const card = item.content?.data?.data?.cardRepresentation;
    const title = card?.title?.transformedLabel;
    if (title) {
      out.push({ uri, title, cover: firstSource(card?.artwork?.sources) });
    }
  }
  return out;
}

/** Fetch the entries inside a category (by its browse URI): playlists/albums/
 *  artists/shows, or — for hub categories like Podcasts/Audiobooks — drillable
 *  sub-category folders. */
export async function fetchCategoryEntries(session: PathfinderSession, browseUri: string): Promise<MediaEntry[]> {
  const node = await browse(session, browseUri, 20, 50);
  if (!node) {
    return [];
  }
  const out: MediaEntry[] = [];
  for (const item of browseItems(node)) {
    const data = item.content?.data;
    const uri = item.uri || data?.uri;
    if (!uri) {
      continue;
    }
    // Sub-category card (a folder of folders, e.g. inside the Podcasts/Audiobooks
    // hubs): surface it as a drillable category, like the top-level cards.
    if (data?.__typename === 'BrowseSectionContainer' && uri.startsWith('spotify:page:')) {
      const card = data.data?.cardRepresentation;
      const title = card?.title?.transformedLabel;
      if (title) {
        out.push({ uri, kind: 'category', name: title, cover: firstSource(card?.artwork?.sources) });
      }
      continue;
    }
    const kind = data?.__typename ? KIND_BY_TYPENAME[data.__typename] : undefined;
    if (!kind) {
      continue;
    }
    const name = typeof data?.name === 'string' ? data.name : data?.name?.transformedLabel ?? '';
    const artistNames = data?.artists?.items
      ?.map((a) => a?.profile?.name)
      .filter((n): n is string => Boolean(n))
      .join(', ');
    out.push({
      uri,
      kind,
      name: name || 'Untitled',
      cover: firstSource(data?.images?.items?.[0]?.sources) ?? firstSource(data?.coverArt?.sources),
      owner: data?.ownerV2?.data?.name ?? (artistNames || undefined),
    });
  }
  return out;
}

// --- tracks (shared track shape across playlist/album) ---

interface TrackData {
  uri?: string;
  name?: string;
  artists?: { items?: Array<{ profile?: { name?: string } }> };
  albumOfTrack?: { name?: string; coverArt?: { sources?: ArtworkSource[] } };
  trackDuration?: { totalMilliseconds?: number };
  duration?: { totalMilliseconds?: number };
}

function mapTrack(t: TrackData | undefined, albumName?: string, albumCover?: string): MediaEntry | null {
  if (!t?.uri) {
    return null;
  }
  const ms = t.trackDuration?.totalMilliseconds ?? t.duration?.totalMilliseconds;
  return {
    uri: t.uri,
    kind: 'track',
    name: t.name || 'Track',
    owner: t.artists?.items?.map((a) => a?.profile?.name).filter(Boolean).join(', ') || undefined,
    album: t.albumOfTrack?.name ?? albumName,
    cover: firstSource(t.albumOfTrack?.coverArt?.sources) ?? albumCover,
    durationSec: Number.isFinite(ms) ? Math.max(1, Math.round((ms as number) / 1000)) : undefined,
  };
}

/** Fetch a playlist's tracks (works for non-owned/editorial playlists). */
export async function fetchPlaylistTracks(
  session: PathfinderSession,
  playlistUri: string,
  offset: number,
  limit: number,
): Promise<{ items: MediaEntry[]; total: number } | null> {
  const data = await query<{
    playlistV2?: { __typename?: string; content?: { totalCount?: number; items?: Array<{ itemV2?: { data?: TrackData } }> } };
  }>(session, 'fetchPlaylist', { uri: playlistUri, offset, limit, enableWatchFeedEntrypoint: false });
  const pl = data?.playlistV2;
  // `playlistV2` is a union, and only its Playlist member carries `content`. Anything the token
  // cannot read resolves to NotFound instead — which, now that the bearer is scraped anonymously
  // from the web player rather than minted by a librespot session, is every private playlist.
  // "Could not read this" is not the same answer as "a playlist with no tracks": reporting them
  // alike handed the caller an empty page it took for the truth, so the Web API fallback that
  // *can* read the owner's own private playlists never ran (#365).
  if (!pl?.content) {
    return null;
  }
  const items = (pl.content?.items ?? [])
    .map((it) => mapTrack(it.itemV2?.data))
    .filter((e): e is MediaEntry => Boolean(e));
  return { items, total: pl.content?.totalCount ?? items.length };
}

/** Fetch an album's tracks. */
export async function fetchAlbumTracks(
  session: PathfinderSession,
  albumUri: string,
  offset: number,
  limit: number,
): Promise<{ items: MediaEntry[]; total: number } | null> {
  const data = await query<{
    albumUnion?: {
      __typename?: string;
      name?: string;
      coverArt?: { sources?: ArtworkSource[] };
      tracksV2?: { totalCount?: number; items?: Array<{ track?: TrackData }> };
    };
  }>(session, 'getAlbum', { uri: albumUri, locale: '', offset, limit });
  const album = data?.albumUnion;
  // Same union shape as playlistV2 above: only the Album member carries `tracksV2`, and an album
  // this token cannot read answers NotFound. Fall through to the Web API rather than passing an
  // empty tracklist off as the album's own (#365).
  if (!album?.tracksV2) {
    return null;
  }
  const albumCover = firstSource(album.coverArt?.sources);
  const items = (album.tracksV2?.items ?? [])
    .map((it) => mapTrack(it.track, album.name, albumCover))
    .filter((e): e is MediaEntry => Boolean(e));
  return { items, total: album.tracksV2?.totalCount ?? items.length };
}

/** Fetch an artist's top tracks. */
export async function fetchArtistTopTracks(session: PathfinderSession, artistUri: string): Promise<MediaEntry[] | null> {
  const data = await query<{
    artistUnion?: {
      __typename?: string;
      discography?: { topTracks?: { items?: Array<{ track?: TrackData }> } };
    };
  }>(session, 'queryArtistOverview', { uri: artistUri, locale: '', preReleaseV2: false });
  const artist = data?.artistUnion;
  if (!artist || artist.__typename === 'GenericError') {
    return null;
  }
  return (artist.discography?.topTracks?.items ?? [])
    .map((it) => mapTrack(it.track))
    .filter((e): e is MediaEntry => Boolean(e));
}

// --- search ---

interface SearchEntityItem {
  item?: { data?: TrackData & { __typename?: string } };
  data?: {
    __typename?: string;
    uri?: string;
    name?: string;
    profile?: { name?: string };
    images?: { items?: Array<{ sources?: ArtworkSource[] }> };
    coverArt?: { sources?: ArtworkSource[] };
    visuals?: { avatarImage?: { sources?: ArtworkSource[] } };
    ownerV2?: { data?: { name?: string } };
    artists?: { items?: Array<{ profile?: { name?: string } }> };
  };
}

export interface SearchResults {
  tracks: MediaEntry[];
  albums: MediaEntry[];
  artists: MediaEntry[];
  playlists: MediaEntry[];
}

function mapSearchContainer(d: SearchEntityItem['data'], kind: MediaEntry['kind']): MediaEntry | null {
  const name = d?.name ?? d?.profile?.name; // artists carry the name under profile
  if (!d?.uri || !name) {
    return null;
  }
  const artistNames = d.artists?.items?.map((a) => a?.profile?.name).filter(Boolean).join(', ');
  return {
    uri: d.uri,
    kind,
    name,
    cover:
      firstSource(d.images?.items?.[0]?.sources) ??
      firstSource(d.coverArt?.sources) ??
      firstSource(d.visuals?.avatarImage?.sources),
    owner: d.ownerV2?.data?.name ?? d.profile?.name ?? (artistNames || undefined),
  };
}

/** Full multi-type search (tracks/albums/artists/playlists). */
export async function search(session: PathfinderSession, term: string, limit: number): Promise<SearchResults | null> {
  const data = await query<{
    searchV2?: {
      __typename?: string;
      tracksV2?: { items?: SearchEntityItem[] };
      albumsV2?: { items?: SearchEntityItem[] };
      artists?: { items?: SearchEntityItem[] };
      playlists?: { items?: SearchEntityItem[] };
    };
  }>(session, 'searchDesktop', {
    searchTerm: term,
    offset: 0,
    limit,
    numberOfTopResults: limit,
    includeAudiobooks: false,
    includePreReleases: false,
    includeAlbumPreReleases: false,
    includeAuthors: false,
    includeEpisodeContentRatingsV2: false,
  });
  const sr = data?.searchV2;
  if (!sr || sr.__typename === 'GenericError') {
    return null;
  }
  return {
    tracks: (sr.tracksV2?.items ?? []).map((it) => mapTrack(it.item?.data)).filter((e): e is MediaEntry => Boolean(e)),
    albums: (sr.albumsV2?.items ?? []).map((it) => mapSearchContainer(it.data, 'album')).filter((e): e is MediaEntry => Boolean(e)),
    artists: (sr.artists?.items ?? []).map((it) => mapSearchContainer(it.data, 'artist')).filter((e): e is MediaEntry => Boolean(e)),
    playlists: (sr.playlists?.items ?? []).map((it) => mapSearchContainer(it.data, 'playlist')).filter((e): e is MediaEntry => Boolean(e)),
  };
}
