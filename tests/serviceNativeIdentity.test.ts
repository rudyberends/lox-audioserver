import assert from 'node:assert/strict';
import { test } from './testHarness';
import { parseServiceNativeAudiopath, KNOWN_KINDS } from '../src/domain/loxone/audiopath';
import {
  buildBridgeRegistry,
  toServiceNative,
  toLoxoneAudiopath,
} from '../src/domain/loxone/bridgeIdentity';
import {
  searchSourceFromServiceKey,
  serviceNativeKey,
  slugFromBridgeId,
} from '../src/domain/media/serviceIdentity';
import { buildBrowsableServices } from '../src/adapters/content/browsableServices';
import type { ConfigPort } from '../src/ports/ConfigPort';
import { SpotifyServiceManager } from '../src/adapters/content/providers/spotifyServiceManager';
import type { StreamingServiceConfig } from '../src/domain/config/types';

// --- Fixtures ---------------------------------------------------------------

// Single-account-per-service (mirrors the real config: applemusic + soundcloud).
const SINGLE: StreamingServiceConfig[] = [
  { id: 'bridge-applemusic-p0gngd', label: 'Apple Music', provider: 'applemusic' },
  { id: 'bridge-soundcloud-e0hmz5', label: 'SoundCloud', provider: 'soundcloud' },
];

// Two accounts of the SAME service (synthetic multi-account case).
const MULTI: StreamingServiceConfig[] = [
  { id: 'bridge-applemusic-aaa111', label: 'Apple A', provider: 'applemusic' },
  { id: 'bridge-applemusic-bbb222', label: 'Apple B', provider: 'applemusic' },
];

// --- slugFromBridgeId -------------------------------------------------------

test('slugFromBridgeId strips the bridge-<provider>- prefix', () => {
  assert.equal(slugFromBridgeId('bridge-applemusic-p0gngd', 'applemusic'), 'p0gngd');
  assert.equal(slugFromBridgeId('bridge-soundcloud-e0hmz5', 'soundcloud'), 'e0hmz5');
});

test('slugFromBridgeId falls back to generic bridge- strip then full id', () => {
  // provider mismatch → generic strip
  assert.equal(slugFromBridgeId('bridge-tidal-xyz', 'applemusic'), 'xyz');
  // non-conforming → full id
  assert.equal(slugFromBridgeId('weird-id', 'applemusic'), 'weird-id');
});

// --- parser -----------------------------------------------------------------

test('parseServiceNativeAudiopath: service:kind:id (implicit account)', () => {
  const p = parseServiceNativeAudiopath('applemusic:track:b64_abc');
  assert.deepEqual(p, { service: 'applemusic', slug: undefined, kind: 'track', isLibrary: false, id: 'b64_abc' });
});

test('parseServiceNativeAudiopath: service:acct:kind:id', () => {
  const p = parseServiceNativeAudiopath('applemusic:p0gngd:album:X');
  assert.deepEqual(p, { service: 'applemusic', slug: 'p0gngd', kind: 'album', isLibrary: false, id: 'X' });
});

test('parseServiceNativeAudiopath: library- alias sets isLibrary', () => {
  const p = parseServiceNativeAudiopath('applemusic:p0gngd:library-track:i.abc');
  assert.deepEqual(p, { service: 'applemusic', slug: 'p0gngd', kind: 'track', isLibrary: true, id: 'i.abc' });
});

test('parseServiceNativeAudiopath: base64 id with colons survives (greedy)', () => {
  const p = parseServiceNativeAudiopath('tidal:track:b64_aa:bb:cc');
  assert.equal(p?.id, 'b64_aa:bb:cc');
});

test('parseServiceNativeAudiopath rejects legacy @ and scheme forms', () => {
  assert.equal(parseServiceNativeAudiopath('spotify@bridge-applemusic-p0gngd:track:X'), null);
  assert.equal(parseServiceNativeAudiopath('spotify@acct:track:X'), null);
  assert.equal(parseServiceNativeAudiopath('linein://zone'), null);
  assert.equal(parseServiceNativeAudiopath('applemusic:track'), null); // no id
  assert.equal(parseServiceNativeAudiopath(''), null);
});

