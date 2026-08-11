import assert from 'node:assert/strict';
import { test } from './testHarness';
import { BrowseService } from '../src/adapters/http/api/browseService';
import type { ContentManager } from '../src/adapters/content/contentManager';
import { encodeContainerRef } from '../src/domain/media/browseRef';
import type { ConfigPort } from '../src/ports/ConfigPort';

// A browse id is opaque and promised to round-trip, which makes `container.id` a contract and not
// a convenience: whatever a caller browsed with is what it must get back, labelled the way it
// asked. The content layer's own idea of what a folder is cannot be allowed to rewrite it — for
// several providers an artist folder resolves to `album`, and a client that re-used the answer
// (the player does, for `/items/{id}/about`) then held an artist page addressed as an album.

const config = ({
  getConfig: () => ({
    content: {
      streamingServices: [{ id: 'am1', provider: 'applemusic', enabled: true, label: 'Apple Music' }],
      radio: { radioParadise: { enabled: false } },
    },
  }),
}) as unknown as ConfigPort;

/**
 * A content layer that behaves the way Apple Music's does: a folder that names its kind rather
 * than itself, and a `resolveFolder` that describes an artist as an album named after the first
 * child it could see.
 */
const contentManager = {
  getServiceFolder: async () => ({
    id: 'applemusic:library-artist:1',
    name: 'Artist',
    service: 'applemusic',
    start: 0,
    totalitems: 1,
    items: [],
  }),
  resolveFolder: async () => ({
    id: 'applemusic:library-artist:1',
    name: 'Live at River Plate',
    kind: 'album',
    tag: 'album',
  }),
} as unknown as ContentManager;

test('browse answers with the id it was asked with, and the kind that id carries', async () => {
  const id = encodeContainerRef({
    kind: 'artist',
    service: 'applemusic',
    folderId: 'applemusic:library-artist:1',
  });
  const result = await new BrowseService(config, contentManager).browse(id, 0, 50);

  assert.ok(result);
  assert.equal(result.container?.id, id, 'the container is the thing that was asked for');
  assert.equal(result.container?.kind, 'artist');
  // The name is still worth taking from the description — that is the one thing the listing
  // could not tell us, and the reason to ask at all.
  assert.equal(result.container?.name, 'Live at River Plate');
});
