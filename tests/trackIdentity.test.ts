import assert from 'node:assert/strict';
import { test } from './testHarness';
import { decodeAudiopath } from '../src/domain/loxone/audiopath';
import { decodeTrackUri } from '../src/domain/media/trackIdentity';

const wrap = (uri: string, prefix = 'library:track') =>
  `${prefix}:b64_${Buffer.from(uri, 'utf8').toString('base64')}`;

// Decoding a track identity used to be one function that did two things: unwrap our
// own base64 payload, and strip the routing hints the Miniserver appends. Only the
// second is Loxone's. These pin that the split changed neither.
test('unwrapping a payload is identical either way', () => {
  const samples = [
    wrap('library:///Local Media/Underworld/x.mp3'),
    wrap('i.b1JEvmxuqL7JOW', 'applemusic:library-album'),
    'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
    'musicassistant://track/1/abc',
    'library://alerts/bell.mp3',
    '',
  ];
  for (const sample of samples) {
    assert.equal(decodeTrackUri(sample), decodeAudiopath(sample), sample);
  }
});

test('a wrapped payload comes back out whole', () => {
  const uri = 'library:///Local Media/Ed Sheeran - Play/01 Opening.mp3';
  assert.equal(decodeTrackUri(wrap(uri)), uri);
});

// A payload that is not valid base64 must not throw — the caller has nothing to
// fall back to, so the wrapped form is returned as-is.
test('a broken payload falls back to the input', () => {
  const broken = 'library:track:b64_@@@not base64@@@';
  assert.equal(decodeTrackUri(broken), decodeTrackUri(broken));
  assert.ok(decodeTrackUri(broken).length > 0);
});

// The half that IS Loxone's: only its decoder knows about the hints, which is the
// point of the split — a DLNA or Subsonic client never sends one.
test('routing hints are the Loxone decoder\'s business alone', () => {
  const clean = wrap('library:///Local Media/x.mp3');
  for (const hint of ['/parentpath/Albums/Foo', '/noshuffle', '/parentid/42', '/']) {
    assert.equal(decodeAudiopath(`${clean}${hint}`), decodeAudiopath(clean), hint);
  }
  // The neutral decoder does not know the hints exist — that is the point of keeping
  // them apart. It usually gets away with it anyway: base64 padding ends the decode,
  // so a hint after a padded payload is ignored. Only an unpadded one (a URI whose
  // length is a multiple of three) actually shows the difference.
  const unpadded = wrap('library:///a/b.mp3');
  assert.ok(!unpadded.includes('='), 'fixture must be unpadded to prove anything');
  assert.equal(decodeAudiopath(`${unpadded}/noshuffle`), decodeAudiopath(unpadded));
  assert.notEqual(decodeTrackUri(`${unpadded}/noshuffle`), decodeTrackUri(unpadded));
});
