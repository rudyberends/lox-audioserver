import { zoneSessionKey } from '../../src/ports/types/SessionKey';
import assert from 'node:assert/strict';
import { test } from '../testHarness';
import { AudioSession } from '../../src/engine/audioSession';
import type { AudioOutputSettings } from '../../src/engine/audioFormat';

const OUTPUT: AudioOutputSettings = {
  sampleRate: 44100,
  channels: 2,
  pcmBitDepth: 16,
  mp3Bitrate: '256k',
  prebufferBytes: 0,
  httpProfile: 'default',
  httpFallbackSeconds: 12 * 3600,
  fixedGainDb: 0,
  httpIcyEnabled: false,
  httpIcyInterval: 16384,
  httpIcyName: 'test',
};

function fileSession(): AudioSession {
  // No start(): the restart path rebuilds the command line before it touches a process, which is
  // exactly what this asserts.
  return new AudioSession(
    zoneSessionKey(1),
    { kind: 'file', path: '/music/track.flac' },
    'pcm',
    () => {},
    OUTPUT,
    null,
    false,
  );
}

test('an equalizer restart seeks to the supplied position', () => {
  const session = fileSession();
  assert.ok(!session.args.buildInputArgs().includes('-ss'), 'the first run starts at the beginning');

  session.restartForEqualizer([0, 3, 0, 0, 0, 0, 0, 0, 0, 0], 42);

  const args = session.args.buildInputArgs();
  const idx = args.indexOf('-ss');
  assert.notEqual(idx, -1, 'the respawn must resume, not replay the track');
  assert.equal(args[idx + 1], '42');
});

test('an equalizer restart without a position leaves the command line alone', () => {
  const session = fileSession();
  session.restartForEqualizer([0, 3, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.ok(!session.args.buildInputArgs().includes('-ss'));
});

test('a live pipe cannot be positioned, so its restart carries no seek', () => {
  const session = new AudioSession(
    zoneSessionKey(1),
    { kind: 'pipe', path: 'spotify-pipe', format: 's16le', sampleRate: 44100, channels: 2 },
    'pcm',
    () => {},
    OUTPUT,
    null,
    false,
  );
  session.restartForEqualizer(null, 30);
  assert.ok(!session.args.buildInputArgs().includes('-ss'));
});

test('the new bands and the resume position reach the same command line', () => {
  const session = fileSession();
  session.restartForEqualizer([6, 0, 0, 0, 0, 0, 0, 0, 0, 0], 90);
  const args = [...session.args.buildInputArgs(), ...session.args.buildOutputArgs(session.equalizerBands)];
  assert.ok(args.includes('90'));
  assert.ok(args.some((arg) => arg.includes('equalizer=f=31')), args.join(' '));
});
