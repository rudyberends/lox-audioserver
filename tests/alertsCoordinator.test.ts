import assert from 'node:assert/strict';
import { test } from './testHarness';
import { AlertsCoordinator } from '../src/application/zones/AlertsCoordinator';
import { ZoneRepository } from '../src/application/zones/ZoneRepository';
import { buildInitialState } from '../src/application/zones/helpers/stateHelpers';
import type { ZoneContext } from '../src/application/zones/internal/zoneTypes';
import type { ZoneConfig } from '../src/domain/config/types';

test('startAlert applies alert volume after switching to the alert source', async () => {
  const zone: ZoneConfig = {
    id: 1,
    name: 'Living',
    sourceMac: '00:00:00:00:00:01',
    volumes: {
      default: 20,
      alarm: 20,
      fire: 20,
      bell: 55,
      buzzer: 20,
      tts: 20,
      volstep: 1,
      fading: 0,
      maxVolume: 100,
    },
  };

  const zoneRepo = new ZoneRepository();
  const patches: Array<Record<string, unknown>> = [];
  const playerVolumes: number[] = [];
  const inputModes: Array<ZoneContext['inputMode']> = [];
  const callOrder: string[] = [];
  let playedMetadata: Record<string, unknown> | null = null;
  const ctx = {
    id: zone.id,
    name: zone.name,
    sourceMac: zone.sourceMac,
    config: zone,
    state: buildInitialState(zone),
    queue: {
      items: [],
      shuffle: false,
      repeat: 0,
      currentIndex: 0,
      authority: 'local',
    },
    queueController: {
      setItems: () => {},
      currentIndex: () => 0,
      current: () => null,
    },
    inputAdapter: {},
    spotifyAdapter: {},
    metadata: {},
    outputs: [],
    player: {
      setVolume: (level: number) => {
        playerVolumes.push(level);
        callOrder.push('setVolume');
      },
      playUri: (_uri: string, metadata: Record<string, unknown>) => {
        playedMetadata = metadata;
        callOrder.push('playUri');
        return {} as any;
      },
    },
    outputTimingActive: false,
    lastOutputTimingAt: 0,
    lastZoneBroadcastAt: 0,
    lastPositionUpdateAt: 0,
    lastPositionValue: 0,
    lastPlaybackErrorAt: 0,
    activeOutputTypes: new Set<string>(),
    activeOutput: 'sendspin-cast',
    activeInput: null,
    lastMetadataDispatchAt: 0,
    inputMode: 'queue',
  } as unknown as ZoneContext;
  zoneRepo.set(zone.id, ctx);

  const coordinator = new AlertsCoordinator({
    zones: zoneRepo,
    playbackCoordinator: {
      setInputMode: (_ctx: ZoneContext, mode: ZoneContext['inputMode']) => {
        inputModes.push(mode);
        _ctx.inputMode = mode;
      },
      alignOutputFormat: () => {},
    } as any,
    applyPatch: (zoneId, patch) => {
      assert.equal(zoneId, zone.id);
      patches.push(patch as Record<string, unknown>);
      ctx.state = { ...ctx.state, ...patch };
    },
    log: {
      warn: () => {},
      debug: () => {},
    } as any,
    audioHelpers: {
      resolveAlertEventType: () => 0,
    } as any,
    zoneAudioPrefs: {
      setTransientGainDb: () => {},
      setAlertPreDelayFloorMs: () => {},
    } as any,
  });

  await coordinator.startAlert(
    zone.id,
    'bell',
    {
      title: 'bell',
      url: 'alerts://bell.mp3',
      relativePath: 'bell.mp3',
      duration: 4,
    },
    55,
  );

  assert.deepEqual(inputModes, ['alert']);
  assert.deepEqual(playerVolumes, [55]);
  assert.equal(patches[0]?.volume, 55);
  assert.equal(ctx.state.volume, 55);
  assert.equal(patches[1]?.mode, 'play');
  // Volume must be applied only after the source has switched to the alert (issue #279),
  // otherwise the previous stream briefly plays at the announcement volume.
  assert.deepEqual(callOrder, ['playUri', 'setVolume']);
  // Alert metadata must be flagged so the Sonos output omits the DIDL duration and streams
  // the clip open-ended instead of self-truncating the tail (issues #262/#276/#279).
  assert.equal(playedMetadata?.isAlert, true);
});

