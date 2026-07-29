import assert from 'node:assert/strict';
import { test } from './testHarness';
import { sanitizeAudiopathForOutput } from '../src/application/zones/QueueController';
import {
  buildBridgeRegistry,
  toServiceNative,
  toLoxoneAudiopath,
} from '../src/domain/zones/bridgeIdentity';
import type { StreamingServiceConfig } from '../src/domain/config/types';
import { sanitizeTitle, isUriLike } from '../src/application/zones/helpers/stateHelpers';
import { sanitizeStation } from '../src/application/zones/helpers/queueHelpers';

// The native Loxone getqueue schema is FAIL-HARD: each streaming queue item's
// audiopath MUST literally start with `spotify:` and its 2nd segment must be
// `track` or `episode`, else z.array(QueueItemSchema) throws and the WHOLE queue
// renders empty (owner-observed). These tests pin that the boundary collapse
// produces exactly that shape for every service, from both the service-native
// core form and the legacy spotify@bridge form.

test('queue emit: service-native track collapses to bare spotify:track:', () => {
  for (const svc of ['applemusic', 'deezer', 'tidal', 'soundcloud', 'ytmusic']) {
    assert.equal(
      sanitizeAudiopathForOutput(`${svc}:track:b64_abc`),
      'spotify:track:b64_abc',
      `${svc} track`,
    );
  }
});

test('queue emit: legacy spotify@bridge track collapses to bare spotify:track:', () => {
  assert.equal(
    sanitizeAudiopathForOutput('spotify@bridge-applemusic-p0gngd:track:b64_abc'),
    'spotify:track:b64_abc',
  );
});

test('queue emit: Apple library-track alias is mapped down to track (schema only accepts track/episode)', () => {
  // Service-native form
  assert.equal(
    sanitizeAudiopathForOutput('applemusic:library-track:i.abc'),
    'spotify:track:i.abc',
  );
  // Legacy form
  assert.equal(
    sanitizeAudiopathForOutput('spotify@bridge-applemusic-p0gngd:library-track:i.abc'),
    'spotify:track:i.abc',
  );
});

test('queue emit: real spotify + bare spotify: pass through unchanged', () => {
  assert.equal(sanitizeAudiopathForOutput('spotify:track:xyz'), 'spotify:track:xyz');
  assert.equal(
    sanitizeAudiopathForOutput('spotify@realuser:track:xyz'),
    'spotify:track:xyz',
  );
});

test('queue emit: non-streaming audiopaths pass through untouched', () => {
  // library / radio / linein are not spotify-shaped and must not be rewritten.
  assert.equal(sanitizeAudiopathForOutput('library:local:track:b64_x'), 'library:local:track:b64_x');
  assert.equal(sanitizeAudiopathForOutput('linein:input1'), 'linein:input1');
  assert.equal(sanitizeAudiopathForOutput('tunein:s12345'), 'tunein:s12345');
  assert.equal(sanitizeAudiopathForOutput(''), '');
});

// State emit round-trip: the core is service-native; the notifier translates back
// to spotify@bridge so the native now-playing keeps service/account attribution.
test('state emit round-trip: service-native ⇄ spotify@bridge is consistent', () => {
  const bridges: StreamingServiceConfig[] = [
    { id: 'bridge-applemusic-p0gngd', label: 'Apple Music', provider: 'applemusic' },
  ];
  const reg = buildBridgeRegistry(bridges);
  const loxone = 'spotify@bridge-applemusic-p0gngd:track:b64_abc';
  const native = toServiceNative(loxone, reg); // applemusic:track:b64_abc (single-account)
  assert.equal(native, 'applemusic:track:b64_abc');
  // Notifier translates the core form back for the native client.
  assert.equal(toLoxoneAudiopath(native, reg), loxone);
});

// Container playback (album/playlist/artist "play all") round-trips through the
// serviceplay payload resolver as `<accountId>/<service-native-audiopath>`. The
// resolver must rebuild the `spotify@<accountId>:` envelope so toServiceNative
// yields a service-native container whose `split(':')[0]` is the real service
// (not the slash-compound `bridge-.../applemusic` that broke container playback).
// Mirror of the serviceplay payload resolver in zoneHandlers.ts, exercised on
// the exact payload the native client sends for a container play (measured from
// a real device log): `<accountId>/<service-native-audiopath>`.
function resolveServiceplayPayload(decoded: string): string {
  const withoutNouser = decoded.startsWith('nouser/') ? decoded.slice('nouser/'.length) : decoded;
  const slashIndex = withoutNouser.indexOf('/');
  if (slashIndex > 0) {
    const maybeUser = withoutNouser.slice(0, slashIndex);
    const rest = withoutNouser.slice(slashIndex + 1);
    if (rest.startsWith('spotify@') || rest.startsWith('spotify:')) {
      return rest.startsWith('spotify:') ? `spotify@${maybeUser}:${rest.replace(/^spotify:/i, '')}` : rest;
    }
    if (
      maybeUser &&
      /^(?:bridge-)?(?:applemusic|deezer|tidal|soundcloud|ytmusic|youtube|musicassistant)\b/i.test(maybeUser) &&
      /^(?:applemusic|deezer|tidal|soundcloud|ytmusic|youtube|musicassistant):/i.test(rest)
    ) {
      return `spotify@${maybeUser}:${rest.slice(rest.indexOf(':') + 1)}`;
    }
    return `${maybeUser}/${rest}`;
  }
  return withoutNouser;
}

