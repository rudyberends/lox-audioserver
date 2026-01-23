import assert from 'node:assert/strict';
import { test } from './testHarness';
import { parseParentContext } from '../src/application/zones/policies/ParentContextPolicy';
import { classifyIsRadio } from '../src/application/zones/policies/RadioClassificationPolicy';
import { buildQueueForRequest } from '../src/application/zones/queue/QueueBuilder';
import { buildPlaybackPlan } from '../src/application/playback/buildPlaybackPlan';
import type { PlaybackMetadata } from '../src/application/playback/audioManager';
import type { ContentPort } from '../src/ports/ContentPort';
import type { ZoneAudioHelpers } from '../src/application/zones/internal/zoneAudioHelpers';
import type { QueueController as ZoneQueueController } from '../src/application/zones/QueueController';
import type { QueueItem } from '../src/ports/types/queueTypes';
import type { ZoneContext } from '../src/application/zones/internal/zoneTypes';
import type { PreferredPlaybackSettings } from '../src/application/playback/policies/OutputFormatPolicy';

function makeQueueItem(overrides: Partial<QueueItem>): QueueItem {
  return {
    album: '',
    artist: '',
    audiopath: '',
    audiotype: 0,
    coverurl: '',
    duration: 0,
    qindex: 0,
    station: '',
    title: '',
    unique_id: 'queue-item',
    user: 'nouser',
    ...overrides,
  };
}

const noopContentPort: ContentPort = {
  getDefaultSpotifyAccountId: () => null,
  resolveMetadata: async () => null,
  resolvePlaybackSource: async () => ({ playbackSource: null, provider: 'library' }),
  configureAppleMusic: () => {},
  configureDeezer: () => {},
  configureTidal: () => {},
  isAppleMusicProvider: () => false,
  isDeezerProvider: () => false,
  isTidalProvider: () => false,
  getMediaFolder: async () => null,
  getServiceTrack: async () => null,
  getServiceFolder: async () => null,
  buildQueueForUri: async () => [],
};

const noopAudioHelpers = {
  toRadioAudiopath: (audiopath: string | undefined) => audiopath ?? '',
} as ZoneAudioHelpers;

test('parseParentContext returns null without parentpath', () => {
  const result = parseParentContext('spotify:track:abc');
  assert.equal(result, null);
});

test('parseParentContext extracts parent, startItem, startIndex', () => {
  const raw = 'spotify:track:abc/parentpath/spotify:playlist:xyz/12/noshuffle';
  const result = parseParentContext(raw);
  assert.ok(result);
  assert.equal(result.parent, 'spotify:playlist:xyz');
  assert.equal(result.startItem, 'spotify:track:abc');
  assert.equal(result.startIndex, 12);
});

test('classifyIsRadio treats http streams without duration as radio', () => {
  const metadata: PlaybackMetadata = { title: 't', artist: 'a', album: 'b' };
  const isRadio = classifyIsRadio({
    uri: 'http://example.com/stream',
    resolvedTarget: 'http://example.com/stream',
    metadata,
  });
  assert.equal(isRadio, true);
});

test('classifyIsRadio ignores http streams with duration', () => {
  const metadata: PlaybackMetadata = { title: 't', artist: 'a', album: 'b', duration: 120 };
  const isRadio = classifyIsRadio({
    uri: 'http://example.com/stream',
    resolvedTarget: 'http://example.com/stream',
    metadata,
  });
  assert.equal(isRadio, false);
});

test('buildQueueForRequest selects startIndex by startItemHint', async () => {
  const queueController = {
    buildQueueForUri: async () => [
      makeQueueItem({ audiopath: 'spotify:track:one', unique_id: 'id-1' }),
      makeQueueItem({ audiopath: 'spotify:track:two', unique_id: 'id-2' }),
    ],
  } as unknown as ZoneQueueController;

  const result = await buildQueueForRequest({
    request: {
      zoneId: 1,
      zoneName: 'Zone',
      uri: 'spotify:track:two',
      resolvedTarget: 'spotify:track:two',
      queueSourcePath: 'spotify:track:two',
      queueAudiopath: 'spotify:track:two',
      parentContext: null,
      isRadio: false,
      isAppleMusic: false,
      isMusicAssistant: false,
      startIndexHint: 0,
      startItemHint: 'spotify:track:two',
    },
    queueController,
    content: noopContentPort,
    audioHelpers: noopAudioHelpers,
  });

  assert.equal(result.startIndex, 1);
});

test('buildQueueForRequest clamps startIndex when no match', async () => {
  const queueController = {
    buildQueueForUri: async () => [
      makeQueueItem({ audiopath: 'spotify:track:one', unique_id: 'id-1' }),
      makeQueueItem({ audiopath: 'spotify:track:two', unique_id: 'id-2' }),
    ],
  } as unknown as ZoneQueueController;

  const result = await buildQueueForRequest({
    request: {
      zoneId: 1,
      zoneName: 'Zone',
      uri: 'spotify:track:two',
      resolvedTarget: 'spotify:track:two',
      queueSourcePath: 'spotify:track:two',
      queueAudiopath: 'spotify:track:two',
      parentContext: null,
      isRadio: false,
      isAppleMusic: false,
      isMusicAssistant: false,
      startIndexHint: 99,
      startItemHint: 'spotify:track:missing',
    },
    queueController,
    content: noopContentPort,
    audioHelpers: noopAudioHelpers,
  });

  assert.equal(result.startIndex, 1);
});

test('buildPlaybackPlan classifies spotify/musicassistant/provider/playUri', () => {
  const ctx = { id: 1, name: 'Zone' } as ZoneContext;
  const settings: PreferredPlaybackSettings = { outputOverride: null };
  const metadata: PlaybackMetadata = { title: 't', artist: 'a', album: 'b' };

  const spotify = buildPlaybackPlan({
    ctx,
    audiopath: 'spotify:track:abc',
    metadata,
    isRadio: false,
    preferredSettings: settings,
  });
  assert.equal(spotify.playExternalLabel, 'spotify');
  assert.equal(spotify.needsStreamResolution, true);
  assert.equal(spotify.kind, 'queue');
  assert.equal(spotify.provider, null);

  const musicAssistant = buildPlaybackPlan({
    ctx,
    audiopath: 'musicassistant://provider/track/abc',
    metadata,
    isRadio: false,
    preferredSettings: settings,
  });
  assert.equal(musicAssistant.playExternalLabel, 'musicassistant');
  assert.equal(musicAssistant.needsStreamResolution, true);
  assert.equal(musicAssistant.kind, 'queue');
  assert.equal(musicAssistant.provider, null);
  assert.equal((musicAssistant.metadata as any).audiotype, 5);

  const provider = buildPlaybackPlan({
    ctx,
    audiopath: 'applemusic:track:abc',
    metadata,
    isRadio: false,
    preferredSettings: settings,
  });
  assert.equal(provider.playExternalLabel, 'applemusic');
  assert.equal(provider.needsStreamResolution, true);
  assert.equal(provider.kind, 'provider-stream');
  assert.equal(provider.provider, 'applemusic');
  assert.equal((provider.metadata as any).audiotype, 5);

  const local = buildPlaybackPlan({
    ctx,
    audiopath: 'library://albums/test.mp3',
    metadata,
    isRadio: false,
    preferredSettings: settings,
  });
  assert.equal(local.playExternalLabel, null);
  assert.equal(local.needsStreamResolution, false);
  assert.equal(local.kind, 'queue');
  assert.equal(local.provider, null);
});
