import assert from 'node:assert/strict';
import { test } from './testHarness';
import { AudioStreamHandler } from '../src/adapters/http/streams/audioStreamHandler';

function createHandler(): AudioStreamHandler {
  return new AudioStreamHandler({} as any, {} as any, {} as any, {} as any);
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


// Issue #348: the block we broadcast used to have every apostrophe stripped out of it, so
// a renderer reading our stream showed "Dont Go". A reader ends the value at `';`, which a
// lone apostrophe never forms.
function icyTitleOf(metadata: { title?: string; artist?: string }): string {
  const handler = createHandler();
  const block = (handler as any).buildIcyBlock({ metadata } as any) as Buffer;
  const text = block.subarray(1).toString('utf8').replace(/\0+$/, '');
  const match = /StreamTitle='([\s\S]*)';$/.exec(text);
  assert.ok(match, `unparseable icy block: ${JSON.stringify(text)}`);
  return match[1] ?? '';
}

test('audio stream handler keeps apostrophes in the broadcast ICY title', () => {
  assert.equal(icyTitleOf({ artist: 'Yazoo', title: "Don't Go" }), "Yazoo - Don't Go");
});

test('audio stream handler drops only a terminator sequence from the ICY title', () => {
  assert.equal(icyTitleOf({ artist: 'A', title: "Rock'; Roll" }), "A - Rock' Roll");
});
