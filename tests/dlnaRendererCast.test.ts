import assert from 'node:assert/strict';
import { test } from './testHarness';
import { DlnaRendererHandler } from '../src/adapters/inputs/dlna/dlnaRendererHandler';
import type { AirplayController } from '../src/ports/InputsPort';
import type { PlaybackSource } from '../src/ports/EngineTypes';

/*
 * A control point casts a URL at a zone, and the only thing that URL has to survive is the
 * trip to the decoder. Every other http(s) source in the app takes the local proxy on that
 * trip (`resolvePlaybackSource` does it for anything played by audiopath) — the server fetches,
 * ffmpeg only ever talks to 127.0.0.1. A cast URI used to be the one exception, handed to
 * ffmpeg raw, and that is what issue #336 was: a Plex hostname ffmpeg could not resolve, and a
 * SIGSEGV before it logged a line. So the assertion is on the *shape* of what reaches the
 * engine, not on playback: the target must travel as the proxy's payload.
 */

function captureSource(): { controller: AirplayController; started: () => PlaybackSource | null } {
  let source: PlaybackSource | null = null;
  const controller = {
    startPlayback: (_zoneId: number, _label: string, s: PlaybackSource) => {
      source = s;
    },
    updateMetadata: () => {},
    updateCover: () => {},
    updateVolume: () => {},
    updateTiming: () => {},
    pausePlayback: () => {},
    resumePlayback: () => {},
    stopPlayback: () => {},
  } as unknown as AirplayController;
  return { controller, started: () => source };
}

test('a cast http url reaches the engine through the local proxy, target intact', () => {
  const { controller, started } = captureSource();
  const handler = new DlnaRendererHandler(1, controller);
  const target =
    'https://192-168-178-181.abc.plex.direct:32400/library/parts/13018/file.opus?X-Plex-Token=tok';

  handler.onPlay(target);

  const source = started();
  assert.ok(source && source.kind === 'url');
  const url = new URL(source.url);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/streams/proxy');
  // Token and port survive the round trip — a truncated query means a 401 from Plex.
  assert.equal(url.searchParams.get('u'), target);
});

test('a cast uri the proxy cannot front is passed through untouched', () => {
  const { controller, started } = captureSource();
  const handler = new DlnaRendererHandler(1, controller);

  handler.onPlay('rtsp://192.168.1.5/stream');

  const rtspSource = started();
  assert.ok(rtspSource && rtspSource.kind === 'url');
  assert.equal(rtspSource.url, 'rtsp://192.168.1.5/stream');
});

test('a seek keeps the offset alongside the proxied url', () => {
  const { controller, started } = captureSource();
  const handler = new DlnaRendererHandler(1, controller);

  handler.onPlay('http://192.168.1.5:8200/MediaItems/12.mp3', 61);

  const source = started();
  assert.equal((source as { startAtSec?: number }).startAtSec, 61);
  assert.ok(source && source.kind === 'url');
  assert.equal(new URL(source.url).pathname, '/streams/proxy');
});
