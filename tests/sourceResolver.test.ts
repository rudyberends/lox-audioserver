import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from './testHarness';
import { resolvePlaybackSource } from '../src/application/playback/sourceResolver';

test('source resolver parses alert pre-delay query for alerts files', () => {
  const source = resolvePlaybackSource('alerts://cache/tts-demo.mp3?predelay=125');
  assert.ok(source);
  assert.equal(source?.kind, 'file');
  if (!source || source.kind !== 'file') {
    return;
  }
  assert.equal(source.preDelayMs, 125);
  assert.equal(source.path, path.resolve(process.cwd(), 'public', 'alerts', 'cache', 'tts-demo.mp3'));
});

test('source resolver clamps alert pre-delay query to zero for invalid values', () => {
  const source = resolvePlaybackSource('alerts://cache/tts-demo.mp3?predelay=not-a-number');
  assert.ok(source);
  assert.equal(source?.kind, 'file');
  if (!source || source.kind !== 'file') {
    return;
  }
  assert.equal(source.preDelayMs, 0);
});

test('source resolver applies pre-delay for looping alert sources', () => {
  const source = resolvePlaybackSource('alerts-loop://cache/alarm.mp3?predelay=500');
  assert.ok(source);
  assert.equal(source?.kind, 'file');
  if (!source || source.kind !== 'file') {
    return;
  }
  assert.equal(source.loop, true);
  assert.equal(source.preDelayMs, 500);
});
