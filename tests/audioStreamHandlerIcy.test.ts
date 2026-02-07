import assert from 'node:assert/strict';
import { test } from './testHarness';
import { AudioStreamHandler } from '../src/adapters/http/streams/audioStreamHandler';

function createHandler(): AudioStreamHandler {
  return new AudioStreamHandler({} as any, {} as any, {} as any);
}

test('audio stream handler enables ICY when Icy-MetaData header is set', () => {
  const handler = createHandler();
  const req = {
    url: '/streams/1/current.mp3',
    headers: { 'icy-metadata': '1' },
  } as any;
  assert.equal((handler as any).shouldUseIcy(req, true), true);
});

test('audio stream handler enables ICY when forced via query parameter', () => {
  const handler = createHandler();
  const req = {
    url: '/streams/1/current.mp3?icy=1',
    headers: {},
  } as any;
  assert.equal((handler as any).shouldUseIcy(req, true), true);
});

test('audio stream handler does not enable ICY when output prefs disable it', () => {
  const handler = createHandler();
  const req = {
    url: '/streams/1/current.mp3?icy=1',
    headers: { 'icy-metadata': '1' },
  } as any;
  assert.equal((handler as any).shouldUseIcy(req, false), false);
});

