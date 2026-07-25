import assert from 'node:assert/strict';
import { test } from './testHarness';
import { parseServiceNativeAudiopath, KNOWN_KINDS } from '../src/domain/loxone/audiopath';
import {
  buildBridgeRegistry,
  slugFromBridgeId,
  toServiceNative,
  toLoxoneAudiopath,
} from '../src/domain/loxone/bridgeIdentity';
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
