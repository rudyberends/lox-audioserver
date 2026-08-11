import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  chooseStreamProfile,
  parseStreamFormatPreference,
  streamProfileContentType,
  streamProfileNeedsChunked,
} from '../src/domain/outputs/streamProfilePolicy';
import { MusicAssistantOutput } from '../src/adapters/outputs/musicassistant/musicAssistantOutput';
import { DlnaOutput } from '../src/adapters/outputs/dlna/dlnaOutput';
import { SonosOutput } from '../src/adapters/outputs/sonos/sonosOutput';
import type { ConfigPort } from '../src/ports/ConfigPort';
import { makeOutputPortsFake } from './fakes/outputPorts';

test('an unknown endpoint gets MP3, because silence is worse than a re-encode', () => {
  assert.equal(chooseStreamProfile({ preference: 'auto', losslessSupported: null }), 'mp3');
  assert.equal(chooseStreamProfile({ preference: 'auto', losslessSupported: false }), 'mp3');
  assert.equal(chooseStreamProfile({ preference: 'auto', losslessSupported: true }), 'flac');
});

test('an explicit preference wins over detection, and evidence wins over both', () => {
  assert.equal(chooseStreamProfile({ preference: 'lossless', losslessSupported: null }), 'flac');
  assert.equal(chooseStreamProfile({ preference: 'lossy', losslessSupported: true }), 'mp3');
  assert.equal(
    chooseStreamProfile({ preference: 'lossless', losslessSupported: true, losslessFailed: true }),
    'mp3',
    'a device that has actually refused lossless outranks the configuration',
  );
});

test('the preference parser treats anything unrecognised as auto', () => {
  assert.equal(parseStreamFormatPreference('lossless'), 'lossless');
  assert.equal(parseStreamFormatPreference('FLAC'), 'lossless');
  assert.equal(parseStreamFormatPreference(' mp3 '), 'lossy');
  assert.equal(parseStreamFormatPreference('lossy'), 'lossy');
  assert.equal(parseStreamFormatPreference('auto'), 'auto');
  assert.equal(parseStreamFormatPreference('losless'), 'auto', 'a typo must not pin a format');
  assert.equal(parseStreamFormatPreference(undefined), 'auto');
  assert.equal(parseStreamFormatPreference(42), 'auto');
});

test('lossless implies chunked transfer and its own MIME type', () => {
  // A forced Content-Length for a variable-bitrate codec is a guess, and a body that ends short of the
  // advertised length is what clipped the tail off Cast playback.
  assert.equal(streamProfileNeedsChunked('flac'), true);
  assert.equal(streamProfileNeedsChunked('mp3'), false);
  assert.equal(streamProfileContentType('flac'), 'audio/flac');
  assert.equal(streamProfileContentType('mp3'), 'audio/mpeg');
});

const configPortStub = {
  getSystemConfig: () => ({ audioserver: { ip: '127.0.0.1' } }),
  getConfig: () => ({ system: { audioserver: { ip: '127.0.0.1' } }, zones: [] }),
  getZones: () => [],
} as unknown as ConfigPort;
const outputPortsStub = makeOutputPortsFake(configPortStub);

test('Music Assistant is fed lossless, because its fetcher is ffmpeg', () => {
  // MA re-encodes for whatever it drives, so an MP3 hand-off capped that whole chain at 256 kbit.
  const output = new MusicAssistantOutput(1, 'Zone', { bridgeId: 'b', playerId: 'p' }, configPortStub);
  assert.equal(output.getPreferredOutput().profile, 'flac');
  const lossy = new MusicAssistantOutput(
    1, 'Zone', { bridgeId: 'b', playerId: 'p', streamFormat: 'mp3' }, configPortStub,
  );
  assert.equal(lossy.getPreferredOutput().profile, 'mp3', 'a slow link can still opt out');
});

test('a DLNA renderer stays on MP3 until its owner says otherwise', () => {
  // We cannot yet ask a renderer what it accepts (that belongs in the UPnP module), and a renderer that
  // cannot decode the stream plays silence with nothing to see in the UI.
  const auto = new DlnaOutput(1, 'Zone', { host: '192.168.1.50' }, outputPortsStub);
  assert.equal(auto.getPreferredOutput().profile, 'mp3');
  assert.equal(auto.getHttpPreferences().httpProfile, 'forced_content_length');

  const lossless = new DlnaOutput(
    1, 'Zone', { host: '192.168.1.50', streamFormat: 'lossless' }, outputPortsStub,
  );
  assert.equal(lossless.getPreferredOutput().profile, 'flac');
  assert.equal(
    lossless.getHttpPreferences().httpProfile,
    'chunked',
    'lossless cannot advertise a length it does not know',
  );
});

test('Sonos gets the same escape hatch', () => {
  const auto = new SonosOutput(1, 'Zone', { host: '192.168.1.60' }, outputPortsStub);
  assert.equal(auto.getPreferredOutput().profile, 'mp3');
  const lossless = new SonosOutput(
    1, 'Zone', { host: '192.168.1.60', streamFormat: 'lossless' }, outputPortsStub,
  );
  assert.equal(lossless.getPreferredOutput().profile, 'flac');
  assert.equal(lossless.getHttpPreferences().httpProfile, 'chunked');
});