test('parseServiceNativeAudiopath: a slug that is not a known kind is treated as account', () => {
  // 'p0gngd' is not in KNOWN_KINDS, so it must be the account.
  assert.ok(!KNOWN_KINDS.includes('p0gngd' as never));
  const p = parseServiceNativeAudiopath('applemusic:p0gngd:track:X');
  assert.equal(p?.slug, 'p0gngd');
});

// --- toServiceNative --------------------------------------------------------

test('toServiceNative: single-account drops the slug', () => {
  const reg = buildBridgeRegistry(SINGLE);
  assert.equal(
    toServiceNative('spotify@bridge-applemusic-p0gngd:track:b64_X', reg),
    'applemusic:track:b64_X',
  );
  assert.equal(
    toServiceNative('spotify@bridge-soundcloud-e0hmz5:playlist:Y', reg),
    'soundcloud:playlist:Y',
  );
});

test('toServiceNative: multi-account keeps the slug', () => {
  const reg = buildBridgeRegistry(MULTI);
  assert.equal(
    toServiceNative('spotify@bridge-applemusic-aaa111:track:X', reg),
    'applemusic:aaa111:track:X',
  );
  assert.equal(
    toServiceNative('spotify@bridge-applemusic-bbb222:track:Y', reg),
    'applemusic:bbb222:track:Y',
  );
});

test('toServiceNative: genuine spotify + bare spotify + unknown bridge pass through', () => {
  const reg = buildBridgeRegistry(SINGLE);
  assert.equal(toServiceNative('spotify:track:X', reg), 'spotify:track:X');
  assert.equal(toServiceNative('spotify@realuser:track:X', reg), 'spotify@realuser:track:X');
  assert.equal(
    toServiceNative('spotify@bridge-deezer-unknown:track:X', reg),
    'spotify@bridge-deezer-unknown:track:X',
  );
  assert.equal(toServiceNative('applemusic:track:X', reg), 'applemusic:track:X'); // already native
});

// --- round-trip (R4) --------------------------------------------------------

test('round-trip toLoxoneAudiopath(toServiceNative(x)) === x for every SINGLE bridge', () => {
  const reg = buildBridgeRegistry(SINGLE);
  const cases = [
    'spotify@bridge-applemusic-p0gngd:track:b64_abc',
    'spotify@bridge-applemusic-p0gngd:library-track:i.xyz',
    'spotify@bridge-applemusic-p0gngd:album:b64_aa:bb',
    'spotify@bridge-soundcloud-e0hmz5:playlist:123',
  ];
  for (const x of cases) {
    const native = toServiceNative(x, reg);
    const back = toLoxoneAudiopath(native, reg);
    assert.equal(back, x, `round-trip failed for ${x} (native=${native})`);
  }
});

test('round-trip for MULTI (slug preserved both ways)', () => {
  const reg = buildBridgeRegistry(MULTI);
  for (const x of [
    'spotify@bridge-applemusic-aaa111:track:X',
    'spotify@bridge-applemusic-bbb222:album:Y',
  ]) {
    assert.equal(toLoxoneAudiopath(toServiceNative(x, reg), reg), x);
  }
});

test('toLoxoneAudiopath: genuine spotify + unknown (service,slug) pass through', () => {
  const reg = buildBridgeRegistry(SINGLE);
  assert.equal(toLoxoneAudiopath('spotify:track:X', reg), 'spotify:track:X');
  assert.equal(toLoxoneAudiopath('deezer:nope:track:X', reg), 'deezer:nope:track:X');
});

test('accountCountByService reflects the config', () => {
  assert.equal(buildBridgeRegistry(SINGLE).accountCountByService.get('applemusic'), 1);
  assert.equal(buildBridgeRegistry(MULTI).accountCountByService.get('applemusic'), 2);
});

// --- serviceNativeKey: what a non-Loxone consumer calls an account -----------

