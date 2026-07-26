import assert from 'node:assert/strict';
import { test } from './testHarness';
import { pickAlbumShelf } from '../src/adapters/content/providers/applemusic/appleMusicParsers';

/**
 * The shape Apple's editorial home feed actually has, trimmed to what the picker
 * looks at: a grouping → tabs → nested elements, each shelf holding its items inline.
 */
const shelf = (opts: {
  resourceTypes?: string[];
  emphasize?: boolean;
  contents: string[];
  name?: string;
}) => ({
  id: `el-${opts.name ?? opts.contents.join('')}`,
  type: 'editorial-elements',
  attributes: {
    name: opts.name ?? 'Some shelf',
    editorialElementKind: '326',
    resourceTypes: opts.resourceTypes ?? ['albums'],
    ...(opts.emphasize === undefined ? {} : { emphasize: opts.emphasize }),
  },
  relationships: {
    contents: { data: opts.contents.map((id) => ({ id, type: 'albums' })) },
  },
});

const feed = (shelves: unknown[]) => ({
  data: [
    {
      id: '173047',
      type: 'groupings',
      attributes: { name: 'Music Main' },
      relationships: {
        tabs: {
          data: [
            {
              id: 'default',
              type: 'editorial-elements',
              attributes: { editorialElementKind: '382' },
              relationships: { children: { data: shelves } },
            },
          ],
        },
      },
    },
  ],
});

// Apple flags its lead shelf; in the real feed that is 'Nieuw deze week', ahead of
// 'Recente releases' and 'Binnenkort'. Order alone would pick whichever came first.
test('the emphasized album shelf wins over document order', () => {
  const picked = pickAlbumShelf(
    feed([
      shelf({ contents: ['later-1', 'later-2'], name: 'Recente releases' }),
      shelf({ contents: ['lead-1', 'lead-2'], emphasize: true, name: 'Nieuw deze week' }),
    ]),
  );
  assert.deepEqual(
    picked.map((entry: any) => entry.id),
    ['lead-1', 'lead-2'],
  );
});

test('without an emphasized shelf the first album shelf is used', () => {
  const picked = pickAlbumShelf(
    feed([
      shelf({ contents: ['first-1'], name: 'A' }),
      shelf({ contents: ['second-1'], name: 'B' }),
    ]),
  );
  assert.deepEqual(picked.map((entry: any) => entry.id), ['first-1']);
});

// The feed is mostly playlists, songs, videos and stations. Picking one of those
// would fill an album section with things that are not albums.
test('shelves of other resource types are skipped', () => {
  const picked = pickAlbumShelf(
    feed([
      shelf({ resourceTypes: ['playlists'], contents: ['pl-1'], emphasize: true }),
      shelf({ resourceTypes: ['songs'], contents: ['song-1'] }),
      shelf({ contents: ['album-1'] }),
    ]),
  );
  assert.deepEqual(picked.map((entry: any) => entry.id), ['album-1']);
});

test('an empty shelf is not a shelf', () => {
  const picked = pickAlbumShelf(
    feed([shelf({ contents: [], emphasize: true }), shelf({ contents: ['real-1'] })]),
  );
  assert.deepEqual(picked.map((entry: any) => entry.id), ['real-1']);
});

// A storefront whose feed has no album shelf must come back empty, not throw: the
// caller logs and serves an empty section rather than mislabelling the charts.
test('a feed with no album shelf yields nothing', () => {
  assert.deepEqual(pickAlbumShelf(feed([shelf({ resourceTypes: ['playlists'], contents: ['p'] })])), []);
  assert.deepEqual(pickAlbumShelf({ data: [] }), []);
  assert.deepEqual(pickAlbumShelf(null), []);
});
