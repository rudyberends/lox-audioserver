import assert from 'node:assert/strict';
import { test } from './testHarness';
import { ZoneRepository } from '../src/application/zones/ZoneRepository';
import { QueueController } from '../src/application/zones/QueueController';

test('isLocalQueueAuthority treats provider authorities as local', () => {
  const zones = new ZoneRepository();
  const qc = new QueueController(zones, {
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, spam: () => {} } as any,
    contentPort: {} as any,
    applyPatch: () => {},
    isRadioAudiopath: () => false,
    isSpotifyAudiopath: () => false,
    isMusicAssistantAudiopath: () => false,
    isAppleMusicAudiopath: () => false,
    isDeezerAudiopath: () => false,
    isTidalAudiopath: () => false,
    isYtMusicAudiopath: () => false,
    resolveBridgeProvider: () => null,
    getMusicAssistantUserId: () => 'musicassistant',
    getStateAudiotype: () => null,
    getStateFileType: () => 0,
    resolveSourceName: () => undefined,
    notifier: { notifyQueueUpdated: () => {}, notifyZoneStateChanged: () => {} } as any,
  });

  assert.equal(qc.isLocalQueueAuthority(null), true);
  assert.equal(qc.isLocalQueueAuthority('local'), true);
  assert.equal(qc.isLocalQueueAuthority('applemusic'), true);
  assert.equal(qc.isLocalQueueAuthority('deezer'), true);
  assert.equal(qc.isLocalQueueAuthority('tidal'), true);
  assert.equal(qc.isLocalQueueAuthority('ytmusic'), true);

  assert.equal(qc.isLocalQueueAuthority('spotify'), false);
  assert.equal(qc.isLocalQueueAuthority('musicassistant'), false);
  assert.equal(qc.isLocalQueueAuthority('airplay'), false);
  assert.equal(qc.isLocalQueueAuthority('external:foo'), false);
});
