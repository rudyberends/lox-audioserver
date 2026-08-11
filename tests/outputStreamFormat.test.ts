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
import { parseSinkContentTypes } from '@sonn-audio/node-upnp';

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

test('a DLNA renderer stays on MP3 while its capability is unknown', () => {
  // The probe is asynchronous and getPreferredOutput is not, so a renderer we have not heard back from
  // yet keeps MP3: a renderer that cannot decode the stream plays silence with nothing to see in the UI.
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

test('a renderer sink list is read per MIME field, not by substring', () => {
  // Real answer shapes: B&O-style lists mix protocols and carry LPCM parameters. The format is the
  // third colon-separated field of each entry, so `audio/flac` must be that field and not merely
  // appear somewhere in the string.
  const sink =
    '<Sink>http-get:*:audio/mpeg:DLNA.ORG_PN=MP3,http-get:*:audio/flac:*,' +
    'http-get:*:audio/L16;rate=44100;channels=2:DLNA.ORG_PN=LPCM,rtsp-rtp-udp:*:audio/x-pn-wav:*</Sink>';
  assert.deepEqual(parseSinkContentTypes(sink), [
    'audio/mpeg',
    'audio/flac',
    'audio/l16;rate=44100;channels=2',
    'audio/x-pn-wav',
  ]);
  assert.deepEqual(parseSinkContentTypes('<Sink>http-get:*:audio/mpeg:DLNA.ORG_PN=MP3</Sink>'), [
    'audio/mpeg',
  ]);
  // "It told us nothing" must not read as "it accepts nothing".
  assert.equal(parseSinkContentTypes('<Sink></Sink>'), null);
  assert.equal(parseSinkContentTypes('<s:Fault><faultcode>s:Client</faultcode></s:Fault>'), null);
});

test('a renderer that advertises FLAC gets FLAC without anyone configuring it', async () => {
  // The capability answer is what makes `auto` safe, so this exercises the wiring rather than the
  // policy: stub the renderer's reply, then let the output ask.
  const output = new DlnaOutput(1, 'Zone', { host: '192.168.1.50' }, outputPortsStub);
  const internals = output as unknown as {
    cp: { getSinkContentTypes: () => Promise<string[] | null> };
    losslessSupported?: boolean | null;
    capabilityProbe?: Promise<void>;
    probeCapabilities: () => void;
  };
  internals.cp.getSinkContentTypes = async () => ['audio/mpeg', 'audio/flac'];
  internals.losslessSupported = undefined;
  internals.capabilityProbe = undefined;
  internals.probeCapabilities();
  await internals.capabilityProbe;

  assert.equal(output.getPreferredOutput().profile, 'flac');
  assert.equal(output.getHttpPreferences().httpProfile, 'chunked');
});

test('a renderer that only lists MP3 keeps MP3', async () => {
  const output = new DlnaOutput(1, 'Zone', { host: '192.168.1.51' }, outputPortsStub);
  const internals = output as unknown as {
    cp: { getSinkContentTypes: () => Promise<string[] | null> };
    losslessSupported?: boolean | null;
    capabilityProbe?: Promise<void>;
    probeCapabilities: () => void;
  };
  internals.cp.getSinkContentTypes = async () => ['audio/mpeg', 'audio/l16;rate=44100;channels=2'];
  internals.losslessSupported = undefined;
  internals.capabilityProbe = undefined;
  internals.probeCapabilities();
  await internals.capabilityProbe;

  assert.equal(output.getPreferredOutput().profile, 'mp3', 'LPCM is lossless but not what we send');
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