test('alert restore settles to stop when playback cannot resume (releases power-group relay)', async () => {
  const zone: ZoneConfig = {
    id: 1,
    name: 'Living',
    sourceMac: '00:00:00:00:00:01',
    volumes: {
      default: 20,
      alarm: 20,
      fire: 20,
      bell: 55,
      buzzer: 20,
      tts: 20,
      volstep: 1,
      fading: 0,
      maxVolume: 100,
    },
  };

  const zoneRepo = new ZoneRepository();
  const patches: Array<Record<string, unknown>> = [];
  const current = {
    audiopath: 'http://radio.example/stream',
    title: 'Radio',
    artist: '',
    album: '',
    coverurl: '',
    duration: 0,
    station: 'Radio',
    unique_id: 'q1',
    audiotype: 1,
  };
  const ctx = {
    id: zone.id,
    name: zone.name,
    sourceMac: zone.sourceMac,
    config: zone,
    // Zone was playing (e.g. radio) before the alert, so the snapshot mode is 'play'.
    state: { ...buildInitialState(zone), mode: 'play' },
    queue: { items: [], shuffle: false, repeat: 0, currentIndex: 0, authority: 'local' },
    queueController: {
      setItems: () => {},
      currentIndex: () => 0,
      current: () => current,
    },
    inputAdapter: {},
    spotifyAdapter: {},
    metadata: {},
    outputs: [],
    player: {
      setVolume: () => {},
      playUri: () => ({}) as any,
      stop: () => {},
    },
    outputTimingActive: false,
    lastOutputTimingAt: 0,
    lastZoneBroadcastAt: 0,
    lastPositionUpdateAt: 0,
    lastPositionValue: 0,
    lastPlaybackErrorAt: 0,
    activeOutputTypes: new Set<string>(),
    activeOutput: 'squeezelite',
    activeInput: null,
    lastMetadataDispatchAt: 0,
    inputMode: 'queue',
  } as unknown as ZoneContext;
  zoneRepo.set(zone.id, ctx);

  const coordinator = new AlertsCoordinator({
    zones: zoneRepo,
    playbackCoordinator: {
      setInputMode: (_ctx: ZoneContext, mode: ZoneContext['inputMode']) => {
        _ctx.inputMode = mode;
      },
      alignOutputFormat: () => {},
      // Resume fails: no session is returned.
      startQueuePlayback: async () => null,
    } as any,
    applyPatch: (_zoneId, patch) => {
      patches.push(patch as Record<string, unknown>);
      ctx.state = { ...ctx.state, ...(patch as Record<string, unknown>) };
    },
    log: { warn: () => {}, debug: () => {} } as any,
    audioHelpers: {
      resolveAlertEventType: () => 0,
      isRadioAudiopath: () => true,
      getStateAudiotype: () => 1,
      resolveSourceName: () => 'Radio',
      getStateFileType: () => 0,
    } as any,
    zoneAudioPrefs: {
      setTransientGainDb: () => {},
      setAlertPreDelayFloorMs: () => {},
    } as any,
  });

  await coordinator.startAlert(
    zone.id,
    'bell',
    { title: 'bell', url: 'alerts://bell.mp3', relativePath: 'bell.mp3', duration: 4 },
    55,
  );
  await coordinator.stopAlert(zone.id);

  // The failed resume must not leave the zone in a phantom 'play' state.
  assert.equal(ctx.state.mode, 'stop');
  assert.equal(patches[patches.length - 1]?.mode, 'stop');
});
