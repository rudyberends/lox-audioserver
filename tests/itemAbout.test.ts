import assert from 'node:assert/strict';
import { test } from './testHarness';
import { AboutService } from '../src/adapters/http/api/aboutService';
import { EnrichmentUnavailable } from '../src/adapters/content/enrichment/musicBrainz';
import type { AboutStore } from '../src/adapters/content/enrichment/aboutStore';
import { encodeContainerRef } from '../src/domain/media/browseRef';
import type { ApiBrowseItem, ApiSearchResult } from '../src/domain/zones/apiTypes';

// `GET /items/{id}/about` is a *proposed* surface (docs/PROPOSAL-item-about.md) whose contract is
// mostly about restraint: 404 is the ordinary answer, `similar` holds real items or nothing, and
// nothing here may block a browse page while four upstream services are asked. The tests below
// guard exactly those, with the upstream chain stubbed — the internet is not a test fixture.

/** An in-memory stand-in with the store's semantics: a miss is a stored `null`. */
function fakeStore() {
  const rows = new Map<string, unknown | null>();
  const store = {
    get<T>(key: string) {
      return rows.has(key) ? { value: (rows.get(key) ?? null) as T | null, fresh: true } : null;
    },
    put(key: string, value: unknown | null) {
      rows.set(key, value);
    },
  };
  return { store: store as unknown as AboutStore, rows };
}

function artistItem(overrides: Partial<ApiBrowseItem> = {}): ApiBrowseItem {
  return {
    id: encodeContainerRef({ kind: 'artist', service: 'applemusic', folderId: 'artist:1' }),
    name: 'Coldplay',
    kind: 'artist',
    browsable: true,
    playable: false,
    service: 'applemusic',
    ...overrides,
  };
}

function searchHit(name: string): ApiSearchResult {
  return {
    query: name,
    items: {
      artist: [
        {
          id: `hit:${name}`,
          name,
          kind: 'artist',
          browsable: true,
          playable: false,
          service: 'applemusic',
        },
      ],
    },
    services: [{ service: 'applemusic' }],
  };
}

const emptySearch: ApiSearchResult = { query: '', items: {}, services: [] };

test('about: a story becomes a panel, with related names resolved to real items', async () => {
  const { store, rows } = fakeStore();
  const item = artistItem();
  const service = new AboutService({
    describeItem: async () => item,
    search: async (request) => searchHit(request.query),
    store,
    source: {
      fetchArtistStory: async () => ({
        description: 'A British rock band.',
        source: { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Coldplay' },
        relatedNames: ['Chris Martin', 'Apparatjik'],
      }),
      fetchAlbumStory: async () => null,
    },
  });

  const about = await service.describeAbout(item.id);
  assert.ok(about);
  assert.equal(about.description, 'A British rock band.');
  assert.equal(about.source?.name, 'Wikipedia');
  assert.deepEqual(
    about.similar.map((entry) => entry.name),
    ['Chris Martin', 'Apparatjik'],
  );
  // Every entry is an id the caller can feed back to browse or play — that is what makes them
  // items rather than captions.
  assert.ok(about.similar.every((entry) => entry.id.length > 0));
  assert.equal(rows.size, 1, 'the assembled panel is cached');
});

test('about: a name the providers cannot match is dropped, not listed', async () => {
  const { store } = fakeStore();
  const item = artistItem();
  const service = new AboutService({
    describeItem: async () => item,
    // The provider answers a search for anything with its nearest guess, which is how a stranger
    // ends up on a shelf that promises neighbours.
    search: async () => searchHit('Mumford & Sons'),
    store,
    source: {
      fetchArtistStory: async () => ({
        description: 'A band.',
        source: null,
        relatedNames: ['Múm'],
      }),
      fetchAlbumStory: async () => null,
    },
  });

  const about = await service.describeAbout(item.id);
  assert.deepEqual(about?.similar, []);
});

test('about: nothing to tell is a remembered miss, not a repeated question', async () => {
  const { store, rows } = fakeStore();
  const item = artistItem();
  let asked = 0;
  const service = new AboutService({
    describeItem: async () => item,
    search: async () => emptySearch,
    store,
    source: {
      fetchArtistStory: async () => {
        asked += 1;
        return null;
      },
      fetchAlbumStory: async () => null,
    },
  });

  assert.equal(await service.describeAbout(item.id), null);
  assert.equal(await service.describeAbout(item.id), null);
  assert.equal(asked, 1, 'the second visit reads the remembered miss');
  assert.equal(rows.size, 1);
});

test('about: the kind comes from the id, not from what the content layer resolved', async () => {
  const { store } = fakeStore();
  // An artist id whose description arrives claiming to be an album, and named after the first
  // child the content layer could see — both real behaviours of the providers today.
  const id = encodeContainerRef({ kind: 'artist', service: 'applemusic', folderId: 'artist:1' });
  const asked: string[] = [];
  const service = new AboutService({
    describeItem: async () => ({
      ...artistItem({ id }),
      kind: 'album',
      name: 'Viva La Vida or Death and All His Friends',
      artist: 'Coldplay',
    }),
    search: async () => emptySearch,
    store,
    source: {
      fetchArtistStory: async (artist) => {
        asked.push(`artist:${artist}`);
        return { description: 'A British rock band.', source: null, relatedNames: [] };
      },
      fetchAlbumStory: async (album) => {
        asked.push(`album:${album}`);
        return null;
      },
    },
  });

  const about = await service.describeAbout(id);
  assert.deepEqual(asked, ['artist:Coldplay'], 'asked about the artist, by the artist’s name');
  assert.equal(about?.description, 'A British rock band.');
});

test('about: a kind nobody writes about is never asked upstream', async () => {
  const { store } = fakeStore();
  const id = encodeContainerRef({ kind: 'playlist', service: 'applemusic', folderId: 'pl:1' });
  let asked = 0;
  const service = new AboutService({
    describeItem: async () => artistItem({ id, kind: 'playlist', name: 'Road trip' }),
    search: async () => emptySearch,
    store,
    source: {
      fetchArtistStory: async () => {
        asked += 1;
        return null;
      },
      fetchAlbumStory: async () => {
        asked += 1;
        return null;
      },
    },
  });

  assert.equal(await service.describeAbout(id), null);
  assert.equal(asked, 0);
});

test('about: a slow story does not hold the request open', async () => {
  const { store } = fakeStore();
  const item = artistItem();
  const service = new AboutService({
    describeItem: async () => item,
    search: async () => emptySearch,
    store,
    source: {
      // Longer than the route's deadline: four rate-limited upstream calls genuinely take this
      // long, and a browse page may not wait for them.
      fetchArtistStory: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ description: 'Late.', source: null, relatedNames: [] }), 50),
        ),
      fetchAlbumStory: async () => null,
    },
  });

  const started = Date.now();
  const about = await Promise.race([
    service.describeAbout(item.id),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 5_000)),
  ]);
  assert.notEqual(about, 'hung', 'the route answered without waiting for the upstream chain');
  assert.ok(Date.now() - started < 5_000);

  // And the work it started is not thrown away: the next visit finds it.
  await new Promise((resolve) => setTimeout(resolve, 80));
  const second = await service.describeAbout(item.id);
  assert.equal(second?.description, 'Late.');
});

