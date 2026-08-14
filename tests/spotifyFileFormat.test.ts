import assert from 'node:assert/strict';
import { test } from './testHarness';
import { describeSpotifyFile } from '../src/adapters/inputs/spotify/spotifyInputService';

/**
 * `resolveAudioFile` names the file Spotify served, and until now that name was read once to pick
 * a demuxer and dropped. It is the only per-track statement about quality this server ever gets —
 * Soloist does its own resolving and says nothing — so it is worth reading properly.
 */

test('a FLAC file is reported as lossless', () => {
  assert.deepEqual(describeSpotifyFile('FLAC_FLAC'), {
    sampleRate: 44100,
    channels: 2,
    lossless: true,
    codecName: 'flac',
  });
});

test('the vorbis tiers are lossy, whatever their bitrate', () => {
  for (const format of ['OGG_VORBIS_96', 'OGG_VORBIS_160', 'OGG_VORBIS_320']) {
    const described = describeSpotifyFile(format);
    assert.equal(described.lossless, false, format);
    assert.equal(described.codecName, 'vorbis', format);
  }
});

test('the aac tiers are recognised rather than left nameless', () => {
  for (const format of ['AAC_160', 'AAC_320', 'MP4_128']) {
    assert.equal(describeSpotifyFile(format).codecName, 'aac', format);
  }
});

test('an unfamiliar name is still described as far as it can be', () => {
  // A tier we have not seen must not be claimed lossless, and naming no codec is better than
  // naming the wrong one — the rate and channels hold for everything Spotify serves.
  const described = describeSpotifyFile('OTHER5');
  assert.equal(described.lossless, false);
  assert.equal(described.codecName, undefined);
  assert.equal(described.sampleRate, 44100);
});
