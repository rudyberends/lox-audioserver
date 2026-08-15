import assert from 'node:assert/strict';
import { test } from './testHarness';
import { ZoneRepository } from '../src/application/zones/ZoneRepository';
import { QueueController } from '../src/application/zones/QueueController';
import { PlaybackQueueNavigator } from '../src/application/playback/PlaybackQueueNavigator';
import { buildBridgeRegistry } from '../src/domain/zones/bridgeIdentity';
import type { StreamingServiceConfig } from '../src/domain/config/types';
import type { QueueState, ZoneContext } from '../src/application/zones/internal/zoneTypes';

const BRIDGES: StreamingServiceConfig[] = [
  { id: 'bridge-applemusic-p0gngd', label: 'Apple Music', provider: 'applemusic' },
];

/**
 * A queue edit arrives from the Loxone client in the same disguised shape as a play request.
 * `playContent` has translated that to the core's service-native identity for a while; these
 * two entry points had not, so which spelling the queue held depended on how the item got in.
 */
function makeController(): { qc: QueueController; seen: string[]; zoneId: number } {
  const seen: string[] = [];
  const zones = new ZoneRepository();
  const qc = new QueueController(zones, {
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, spam: () => {} } as never,
    contentPort: { getBridgeRegistry: () => buildBridgeRegistry(BRIDGES) } as never,
    applyPatch: () => {},
    isRadioAudiopath: () => false,
    isSpotifyAudiopath: () => false,
    isMusicAssistantAudiopath: () => false,
    providerForAudiopath: () => 'applemusic',
    resolveBridgeProvider: () => null,
    getMusicAssistantUserId: () => 'musicassistant',
    getStateAudiotype: () => null,
    getStateFileType: () => 0,
    resolveSourceName: () => undefined,
    notifier: { notifyQueueUpdated: () => {}, notifyZoneStateChanged: () => {} } as never,
  } as never);
  const queue: QueueState = {
    items: [],
    shuffle: false,
    repeat: 0,
    currentIndex: 0,
    authority: 'local',
  };
  // Record the path the queue builder is handed — that is what this test is about.
  (qc as unknown as { buildQueueForUri: (uri: string) => Promise<unknown[]> }).buildQueueForUri =
    async (uri: string) => {
      seen.push(uri);
      return [];
    };
  const zoneId = 1;
  zones.set(zoneId, {
    id: zoneId,
    name: 'Zone 1',
    queue,
    queueController: new PlaybackQueueNavigator(queue),
    metadata: {} as Record<string, unknown>,
  } as unknown as ZoneContext);
  return { qc, seen, zoneId };
}

test('queueadd translates the Loxone disguise to the core identity', async () => {
  const { qc, seen, zoneId } = makeController();
  await qc.appendUri(zoneId, 'spotify@bridge-applemusic-p0gngd:track:b64_X');
  assert.deepEqual(seen, ['applemusic:track:b64_X']);
});

test('queueinsert translates it too', async () => {
  const { qc, seen, zoneId } = makeController();
  await qc.insertUriAfterCurrent(zoneId, 'spotify@bridge-applemusic-p0gngd:album:b64_X');
  assert.deepEqual(seen, ['applemusic:album:b64_X']);
});

test('a path that is already service-native is left alone', async () => {
  const { qc, seen, zoneId } = makeController();
  await qc.appendUri(zoneId, 'applemusic:track:b64_X');
  assert.deepEqual(seen, ['applemusic:track:b64_X']);
});

test('a real Spotify account keeps its own identity', async () => {
  const { qc, seen, zoneId } = makeController();
  // `spotify@<account>` is not a bridge; there is nothing to undisguise.
  await qc.appendUri(zoneId, 'spotify@md123121:track:abc');
  assert.deepEqual(seen, ['spotify@md123121:track:abc']);
});
