import assert from 'node:assert/strict';
import { test } from './testHarness';
import { createContentAdapter } from '../src/adapters/content/ContentAdapter';
import type { StreamProvider } from '../src/adapters/content/StreamProvider';
import type { ContentManager } from '../src/adapters/content/contentManager';

type Calls = { configured: string[]; started: string[] };

function makeProvider(id: string, prefixes: string[], calls: Calls): StreamProvider {
  return {
    provider: id,
    configure: () => {
      calls.configured.push(id);
    },
    isProvider: (providerId: string) => prefixes.includes(providerId),
    startStreamForAudiopath: async (_zoneId, audiopath) => {
      calls.started.push(`${id}:${audiopath}`);
      return { playbackSource: { kind: 'pipe', path: `/tmp/${id}` } as never };
    },
  };
}

function makeAdapter() {
  const calls: Calls = { configured: [], started: [] };
  // Two accounts of one service and one of another: the slug is part of the prefix.
  const adapter = createContentAdapter({} as unknown as ContentManager, [
    makeProvider('applemusic', ['applemusic', 'applemusic:p0gngd'], calls),
    makeProvider('deezer', ['deezer'], calls),
  ]);
  return { adapter, calls };
}

test('configureProviders reaches every provider, with no list to keep in step', () => {
  const { adapter, calls } = makeAdapter();
  adapter.configureProviders();
  assert.deepEqual(calls.configured, ['applemusic', 'deezer']);
});

test('providerForAudiopath answers by registered prefix, account and all', () => {
  const { adapter } = makeAdapter();
  assert.equal(adapter.providerForAudiopath('applemusic:track:1'), 'applemusic');
  assert.equal(adapter.providerForAudiopath('applemusic:p0gngd:track:1'), 'applemusic');
  assert.equal(adapter.providerForAudiopath('deezer:track:9'), 'deezer');
});

test('providerForAudiopath falls back to the service the path merely names', () => {
  const { adapter } = makeAdapter();
  // A stored Loxone favourite: no prefix of its own, but it says which service it came from.
  assert.equal(adapter.providerForAudiopath('spotify@bridge-applemusic-x:track:1'), 'applemusic');
});

test('providerForAudiopath claims nothing it does not own', () => {
  const { adapter } = makeAdapter();
  assert.equal(adapter.providerForAudiopath('library://track/12'), null);
  assert.equal(adapter.providerForAudiopath('spotify:track:abc'), null);
  assert.equal(adapter.providerForAudiopath(''), null);
  assert.equal(adapter.providerForAudiopath(null), null);
});

test('resolvePlaybackSource hands the path to the service that owns it', async () => {
  const { adapter, calls } = makeAdapter();
  const resolution = await adapter.resolvePlaybackSource({
    audiopath: 'deezer:track:9',
    requester: { kind: 'zone', zoneId: 1 },
  });
  assert.equal(resolution.provider, 'deezer');
  assert.deepEqual(calls.started, ['deezer:deezer:track:9']);
});

test('an unowned path resolves to nothing rather than to the first provider', async () => {
  const { adapter, calls } = makeAdapter();
  const resolution = await adapter.resolvePlaybackSource({
    audiopath: 'library://track/12',
    requester: { kind: 'zone', zoneId: 1 },
  });
  assert.equal(resolution.playbackSource, null);
  assert.deepEqual(calls.started, []);
});

test('a service named in the raw text never outranks one named by the decoded prefix', () => {
  const calls: Calls = { configured: [], started: [] };
  const adapter = createContentAdapter({} as unknown as ContentManager, [
    makeProvider('applemusic', ['applemusic'], calls),
    makeProvider('deezer', ['deezer'], calls),
  ]);
  // Base64 that decodes to an Apple Music path, wrapped in an envelope whose text says deezer.
  // The chain of per-service helpers this replaced asked all four questions about Apple Music
  // before it asked anything about Deezer; the order is part of the contract, not an accident.
  const inner = Buffer.from('applemusic:track:99', 'utf-8').toString('base64');
  assert.equal(adapter.providerForAudiopath(`deezer-ish:track:b64_${inner}`), 'applemusic');
});
