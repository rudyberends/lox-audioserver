import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  providerTypeFromBridgeId,
  rootItemsForLoxone,
  toProviderNode,
} from '../src/adapters/loxone/commands/utils/loxoneServiceFolders';

const APPLE = 'bridge-applemusic-dgmv27';

// These six mappings are what the Loxone app has always received. The provider used
// to decode the slot indices itself; moving that here must not change a single one,
// so they are pinned rather than described.
test('Loxone service-folder slots map onto the same Apple Music nodes as before', () => {
  const expected: Array<[string, string]> = [
    ['0', 'new-releases'],
    ['1', 'recommended-playlists'],
    ['2', 'recommended-albums'],
    ['3', 'playlists'],
    ['5', 'albums'],
    ['6', 'artists'],
  ];
  for (const [slot, node] of expected) {
    assert.equal(toProviderNode(APPLE, slot), node, `slot ${slot}`);
  }
});

test('a node name passes through untouched, so other consumers address nodes directly', () => {
  for (const node of ['root', 'albums', 'recent', 'songs', 'applemusic:album:123']) {
    assert.equal(toProviderNode(APPLE, node), node);
  }
});

test('a service without a slot table keeps its folder ids, so providers migrate one at a time', () => {
  for (const folderId of ['0', '5', 'albums']) {
    assert.equal(toProviderNode('bridge-tidal-abc123', folderId), folderId);
    assert.equal(toProviderNode('radioparadise', folderId), folderId);
  }
});

test('the root listing goes back to Loxone as its own slot indices', () => {
  const items = [
    { id: 'new-releases', name: 'New Releases' },
    { id: 'recommended-playlists', name: 'Recommended Playlists' },
    { id: 'recommended-albums', name: 'Recommended Albums' },
    { id: 'albums', name: 'Albums' },
    { id: 'artists', name: 'Artists' },
    { id: 'playlists', name: 'Playlists' },
  ];
  assert.deepEqual(
    rootItemsForLoxone(APPLE, items).map((item) => [item.id, item.name]),
    [
      ['0', 'New Releases'],
      ['1', 'Recommended Playlists'],
      ['2', 'Recommended Albums'],
      ['5', 'Albums'],
      ['6', 'Artists'],
      ['3', 'Playlists'],
    ],
  );
});

// The point of the whole exercise: a provider may publish nodes the Loxone app has
// no slot for. Those must not reach it — an unaddressable id in a fixed section
// would render the wrong content — while every other consumer sees them.
test('nodes without a Loxone slot are left out of the Loxone root', () => {
  const items = [
    { id: 'albums', name: 'Albums' },
    { id: 'recent', name: 'Recently Added' },
    { id: 'charts', name: 'Charts' },
  ];
  assert.deepEqual(
    rootItemsForLoxone(APPLE, items).map((item) => item.id),
    ['5'],
  );
});

test('providerTypeFromBridgeId reads the service out of a bridge id', () => {
  assert.equal(providerTypeFromBridgeId('bridge-applemusic-dgmv27'), 'applemusic');
  assert.equal(providerTypeFromBridgeId('bridge-tidal-abc'), 'tidal');
  assert.equal(providerTypeFromBridgeId('radioparadise'), '');
  assert.equal(providerTypeFromBridgeId(''), '');
});
