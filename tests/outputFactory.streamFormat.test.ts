import assert from 'node:assert/strict';
import { test } from './testHarness';
import { buildZoneOutputs } from '../src/adapters/outputs/factory';
import type { ConfigPort } from '../src/ports/ConfigPort';
import type { ZoneConfig } from '../src/domain/config/types';
import type { OutputProfile } from '../src/ports/EngineTypes';
import { makeOutputPortsFake } from './fakes/outputPorts';

/**
 * A configured sound quality has to survive the factory. Every output here is handed a narrow,
 * explicitly-built config rather than the raw entry, so a field that nobody forwards by name is
 * read as `undefined`, resolves to `auto`, and the setting does nothing at all — silently.
 */

const configPort = {
  getSystemConfig: () => ({ audioserver: { ip: '127.0.0.1' } }),
  getConfig: () => ({ system: { audioserver: { ip: '127.0.0.1' } }, zones: [] }),
  getZones: () => [],
} as unknown as ConfigPort;
const ports = makeOutputPortsFake(configPort);

const zoneWith = (output: Record<string, unknown>): ZoneConfig =>
  ({
    id: 1,
    name: 'Zone',
    sourceMac: '00:11:22:33:44:55',
    volumes: { max: 100, default: 20, step: 1 },
    output,
    transports: [output],
  }) as unknown as ZoneConfig;

const profileOf = (output: Record<string, unknown>): OutputProfile | undefined => {
  const built = buildZoneOutputs(zoneWith(output), ports);
  assert.equal(built.length, 1, `expected one output for ${String(output.id)}`);
  return built[0]?.getPreferredOutput?.()?.profile;
};

test('a DLNA renderer pinned to MP3 stays on MP3, and lossless reaches the output', () => {
  assert.equal(profileOf({ id: 'dlna', host: '192.168.1.50', streamFormat: 'lossless' }), 'flac');
  assert.equal(profileOf({ id: 'dlna', host: '192.168.1.50', streamFormat: 'mp3' }), 'mp3');
  // No preference is not the same as an empty one: both mean "ask the renderer", which is MP3
  // until an answer is in.
  assert.equal(profileOf({ id: 'dlna', host: '192.168.1.50' }), 'mp3');
  assert.equal(profileOf({ id: 'dlna', host: '192.168.1.50', streamFormat: '   ' }), 'mp3');
});

test('Sonos, Music Assistant and Cast honour a pinned quality too', () => {
  // These default to lossless (MA) or negotiate (Sonos/Cast), so `mp3` is the telling direction:
  // it can only come from the configured value having arrived.
  assert.equal(profileOf({ id: 'sonos', host: '192.168.1.60', streamFormat: 'mp3' }), 'mp3');
  assert.equal(profileOf({ id: 'sonos', host: '192.168.1.60', streamFormat: 'lossless' }), 'flac');
  assert.equal(
    profileOf({ id: 'musicassistant', bridgeId: 'b', playerId: 'p', streamFormat: 'mp3' }),
    'mp3',
  );
  assert.equal(
    profileOf({ id: 'musicassistant', bridgeId: 'b', playerId: 'p' }),
    'flac',
    'MA re-encodes for whatever it drives, so it stays lossless by default',
  );
  assert.equal(profileOf({ id: 'googlecast', host: '192.168.1.70', streamFormat: 'mp3' }), 'mp3');
});