test('container playback intake: measured device payload resolves to real service', () => {
  const bridges: StreamingServiceConfig[] = [
    { id: 'bridge-applemusic-p0gngd', label: 'Apple Music', provider: 'applemusic' },
  ];
  const reg = buildBridgeRegistry(bridges);
  for (const kind of ['library-playlist', 'album', 'playlist', 'artist']) {
    // Exactly what parts.slice(4) yields for the real command
    // `audio/28/serviceplay/spotify/bridge-applemusic-p0gngd/applemusic:<kind>:b64_X`:
    const devicePayload = `bridge-applemusic-p0gngd/applemusic:${kind}:b64_X`;
    // Payload resolver must NOT slash-glue; it must rebuild the spotify@ envelope.
    const resolved = resolveServiceplayPayload(devicePayload);
    assert.equal(resolved, `spotify@bridge-applemusic-p0gngd:${kind}:b64_X`, `${kind} resolver`);
    assert.ok(!resolved.split(':')[0].includes('/'), `${kind} no slash in first token`);
    // Then the playContent intake normalizes to service-native.
    const native = toServiceNative(resolved, reg);
    assert.equal(native, `applemusic:${kind}:b64_X`, `${kind} native`);
    assert.equal(native.split(':')[0], 'applemusic', `${kind} provider key`);
  }
});

// Now-playing title must never show a raw service-native audiopath. On the
// bridge-service fast path the queue-rebuild patch is the last writer, so its
// title (and the metadata/active-item titles) are sanitized; a service-native
// audiopath is treated as uri-like and falls back instead of being displayed.
test('title guards reject service-native audiopaths (title-race fix)', () => {
  const containers = [
    'applemusic:playlist:b64_X',
    'applemusic:library-album:b64_X',
    'applemusic:track:b64_X',
    'soundcloud:track:12345',
    'tidal:album:9',
  ];
  for (const ap of containers) {
    assert.ok(isUriLike(ap), `isUriLike must catch ${ap}`);
    assert.equal(sanitizeTitle(ap, 'Zone Name'), 'Zone Name', `sanitizeTitle falls back for ${ap}`);
  }
  // Real titles pass through untouched.
  assert.equal(sanitizeTitle('Intro', 'Zone Name'), 'Intro');
  assert.ok(!isUriLike('Intro'));
  // Local library is its own native concept — not a bridge service; a real
  // library TITLE (not audiopath) must still pass.
  assert.ok(!isUriLike('My Favourite Song'));
});

// The station line is the source label the native client renders. When you play
// a container, its audiopath must NOT leak there. Pre-service-native the legacy
// `spotify@bridge-...:playlist:...` form was blanked; the service-native form
// (`applemusic:playlist:...`) must be blanked too, else the raw container id
// shows up as the source line (owner-observed regression).
test('station guard: service-native container audiopaths are blanked', () => {
  const trackAudiopath = 'applemusic:track:b64_MTU4NDAzNDU5Mg==';
  const containers = [
    'applemusic:playlist:b64_cGwucG0t',
    'applemusic:library-playlist:b64_cC54cmFlbVdn',
    'applemusic:album:b64_X',
    'soundcloud:playlist:12345',
    'tidal:album:9',
    'deezer:playlist:7',
  ];
  for (const c of containers) {
    assert.equal(sanitizeStation(c, trackAudiopath), '', `station blanked for ${c}`);
  }
  // Legacy Loxone disguise stays blanked (unchanged behaviour).
  assert.equal(sanitizeStation('spotify@bridge-applemusic-p0gngd:playlist:b64_X', trackAudiopath), '');
  // A real, human-readable station name must still pass through.
  assert.equal(sanitizeStation('Radio Paradise', 'tunein:s12345'), 'Radio Paradise');
  assert.equal(sanitizeStation('BBC Radio 6 Music', 'tunein:s6'), 'BBC Radio 6 Music');
});
