import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from './testHarness';
import { resolvePlaybackSource } from '../src/application/playback/sourceResolver';

test('source resolver ignores alert pre-delay query for alerts files', () => {
  const source = resolvePlaybackSource('alerts://cache/tts-demo.mp3?predelay=125');
  assert.ok(source);
  assert.equal(source?.kind, 'file');
  if (!source || source.kind !== 'file') {
    return;
  }
  assert.equal(source.preDelayMs, undefined);
  assert.equal(source.path, path.resolve(process.cwd(), 'public', 'alerts', 'cache', 'tts-demo.mp3'));
});

test('source resolver ignores invalid alert pre-delay query', () => {
  const source = resolvePlaybackSource('alerts://cache/tts-demo.mp3?predelay=not-a-number');
  assert.ok(source);
  assert.equal(source?.kind, 'file');
  if (!source || source.kind !== 'file') {
    return;
  }
  assert.equal(source.preDelayMs, undefined);
});

test('source resolver ignores pre-delay query for looping alert sources', () => {
  const source = resolvePlaybackSource('alerts-loop://cache/alarm.mp3?predelay=500');
  assert.ok(source);
  assert.equal(source?.kind, 'file');
  if (!source || source.kind !== 'file') {
    return;
  }
  assert.equal(source.loop, true);
  assert.equal(source.preDelayMs, undefined);
});

test('source resolver strips query string from alerts paths', () => {
  const source = resolvePlaybackSource('alerts://cache/tts-demo.mp3?padTailSec=6');
  assert.ok(source);
  assert.equal(source?.kind, 'file');
  if (!source || source.kind !== 'file') {
    return;
  }
  assert.equal(source.path, path.resolve(process.cwd(), 'public', 'alerts', 'cache', 'tts-demo.mp3'));
});
