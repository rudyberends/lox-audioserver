import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from './testHarness';
import { SubsonicApi } from '../src/adapters/subsonic/subsonicApi';
import { musicFolderId } from '../src/adapters/subsonic/subsonicIds';
import type { ConfigPort } from '../src/ports/ConfigPort';
import type { ContentManager } from '../src/adapters/content/contentManager';
import type { ContentPort } from '../src/ports/ContentPort';
import type { EnginePort } from '../src/ports/EnginePort';
import type { ContentFolder, ContentFolderItem } from '../src/ports/ContentTypes';

const USERNAME = 'rudy';
const PASSWORD = 's3cret';
const BRIDGE_ID = 'bridge-applemusic-p0gngd';
/**
 * What Subsonic calls this account. The bridge id above is its Loxone name and
 * stays inside that adapter; every other consumer uses the service-native one.
 */
const SERVICE_KEY = 'applemusic';

type BrowseCall = { service: string; user: string; folderId: string; offset: number; limit: number };

function folderItem(over: Partial<ContentFolderItem> & { id: string; name: string }): ContentFolderItem {
  return { type: 1, ...over };
}

function trackItem(id: string, name: string, audiopath: string): ContentFolderItem {
  return { id, name, type: 2, audiopath, artist: 'A', album: 'B', duration: 200 };
}

function folder(id: string, name: string, items: ContentFolderItem[], total?: number): ContentFolder {
  return { id, name, items, totalitems: total ?? items.length, start: 0 };
}

/**
 * A content layer with one local library and one Apple Music bridge, so the
 * tests exercise the bridge path — the reason this API exists alongside DLNA.
 */
function makeHarness(options: { directoryLimit?: number; bigFolderSize?: number } = {}) {
  const browseCalls: BrowseCall[] = [];
  const searchCalls: Array<{ source: string; query: string }> = [];

  const configPort = {
    getConfig: () => ({
      // Standalone with a local account: keeps these tests about the API surface
      // rather than about which credential source admitted the caller.
      system: {
        audioserver: { mode: 'standalone', paired: false, ip: '192.168.1.209' },
        users: [{ username: USERNAME, password: PASSWORD, admin: true }],
      },
      content: {
        subsonic: {
          enabled: true,
          ...(options.directoryLimit ? { directoryLimit: options.directoryLimit } : {}),
        },
        streamingServices: [
          { id: BRIDGE_ID, provider: 'applemusic', label: 'Apple Music', enabled: true },
          { id: 'bridge-off', provider: 'tidal', label: 'Tidal', enabled: false },
        ],
      },
    }),
  } as unknown as ConfigPort;

  const bigSize = options.bigFolderSize ?? 0;

  const contentManager = {
    getMediaFolder: async (folderId: string, offset: number, limit: number) => {
      browseCalls.push({ service: 'library', user: 'local', folderId, offset, limit });
      if (folderId === 'root') {
        return folder('root', 'Local Media', [folderItem({ id: 'library-local', name: 'Local Media' })]);
      }
      if (folderId === 'library-local') {
        return folder('library-local', 'Local Media', [
          folderItem({ id: 'library-local-albums', name: 'Albums' }),
          folderItem({ id: 'library-local-artists', name: 'Artists' }),
        ]);
      }
      if (folderId === 'library-local-artists') {
        return folder('library-local-artists', 'Artists', [
          folderItem({ id: 'library:artist:x', name: 'Aphex Twin', items: 3 }),
        ]);
      }
      return folder(folderId, 'Empty', []);
    },
    getServiceFolder: async (
      service: string,
      user: string,
      folderId: string,
      offset: number,
      limit: number,
    ) => {
      browseCalls.push({ service, user, folderId, offset, limit });
      if (service === 'radioparadise') {
        return folder('start', 'Radio', []);
      }
      if (folderId === 'root') {
        return folder('root', 'Apple Music', [
          folderItem({ id: 'albums', name: 'Albums' }),
          folderItem({ id: 'artists', name: 'Artists' }),
          folderItem({ id: 'playlists', name: 'Playlists' }),
        ]);
      }
      if (folderId === 'big' && bigSize > 0) {
        // A provider container far larger than one page, to exercise the walk.
        const page: ContentFolderItem[] = [];
        for (let i = offset; i < Math.min(offset + limit, bigSize); i += 1) {
          page.push(trackItem(`t${i}`, `Track ${i}`, `applemusic:track:${i}`));
        }
        return { id: 'big', name: 'Big', items: page, totalitems: bigSize, start: offset };
      }
      if (folderId === 'albums') {
        return folder('albums', 'Albums', [folderItem({ id: 'album-1', name: 'Kid A', items: 2 })]);
      }
      if (folderId === 'album-1') {
        return folder('album-1', 'Kid A', [
          trackItem('s1', 'Everything', 'applemusic:track:1'),
          trackItem('s2', 'The National Anthem', 'applemusic:track:2'),
        ]);
      }
      return folder(folderId, 'Empty', []);
    },
    // The content layer names its buckets in the PLURAL — the local library
    // returns tracks/albums/artists/playlists/folders and every bridge provider
    // does the same. Mirrored here so the mapping is tested against the real
    // contract rather than a convenient one.
    globalSearch: async (source: string, query: string) => {
      searchCalls.push({ source, query });
      if (source.startsWith('local')) {
        return {
          result: {
            tracks: [trackItem('l1', 'Local Hit', 'library://a.mp3')],
            albums: [folderItem({ id: 'al1', name: 'Local Album' })],
            artists: [folderItem({ id: 'lar1', name: 'Local Artist' })],
            playlists: [],
            folders: [],
          },
          user: 'local',
          providerId: 'local',
        };
      }
      return {
        result: {
          artists: [folderItem({ id: 'ar1', name: 'Radiohead' })],
          tracks: [trackItem('s9', 'Idioteque', 'applemusic:track:9')],
        },
        user: 'u',
        providerId: 'applemusic',
      };
    },
    resolveMetadata: async () => null,
    getScanStatus: () => 0,
    rescanLibrary: async () => {},
  } as unknown as ContentManager;

  const api = new SubsonicApi(
    configPort,
    contentManager,
    {} as unknown as ContentPort,
    {} as unknown as EnginePort,
  );
  return { api, browseCalls, searchCalls };
}

