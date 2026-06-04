import assert from 'node:assert/strict';
import { test } from './testHarness';
import { QueueController } from '../src/application/zones/QueueController';
import type { ContentFolder, ContentFolderItem } from '../src/ports/ContentTypes';

const PROVIDER = 'spotify@bridge-applemusic-djq5zp';

function albumItem(id: string): ContentFolderItem {
  return {
    id: `${PROVIDER}:library-album:${id}`,
    name: `Album ${id}`,
    type: 2,
    audiopath: `${PROVIDER}:library-album:${id}`,
    coverurl: `http://cover/${id}`,
    artist: 'Adele',
    album: `Album ${id}`,
  };
}

function trackItem(id: string, album: string): ContentFolderItem {
  return {
    id: `${PROVIDER}:track:${id}`,
    name: `Track ${id}`,
    type: 2,
    audiopath: `${PROVIDER}:track:${id}`,
    coverurl: `http://cover/${album}`,
    artist: 'Adele',
    album,
    duration: 200,
  };
}

function makeFolder(items: ContentFolderItem[]): ContentFolder {
  return { id: 'f', name: 'F', start: 0, totalitems: items.length, items };
}

function makeQueueController(resolve: (folderId: string) => ContentFolder | null) {
  const calls: string[] = [];
  const contentPort = {
    getDefaultSpotifyAccountId: () => null,
    getServiceTrack: async () => null,
    getMediaFolder: async () => null,
    resolveMetadata: async () => null,
    getServiceFolder: async (_service: string, _user: string, folderId: string) => {
      calls.push(folderId);
      return resolve(folderId);
    },
  };
  const deps = {
    log: { debug: () => {}, warn: () => {}, info: () => {}, spam: () => {} },
    contentPort,
    resolveBridgeProvider: () => 'applemusic',
    isMusicAssistantAudiopath: () => false,
    isAppleMusicAudiopath: () => true,
    getMusicAssistantUserId: () => 'ma',
  };
  const qc = new QueueController({} as any, deps as any);
  return { qc, calls };
}

test('apple music artist favorite flattens albums into a playable track queue', async () => {
  const artistPath = `${PROVIDER}:library-artist:r.123`;
  const { qc, calls } = makeQueueController((folderId) => {
    if (folderId === 'library-artist:r.123') {
      return makeFolder([albumItem('al.1'), albumItem('al.2')]);
    }
    if (folderId === 'library-album:al.1') {
      return makeFolder([trackItem('t.1', 'Album al.1'), trackItem('t.2', 'Album al.1')]);
    }
    if (folderId === 'library-album:al.2') {
      return makeFolder([trackItem('t.3', 'Album al.2')]);
    }
    return null;
  });

  const queue = await qc.buildQueueForUri(artistPath, 'Zone', undefined, artistPath);

  assert.equal(queue.length, 3);
  for (const item of queue) {
    assert.ok(/:track:/.test(item.audiopath), `expected a track audiopath, got ${item.audiopath}`);
    assert.ok(!/:library-album:/.test(item.audiopath), `album leaked into queue: ${item.audiopath}`);
  }
  // The artist browse, plus one browse per album.
  assert.ok(calls.includes('library-artist:r.123'));
  assert.ok(calls.includes('library-album:al.1'));
  assert.ok(calls.includes('library-album:al.2'));
});

test('apple music album favorite stays a direct track queue without an extra browse', async () => {
  const albumPath = `${PROVIDER}:library-album:al.9`;
  const { qc, calls } = makeQueueController((folderId) => {
    if (folderId === 'library-album:al.9') {
      return makeFolder([trackItem('t.1', 'Album al.9'), trackItem('t.2', 'Album al.9')]);
    }
    return null;
  });

  const queue = await qc.buildQueueForUri(albumPath, 'Zone', undefined, albumPath);

  assert.equal(queue.length, 2);
  for (const item of queue) {
    assert.ok(/:track:/.test(item.audiopath));
  }
  // Items are already tracks, so no container sub-browse happens.
  assert.deepEqual(calls, ['library-album:al.9']);
});
