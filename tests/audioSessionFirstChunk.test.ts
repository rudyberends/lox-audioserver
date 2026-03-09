import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from './testHarness';
import { AudioSession } from '../src/engine/audioSession';

test('pipe-backed ffmpeg session resolves first chunk readiness', async () => {
  const sourceStream = new PassThrough();
  const session = new AudioSession(
    1,
    {
      kind: 'pipe',
      path: 'spotify-pipe',
      format: 's16le',
      sampleRate: 44100,
      channels: 2,
      stream: sourceStream,
    },
    'flac',
    () => {},
    {
      sampleRate: 44100,
      channels: 2,
      pcmBitDepth: 16,
      mp3Bitrate: '160k',
      prebufferBytes: 262144,
    },
  );

  session.start();
  sourceStream.write(Buffer.alloc(44100 * 2 * 2 * 2, 0));

  const ready = await session.waitForFirstChunk(3000);
  session.stop(true);
  sourceStream.end();

  assert.equal(ready, true);
});