function makeReq(url: string): IncomingMessage {
  return { url, method: 'GET', headers: {}, on: () => undefined } as unknown as IncomingMessage;
}

function makeRes(): { res: ServerResponse; json(): any; status(): number } {
  const chunks: Buffer[] = [];
  let status = 0;
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(code: number) {
      status = code;
      (this as { headersSent: boolean }).headersSent = true;
      return this;
    },
    end(chunk?: Buffer) {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      (this as { writableEnded: boolean }).writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse;
  return {
    res,
    json: () => JSON.parse(Buffer.concat(chunks).toString('utf8'))['subsonic-response'],
    status: () => status,
  };
}

const auth = `u=${USERNAME}&p=${PASSWORD}&v=1.16.1&c=test&f=json`;

async function call(api: SubsonicApi, method: string, query = ''): Promise<any> {
  const url = `/rest/${method}.view?${auth}${query ? `&${query}` : ''}`;
  const cap = makeRes();
  await api.handle(makeReq(url), cap.res, `/rest/${method}.view`);
  return cap.json();
}

test('subsonic api: ping succeeds with plaintext credentials', async () => {
  const { api } = makeHarness();
  const body = await call(api, 'ping');
  assert.equal(body.status, 'ok');
});

test('subsonic api: salted token auth is accepted', async () => {
  const { api } = makeHarness();
  const salt = 'abc123';
  const token = createHash('md5').update(`${PASSWORD}${salt}`).digest('hex');
  const cap = makeRes();
  const url = `/rest/ping.view?u=${USERNAME}&t=${token}&s=${salt}&f=json`;
  await api.handle(makeReq(url), cap.res, '/rest/ping.view');
  assert.equal(cap.json().status, 'ok');
});

test('subsonic api: hex-encoded password auth is accepted', async () => {
  const { api } = makeHarness();
  const hex = Buffer.from(PASSWORD, 'utf8').toString('hex');
  const cap = makeRes();
  const url = `/rest/ping.view?u=${USERNAME}&p=enc:${hex}&f=json`;
  await api.handle(makeReq(url), cap.res, '/rest/ping.view');
  assert.equal(cap.json().status, 'ok');
});

test('subsonic api: wrong password is rejected with code 40', async () => {
  const { api } = makeHarness();
  const cap = makeRes();
  await api.handle(
    makeReq(`/rest/ping.view?u=${USERNAME}&p=nope&f=json`),
    cap.res,
    '/rest/ping.view',
  );
  const body = cap.json();
  assert.equal(body.status, 'failed');
  assert.equal(body.error.code, 40);
});

test('subsonic api: a wrong username of a different length is still rejected', async () => {
  // The comparison is length-guarded before timingSafeEqual; make sure the guard
  // rejects rather than throwing.
  const { api } = makeHarness();
  const cap = makeRes();
  await api.handle(
    makeReq(`/rest/ping.view?u=someoneelse&p=${PASSWORD}&f=json`),
    cap.res,
    '/rest/ping.view',
  );
  assert.equal(cap.json().error.code, 40);
});

test('subsonic api: an unknown method faults instead of hanging', async () => {
  const { api } = makeHarness();
  const body = await call(api, 'getNoSuchThing');
  assert.equal(body.status, 'failed');
  assert.equal(body.error.code, 70);
});

test('subsonic api: getMusicFolders lists library, radio and enabled bridges only', async () => {
  const { api } = makeHarness();
  const folders = (await call(api, 'getMusicFolders')).musicFolders.musicFolder;
  const names = folders.map((f: any) => f.name);
  assert.deepEqual(names, ['Library', 'Radio', 'Apple Music']);
  // The disabled Tidal bridge must not appear.
  assert.ok(!names.includes('Tidal'));
  // Ids are the stable hash, not an array index.
  assert.equal(folders[2].id, musicFolderId(SERVICE_KEY));
});

test('subsonic api: getIndexes buckets top-level entries alphabetically', async () => {
  const { api } = makeHarness();
  const body = await call(api, 'getIndexes', `musicFolderId=${musicFolderId(SERVICE_KEY)}`);
  const index = body.indexes.index;
  assert.deepEqual(
    index.map((entry: any) => entry.name),
    ['A', 'P'],
  );
  assert.deepEqual(
    index[0].artist.map((a: any) => a.name),
    ['Albums', 'Artists'],
  );
});

test('subsonic api: getMusicDirectory walks a bridge folder and maps tracks to songs', async () => {
  const { api, browseCalls } = makeHarness();
  const indexes = await call(api, 'getIndexes', `musicFolderId=${musicFolderId(SERVICE_KEY)}`);
  const albumsDir = indexes.indexes.index[0].artist[0];

  const body = await call(api, 'getMusicDirectory', `id=${encodeURIComponent(albumsDir.id)}`);
  assert.equal(body.directory.name, 'Albums');
  const child = body.directory.child;
  assert.equal(child.length, 1);
  assert.equal(child[0].title, 'Kid A');
  assert.equal(child[0].isDir, true);

  // Both arguments are the service-native identity; the content layer resolves the
  // account from it, so no Loxone bridge id reaches this path.
  const bridgeCalls = browseCalls.filter((c) => c.service === SERVICE_KEY);
  assert.ok(bridgeCalls.length > 0);
  assert.ok(bridgeCalls.every((c) => c.user === SERVICE_KEY));
});

test('subsonic api: getAlbum returns the album songs with playable ids', async () => {
  const { api } = makeHarness();
  const indexes = await call(api, 'getIndexes', `musicFolderId=${musicFolderId(SERVICE_KEY)}`);
  const albumsDir = indexes.indexes.index[0].artist[0];
  const dir = await call(api, 'getMusicDirectory', `id=${encodeURIComponent(albumsDir.id)}`);
  const albumId = dir.directory.child[0].id;

  const body = await call(api, 'getAlbum', `id=${encodeURIComponent(albumId)}`);
  assert.equal(body.album.songCount, 2);
  assert.equal(body.album.duration, 400);
  assert.deepEqual(
    body.album.song.map((s: any) => s.title),
    ['Everything', 'The National Anthem'],
  );
  // Provider tracks are transcoded, so they advertise MP3 rather than a guess.
  assert.equal(body.album.song[0].suffix, 'mp3');
  assert.equal(body.album.song[0].isDir, false);
});

test('subsonic api: getArtists builds the ID3 view from each service collection', async () => {
  const { api } = makeHarness();
  const body = await call(api, 'getArtists');
  const names = body.artists.index.flatMap((entry: any) => entry.artist.map((a: any) => a.name));
  // Library contributes from library-local-artists, the bridge from its Artists folder.
  assert.ok(names.includes('Aphex Twin'), `expected library artist in ${JSON.stringify(names)}`);
});

test('subsonic api: search3 fans out across services and merges results', async () => {
  const { api, searchCalls } = makeHarness();
  const body = await call(api, 'search3', 'query=radio&songCount=5&artistCount=5&albumCount=5');
  const sources = searchCalls.map((c) => c.source);
  assert.ok(sources.some((s) => s.startsWith('local:')), `local missing in ${sources}`);
  assert.ok(
    sources.some((s) => s.startsWith(`${SERVICE_KEY}:`)),
    `streaming service missing in ${sources}`,
  );
  // Per-category limits ride along in the source. parseSearchLimits splits
  // `type#limit`, so an `=` here would be parsed as part of the type name and
  // silently fall back to the default limit.
  assert.ok(
    sources.every((s) => s.includes('track#5') && s.includes('album#5') && s.includes('artist#5')),
    `limits not in # form: ${sources}`,
  );

  const titles = body.searchResult3.song.map((s: any) => s.title).sort();
  assert.deepEqual(titles, ['Idioteque', 'Local Hit']);
  // Plural buckets must land in the right Subsonic collections, not be dropped.
  const artists = body.searchResult3.artist.map((a: any) => a.name).sort();
  assert.deepEqual(artists, ['Local Artist', 'Radiohead']);
  assert.deepEqual(body.searchResult3.album.map((a: any) => a.name), ['Local Album']);
});

test('subsonic api: search with an empty query returns nothing rather than faulting', async () => {
  const { api, searchCalls } = makeHarness();
  const body = await call(api, 'search3', 'query=');
  assert.equal(body.status, 'ok');
  assert.equal(searchCalls.length, 0, 'must not hit providers for an empty query');
});

test('subsonic api: a directory larger than one page is walked to completion', async () => {
  const { api, browseCalls } = makeHarness({ bigFolderSize: 450 });
  const indexes = await call(api, 'getIndexes', `musicFolderId=${musicFolderId(SERVICE_KEY)}`);
  const serviceRoot = indexes.indexes.index[0].artist[0].id;
  // Re-point at the oversized folder by asking for it directly.
  const bigId = serviceRoot.replace(/\.[^.]+$/, `.${Buffer.from('big').toString('base64url')}`);

  const body = await call(api, 'getMusicDirectory', `id=${encodeURIComponent(bigId)}`);
  assert.equal(body.directory.child.length, 450);
  const pages = browseCalls.filter((c) => c.folderId === 'big');
  assert.ok(pages.length >= 3, `expected several pages, got ${pages.length}`);
  assert.equal(pages[0]!.offset, 0);
  // Pages must stay within what every provider accepts. Spotify rejects a limit
  // above 50 and Apple Music above 100, and a rejected page comes back empty —
  // which looks exactly like "this bridge has no content".
  assert.ok(
    pages.every((p) => p.limit <= 50),
    `page limit too large: ${pages.map((p) => p.limit).join(',')}`,
  );
  assert.equal(pages[1]!.offset, pages[0]!.limit);
});

test('subsonic api: the directory cap truncates instead of walking forever', async () => {
  const { api } = makeHarness({ bigFolderSize: 5000, directoryLimit: 300 });
  const indexes = await call(api, 'getIndexes', `musicFolderId=${musicFolderId(SERVICE_KEY)}`);
  const serviceRoot = indexes.indexes.index[0].artist[0].id;
  const bigId = serviceRoot.replace(/\.[^.]+$/, `.${Buffer.from('big').toString('base64url')}`);

  const body = await call(api, 'getMusicDirectory', `id=${encodeURIComponent(bigId)}`);
  assert.equal(body.directory.child.length, 300);
});

test('subsonic api: annotation endpoints acknowledge without persisting', async () => {
  // No annotation store yet; a fault here would make clients error on every tap.
  const { api } = makeHarness();
  for (const method of ['star', 'unstar', 'setRating', 'scrobble']) {
    const body = await call(api, method, 'id=t.YQ');
    assert.equal(body.status, 'ok', `${method} must succeed`);
  }
});

test('subsonic api: a disabled config serves nothing', async () => {
  const configPort = {
    getConfig: () => ({
      system: { audioserver: { mode: 'standalone', paired: false }, users: [] },
      content: { subsonic: { enabled: false }, streamingServices: [] },
    }),
  } as unknown as ConfigPort;
  const api = new SubsonicApi(
    configPort,
    {} as unknown as ContentManager,
    {} as unknown as ContentPort,
    {} as unknown as EnginePort,
  );
  const cap = makeRes();
  await api.handle(makeReq(`/rest/ping.view?${auth}`), cap.res, '/rest/ping.view');
  const body = cap.json();
  assert.equal(body.status, 'failed');
  assert.equal(body.error.code, 50);
});

test('subsonic api: enabled with no user store and no Miniserver refuses everyone', async () => {
  const configPort = {
    getConfig: () => ({
      system: { audioserver: { mode: 'standalone', paired: false }, users: [] },
      content: { subsonic: { enabled: true }, streamingServices: [] },
    }),
  } as unknown as ConfigPort;
  const api = new SubsonicApi(
    configPort,
    {} as unknown as ContentManager,
    {} as unknown as ContentPort,
    {} as unknown as EnginePort,
  );
  const cap = makeRes();
  await api.handle(makeReq(`/rest/ping.view?${auth}`), cap.res, '/rest/ping.view');
  assert.equal(cap.json().error.code, 50);
});

test('subsonic api: matches only the /rest surface', () => {
  const { api } = makeHarness();
  assert.equal(api.matches('/rest/ping.view'), true);
  assert.equal(api.matches('/rest'), true);
  assert.equal(api.matches('/restaurant'), false);
  assert.equal(api.matches('/dlna/track/x'), false);
});
