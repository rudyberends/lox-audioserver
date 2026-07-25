import assert from 'node:assert/strict';
import { test } from './testHarness';
import { sanitizeAudiopathForOutput } from '../src/application/zones/QueueController';
import {
  buildBridgeRegistry,
  toServiceNative,
  toLoxoneAudiopath,
} from '../src/domain/loxone/bridgeIdentity';
import type { SpotifyBridgeConfig } from '../src/domain/config/types';

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
  const bridges: SpotifyBridgeConfig[] = [
    { id: 'bridge-applemusic-p0gngd', label: 'Apple Music', provider: 'applemusic' },
  ];
  const reg = buildBridgeRegistry(bridges);
  const loxone = 'spotify@bridge-applemusic-p0gngd:track:b64_abc';
  const native = toServiceNative(loxone, reg); // applemusic:track:b64_abc (single-account)
  assert.equal(native, 'applemusic:track:b64_abc');
  // Notifier translates the core form back for the native client.
  assert.equal(toLoxoneAudiopath(native, reg), loxone);
});
