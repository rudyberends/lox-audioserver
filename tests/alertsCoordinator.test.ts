import assert from 'node:assert/strict';
import { test } from './testHarness';
import { AlertsCoordinator } from '../src/application/zones/AlertsCoordinator';
import { ZoneRepository } from '../src/application/zones/ZoneRepository';
import { buildInitialState } from '../src/application/zones/helpers/stateHelpers';
import type { ZoneContext } from '../src/application/zones/internal/zoneTypes';
import type { ZoneConfig } from '../src/domain/config/types';

test('startAlert patches alert volume into zone state before play patch', async () => {
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
      },
      playUri: () => ({}) as any,
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
    audioManager: {
      setTransientGainDb: () => {},
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
});