test('about: the service is asked for related artists before the metadata source is', async () => {
  const { store } = fakeStore();
  const item = artistItem();
  const searched: string[] = [];
  const service = new AboutService({
    describeItem: async () => item,
    relatedArtists: async () => [
      { ...artistItem({ id: 'am:zztop', name: 'ZZ Top' }) },
      { ...artistItem({ id: 'am:aerosmith', name: 'Aerosmith' }) },
    ],
    search: async (request) => {
      searched.push(request.query);
      return searchHit(request.query);
    },
    store,
    source: {
      fetchArtistStory: async () => ({
        description: 'A band.',
        source: null,
        // What MusicBrainz has is the line-up, which is not what the shelf asks for.
        relatedNames: ['Bon Scott', 'Phil Rudd'],
      }),
      fetchAlbumStory: async () => null,
    },
  });

  const about = await service.describeAbout(item.id);
  assert.deepEqual(
    about?.similar.map((entry) => entry.name),
    ['ZZ Top', 'Aerosmith'],
  );
  assert.deepEqual(searched, [], 'no provider search when the service answered itself');
});

test('about: a service with no such notion falls back to the relations', async () => {
  const { store } = fakeStore();
  const item = artistItem({ service: 'library' });
  const service = new AboutService({
    describeItem: async () => item,
    // What the local library answers: it has no editorial notion of a neighbour.
    relatedArtists: async () => [],
    search: async (request) => searchHit(request.query),
    store,
    source: {
      fetchArtistStory: async () => ({
        description: 'A band.',
        source: null,
        relatedNames: ['Bon Scott'],
      }),
      fetchAlbumStory: async () => null,
    },
  });

  const about = await service.describeAbout(item.id);
  assert.deepEqual(
    about?.similar.map((entry) => entry.name),
    ['Bon Scott'],
  );
});

test('about: an accent is a different artist, not the same one spelled loosely', async () => {
  const { store } = fakeStore();
  const item = artistItem();
  const service = new AboutService({
    describeItem: async () => item,
    relatedArtists: async () => [],
    // Apple answers a search for "Julia Martin" with a different artist whose name carries an
    // accent. Folding accents away put that stranger on Adele's shelf.
    search: async () => searchHit('Julia Martín'),
    store,
    source: {
      fetchArtistStory: async () => ({
        description: 'A singer.',
        source: null,
        relatedNames: ['Julia Martin'],
      }),
      fetchAlbumStory: async () => null,
    },
  });

  const about = await service.describeAbout(item.id);
  assert.deepEqual(about?.similar, []);
});

test('about: a source that could not be reached is not remembered as a miss', async () => {
  const { store, rows } = fakeStore();
  const item = artistItem();
  let asked = 0;
  const service = new AboutService({
    describeItem: async () => item,
    relatedArtists: async () => [],
    search: async () => emptySearch,
    store,
    source: {
      fetchArtistStory: async () => {
        asked += 1;
        if (asked === 1) {
          // Rate-limited, or a dropped connection — the question was never answered.
          throw new EnrichmentUnavailable('musicbrainz 503');
        }
        return { description: 'A band.', source: null, relatedNames: [] };
      },
      fetchAlbumStory: async () => null,
    },
  });

  assert.equal(await service.describeAbout(item.id), null, 'nothing to show yet');
  assert.equal(rows.size, 0, 'and nothing filed away about it');

  const second = await service.describeAbout(item.id);
  assert.equal(second?.description, 'A band.', 'the next visit asks again');
  assert.equal(asked, 2);
});
