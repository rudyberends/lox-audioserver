import assert from 'node:assert/strict';
import { test } from './testHarness';
import { inferAudiotype } from '../src/domain/loxone/audiopath';
import { AudioType } from '../src/domain/zones/enums';

test('inferAudiotype: library audiopath is File (0)', () => {
  // Regression: this previously returned 1 (Radio), causing local tracks to be
  // classified as radio when the queue rebuild fell back to createQueueItem
  // (e.g. when the local provider couldn't resolve metadata for the URI).
  assert.equal(inferAudiotype('library://local/queen/song.mp3'), AudioType.File);
  assert.equal(inferAudiotype('library:local:track:b64_abc'), AudioType.File);
});

test('inferAudiotype: tunein/radio audiopath is Radio (1)', () => {
  // Regression: this previously returned 4 (AirPlay).
  assert.equal(inferAudiotype('tunein:station:abc'), AudioType.Radio);
  assert.equal(inferAudiotype('radio://service/x'), AudioType.Radio);
  assert.equal(inferAudiotype('radioparadise://main'), AudioType.Radio);
});

test('inferAudiotype: spotify/MA/applemusic/deezer/tidal audiopaths are Spotify (5)', () => {
  assert.equal(inferAudiotype('spotify:track:xyz'), AudioType.Spotify);
  assert.equal(inferAudiotype('spotify@user:track:xyz'), AudioType.Spotify);
  assert.equal(inferAudiotype('musicassistant@bridge:track:1'), AudioType.Spotify);
  assert.equal(inferAudiotype('applemusic://album/1'), AudioType.Spotify);
});

test('inferAudiotype: linein audiopath is LineIn (3)', () => {
  assert.equal(inferAudiotype('linein:input-1'), AudioType.LineIn);
  assert.equal(inferAudiotype('linein://input-1'), AudioType.LineIn);
});

test('inferAudiotype: http/https/file audiopaths default to File (0)', () => {
  // Plain HTTP streams without tunein markers are not classified as radio here;
  // the radio classification is the caller's responsibility via the more
  // specific detectServiceFromAudiopath / isRadioAudiopath helpers.
  assert.equal(inferAudiotype('http://example.com/stream.mp3'), AudioType.File);
  assert.equal(inferAudiotype('https://example.com/stream.mp3'), AudioType.File);
  assert.equal(inferAudiotype('file:///tmp/song.mp3'), AudioType.File);
});

test('inferAudiotype: unknown audiopath defaults to File (0)', () => {
  assert.equal(inferAudiotype(''), AudioType.File);
  assert.equal(inferAudiotype('something-unknown'), AudioType.File);
});
