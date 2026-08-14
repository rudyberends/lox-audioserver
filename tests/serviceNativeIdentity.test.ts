import assert from 'node:assert/strict';
import { test } from './testHarness';
import { parseServiceNativeAudiopath, KNOWN_KINDS } from '../src/domain/zones/audiopath';
import {
  buildBridgeRegistry,
  toServiceNative,
  toLoxoneAudiopath,
} from '../src/domain/zones/bridgeIdentity';
import {
  searchSourceFromServiceKey,
  serviceNativeKey,
  slugFromBridgeId,
  serviceLabelForAudiopath,
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

// The Loxone app knows one streaming service, so it asks for all of them as
// `spotify` and names the real one in `user`. Resolving the bare service name
// before that user meant a single added Spotify account answered for every other
// service at once — Apple Music, SoundCloud and the rest all listing Spotify.
test('a Spotify account does not answer for the services disguised as it', async () => {
  const configPort = { getConfig: () => ({ content: {} }) } as unknown as ConfigPort;
  const manager = new SpotifyServiceManager(
    configPort,
    [{ id: 'acct1', user: 'rudy@example.com', displayName: 'Rudy' }],
    'test-client',
    SINGLE,
  );

  // `user` carries the advertised label; older clients echo the bridge id.
  assert.equal((await manager.getFolder('spotify', 'Apple Music', 'root', 0, 1))?.name, 'Apple Music');
  assert.equal(
    (await manager.getFolder('spotify', 'bridge-applemusic-p0gngd', 'root', 0, 1))?.name,
    'Apple Music',
  );
  assert.equal((await manager.getFolder('spotify', 'SoundCloud', 'root', 0, 1))?.name, 'SoundCloud');

  // Real Spotify still resolves — by label, by account id, and unaddressed.
  for (const user of ['Rudy', 'acct1', 'rudy@example.com', 'nouser', '']) {
    assert.equal((await manager.getFolder('spotify', user, 'root', 0, 1))?.name, 'Rudy', `user ${user}`);
  }
});

// Same precedence, second consequence: with two accounts the bare service name
// resolved to the default one, so the second account browsed the first's library.
test('a named Spotify account beats the default one', async () => {
  const configPort = { getConfig: () => ({ content: {} }) } as unknown as ConfigPort;
  const manager = new SpotifyServiceManager(
    configPort,
    [
      { id: 'acct1', user: 'rudy@example.com', displayName: 'Rudy' },
      { id: 'acct2', user: 'partner@example.com', displayName: 'Partner' },
    ],
    'test-client',
    SINGLE,
  );

  assert.equal((await manager.getFolder('spotify', 'Partner', 'root', 0, 1))?.name, 'Partner');
  assert.equal((await manager.getFolder('spotify', 'acct2', 'root', 0, 1))?.name, 'Partner');
  // Unaddressed still falls back to the default account.
  assert.equal((await manager.getFolder('spotify', 'nouser', 'root', 0, 1))?.name, 'Rudy');
});


// --- serviceLabelForAudiopath -----------------------------------------------

/** The parser the real caller passes in, reduced to what these cases need. */
const parseNative = (path: string): { service: string; slug?: string } | null => {
  const match = /^([a-z]+)(?:@([a-z0-9]+))?:/.exec(path);
  if (!match) return null;
  return match[2] ? { service: match[1]!, slug: match[2] } : { service: match[1]! };
};

const SERVICES = [
  { id: 'bridge-applemusic-p0gngd', provider: 'applemusic', label: 'Apple Music' },
  { id: 'bridge-spotify-abc123', provider: 'spotify', label: 'Spotify' },
];

test('a local library track is named, rather than falling through to nothing', () => {
  /*
   * The gap this closes: a `library://` audiopath is not service-native, so nothing matched and the
   * name fell through to `sourceName` — which for a local file holds this server's routing MAC and is
   * deliberately blanked. The source ended up with no name at all, and the player showed the *kind*
   * instead: a chip reading "TRACK" over a record in your own library.
   */
  assert.equal(
    serviceLabelForAudiopath("library://local/Coldplay/01 - Don't Panic.flac", SERVICES, parseNative),
    'Library',
  );
  // Whichever share it was indexed from, and whatever case the scheme arrives in.
  assert.equal(serviceLabelForAudiopath('LIBRARY://nas/x.flac', SERVICES, parseNative), 'Library');
});

test('a streaming service is still named from its configured label', () => {
  assert.equal(serviceLabelForAudiopath('applemusic:track:b64_x', SERVICES, parseNative), 'Apple Music');
  assert.equal(serviceLabelForAudiopath('spotify:track:4uLU6h', SERVICES, parseNative), 'Spotify');
  // The account slug has to match when the audiopath carries one.
  assert.equal(
    serviceLabelForAudiopath('applemusic@p0gngd:track:b64_x', SERVICES, parseNative),
    'Apple Music',
  );
  assert.equal(serviceLabelForAudiopath('applemusic@other:track:b64_x', SERVICES, parseNative), null);
});

test('nothing nameable answers null rather than an invented label', () => {
  assert.equal(serviceLabelForAudiopath('', SERVICES, parseNative), null);
  assert.equal(serviceLabelForAudiopath('   ', SERVICES, parseNative), null);
  // A configured-but-unknown provider, and a path with no scheme at all.
  assert.equal(serviceLabelForAudiopath('tidal:track:1', SERVICES, parseNative), null);
  assert.equal(serviceLabelForAudiopath('/music/song.flac', SERVICES, parseNative), null);
});