test('serviceNativeKey names a lone account by its service alone', () => {
  assert.equal(serviceNativeKey(SINGLE[0]!, SINGLE), 'applemusic');
  assert.equal(serviceNativeKey(SINGLE[1]!, SINGLE), 'soundcloud');
});

// The slug only earns its place when there is something to tell apart, so the
// common setup gets the short name and nothing has to know about accounts.
test('serviceNativeKey adds the account only when a service has several', () => {
  assert.equal(serviceNativeKey(MULTI[0]!, MULTI), 'applemusic:aaa111');
  assert.equal(serviceNativeKey(MULTI[1]!, MULTI), 'applemusic:bbb222');
});

test('serviceNativeKey ignores disabled accounts when counting', () => {
  const bridges: StreamingServiceConfig[] = [
    { id: 'bridge-applemusic-aaa111', label: 'A', provider: 'applemusic' },
    { id: 'bridge-applemusic-bbb222', label: 'B', provider: 'applemusic', enabled: false },
  ];
  assert.equal(serviceNativeKey(bridges[0]!, bridges), 'applemusic');
});

// globalSearch spends the colon on its filter list, so the account moves behind an
// `@` there. A single-account service reads the same either way.
test('searchSourceFromServiceKey moves the account behind an @', () => {
  assert.equal(searchSourceFromServiceKey('applemusic'), 'applemusic');
  assert.equal(searchSourceFromServiceKey('applemusic:aaa111'), 'applemusic@aaa111');
});

// --- the identity that actually reaches DLNA and Subsonic -------------------

const configWith = (bridges: StreamingServiceConfig[]): ConfigPort =>
  ({
    getConfig: () => ({
      content: { streamingServices: bridges, radio: { radioParadise: { enabled: true } } },
    }),
  }) as unknown as ConfigPort;

// The whole point: the word "bridge" describes a disguise DLNA and Subsonic are not
// party to, and it used to be in every object id they handed out.
test('no browsable service carries a Loxone bridge id', () => {
  for (const bridges of [SINGLE, MULTI]) {
    for (const service of buildBrowsableServices(configWith(bridges))) {
      assert.ok(!service.key.includes('bridge'), `key ${service.key}`);
      assert.ok(!(service.searchSource ?? '').includes('bridge'), `source ${service.searchSource}`);
      assert.ok(!(service.searchSource ?? '').includes('spotify@'), `source ${service.searchSource}`);
    }
  }
});

test('browsable services are named service-natively, one per account', () => {
  assert.deepEqual(
    buildBrowsableServices(configWith(SINGLE)).map((s) => [s.key, s.searchSource]),
    [
      ['library', 'local'],
      ['radio', null],
      ['applemusic', 'applemusic'],
      ['soundcloud', 'soundcloud'],
    ],
  );
  assert.deepEqual(
    buildBrowsableServices(configWith(MULTI)).map((s) => [s.key, s.searchSource]),
    [
      ['library', 'local'],
      ['radio', null],
      ['applemusic:aaa111', 'applemusic@aaa111'],
      ['applemusic:bbb222', 'applemusic@bbb222'],
    ],
  );
});

// With one account per service the service name is enough. With two, it is not —
// and resolving to "the first one" would quietly serve the wrong library. The root
// listing carries the account's own label, so it says which one answered.
test('a service-native key with an account resolves to that account', async () => {
  const configPort = { getConfig: () => ({ content: {} }) } as unknown as ConfigPort;
  const manager = new SpotifyServiceManager(configPort, [], 'test-client', MULTI);

  const a = await manager.getFolder('applemusic:aaa111', 'applemusic:aaa111', 'root', 0, 1);
  const b = await manager.getFolder('applemusic:bbb222', 'applemusic:bbb222', 'root', 0, 1);
  assert.equal(a?.name, 'Apple A');
  assert.equal(b?.name, 'Apple B');

  // The search grammar's `@` form has to land on the same account.
  const viaSearchForm = await manager.getFolder('applemusic', 'bbb222', 'root', 0, 1);
  assert.equal(viaSearchForm?.name, 'Apple B');
});
