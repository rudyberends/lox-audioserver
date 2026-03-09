import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from './testHarness';
import { buildStartedPatch } from '../src/application/zones/playback/patchBuilder';
import { ZoneRepository } from '../src/application/zones/ZoneRepository';
import { ZoneStateStore } from '../src/application/zones/ZoneStateStore';
import { attachPlayerListeners } from '../src/application/zones/playback/playerListeners';

test('buildStartedPatch does not keep a longer previous duration when new track is shorter', () => {
  const ctx: any = {
    id: 1,
    name: 'Zone',
    sourceMac: '00:00:00:00:00:00',
    config: {},
    state: {
      title: 'Old',
      artist: 'Old',
      album: 'Old',
      coverurl: '',
      audiopath: 'spotify:track:OLDTRACKOLDTRACKOLDTR',
      duration: 360,
      queueAuthority: 'spotify',
    },
    queue: { authority: 'spotify' },
    queueController: { current: () => null, currentIndex: () => 0 },
    metadata: {},
  };

  const session: any = {
    metadata: {
      title: 'New',
      artist: 'New',
      album: 'New',
      audiopath: 'spotify:track:NEWTRACKNEWTRACKNEWTR',
      duration: 120,
    },
  };

  const patch = buildStartedPatch({ ctx, session, audioHelpers: {} as any });
  assert.equal(patch.duration, 120);
});

test('buildStartedPatch sets audiotype/type for radioControllable sources even without active queue item', () => {
  const ctx: any = {
    id: 1,
    name: 'Zone',
    sourceMac: '00:00:00:00:00:00',
    config: {},
    state: { title: '', artist: '', album: '', coverurl: '', audiopath: 'tunein:station:x', duration: 0 },
    queue: { authority: 'local' },
    queueController: { current: () => null, currentIndex: () => 0 },
    metadata: { radioControllable: true },
  };
  const session: any = { metadata: { title: 'T', artist: 'A', album: 'B', duration: 123 } };
  const patch = buildStartedPatch({
    ctx,
    session,
    audioHelpers: { getStateFileType: () => 2 } as any,
  });
  assert.equal(patch.audiotype, 0);
  assert.equal(patch.type, 2);
  assert.equal(patch.duration, 123);
});

test('ZoneStateStore allows duration to decrease when track changes (title change) even without audiopath', () => {
  const zoneRepo = new ZoneRepository();
  const zoneId = 1;
  zoneRepo.set(zoneId, {
    id: zoneId,
    name: 'Zone',
    sourceMac: '00:00:00:00:00:00',
    config: {} as any,
    state: {
      playerid: zoneId,
      name: 'Zone',
      title: 'Old',
      artist: 'Old',
      album: 'Old',
      coverurl: '',
      audiopath: 'airplay-1',
      duration: 360,
      time: 0,
      qindex: 0,
      queueAuthority: 'airplay',
      plshuffle: 0,
      plrepeat: 0,
      volume: 50,
      mode: 'play',
      audiotype: 0,
      sourceName: 'Zone',
      station: '',
      parent: null,
      type: 3,
      clientState: 'on',
      power: 'on',
    },
    queue: { items: [], shuffle: false, repeat: 0, currentIndex: 0, authority: 'airplay' },
    queueController: {} as any,
    inputAdapter: {} as any,
    spotifyAdapter: {} as any,
    metadata: {},
    outputs: [],
    player: {} as any,
    outputTimingActive: false,
    lastOutputTimingAt: 0,
    lastZoneBroadcastAt: 0,
    lastPositionUpdateAt: 0,
    lastPositionValue: 0,
    lastPlaybackErrorAt: 0,
    activeOutputTypes: new Set(),
    activeOutput: null,
    activeInput: null,
    lastMetadataDispatchAt: 0,
    inputMode: null,
  } as any);

  const store = new ZoneStateStore(zoneRepo, {
    isRadioAudiopath: () => false,
    isLineInAudiopath: () => false,
    syncGroupMembersPatch: () => {},
    notifyOutputMetadata: () => {},
    notifier: {
      notifyZoneStateChanged: () => {},
      notifyQueueUpdated: () => {},
      notifyRoomFavoritesChanged: () => {},
      notifyRecentlyPlayedChanged: () => {},
      notifyRescan: () => {},
      notifyReloadMusicApp: () => {},
      notifyAudioSyncEvent: () => {},
    },
    audioManager: {
      getSession: () => null,
      updateSessionTiming: () => {},
      updateSessionMetadata: () => {},
    } as any,
  });

  store.patch(zoneId, { title: 'New', duration: 120 });
  assert.equal(store.getState(zoneId)?.duration, 120);
});

test('player position updates do not overwrite duration when radioControllable is enabled', () => {
  const patches: any[] = [];
  const ctx: any = {
    id: 1,
    name: 'Zone',
    sourceMac: '00:00:00:00:00:00',
    config: {},
    state: { audiopath: 'radioparadise:0', audiotype: 1, time: 0, duration: 360, volume: 50 },
    metadata: { radioControllable: true },
    lastPositionUpdateAt: 0,
    lastPositionValue: 0,
    outputTimingActive: false,
    lastOutputTimingAt: 0,
  };

  const coordinator: any = {
    getZone: () => ctx,
    applyPatch: (_zoneId: number, patch: any) => patches.push(patch),
    dispatchOutputs: () => {},
    dispatchVolume: () => {},
    buildAbsoluteCoverUrl: () => 'http://example.invalid/cover',
    audioHelpers: { isRadioAudiopath: () => false },
    stopAlert: async () => {},
    handleEndOfTrack: async () => {},
    handlePlaybackError: () => {},
  };

  const player = new EventEmitter() as any;
  attachPlayerListeners({
    coordinator,
    player,
    outputs: [],
    zoneId: 1,
    zoneName: 'Zone',
    sourceMac: '00:00:00:00:00:00',
  });

  player.emit('position', 5, 999);

  assert.equal(patches.length, 1);
  assert.equal(patches[0].time, 5);
  assert.equal(Object.prototype.hasOwnProperty.call(patches[0], 'duration'), false);
});

test('radio metadata clears duration when controllable and duration is unavailable', () => {
  const zoneRepo = new ZoneRepository();
  const zoneId = 1;
  zoneRepo.set(zoneId, {
    id: zoneId,
    name: 'Zone',
    sourceMac: '00:00:00:00:00:00',
    config: {} as any,
    state: {
      playerid: zoneId,
      name: 'Zone',
      title: 'Old',
      artist: 'Old',
      album: '',
      coverurl: '',
      audiopath: 'radioparadise:0',
      duration: 360,
      time: 0,
      qindex: 0,
      queueAuthority: 'local',
      plshuffle: 0,
      plrepeat: 0,
      volume: 50,
      mode: 'play',
      audiotype: 1,
      sourceName: 'Zone',
      station: '',
      parent: null,
      type: 3,
      clientState: 'on',
      power: 'on',
    },
    queue: { items: [], shuffle: false, repeat: 0, currentIndex: 0, authority: 'local' },
    queueController: {} as any,
    inputAdapter: {} as any,
    spotifyAdapter: {} as any,
    metadata: { radioControllable: true },
    outputs: [],
    player: {} as any,
    outputTimingActive: false,
    lastOutputTimingAt: 0,
    lastZoneBroadcastAt: 0,
    lastPositionUpdateAt: 0,
    lastPositionValue: 0,
    lastPlaybackErrorAt: 0,
    activeOutputTypes: new Set(),
    activeOutput: null,
    activeInput: null,
    lastMetadataDispatchAt: 0,
    inputMode: null,
  } as any);

  const store = new ZoneStateStore(zoneRepo, {
    isRadioAudiopath: () => false,
    isLineInAudiopath: () => false,
    syncGroupMembersPatch: () => {},
    notifyOutputMetadata: () => {},
    notifier: {
      notifyZoneStateChanged: () => {},
      notifyQueueUpdated: () => {},
      notifyRoomFavoritesChanged: () => {},
      notifyRecentlyPlayedChanged: () => {},
      notifyRescan: () => {},
      notifyReloadMusicApp: () => {},
      notifyAudioSyncEvent: () => {},
    },
    audioManager: {
      getSession: () => null,
      updateSessionTiming: () => {},
      updateSessionMetadata: () => {},
    } as any,
  });

  // Simulate provider handler result: title changes, controllable, duration explicitly cleared to 0.
  store.patch(zoneId, { title: 'New', artist: 'New', duration: 0, audiotype: 1, type: 3 });
  assert.equal(store.getState(zoneId)?.duration, 0);
});

test('ZoneStateStore clears stale session metadata on audiopath boundary change', () => {
  const zoneRepo = new ZoneRepository();
  const zoneId = 1;
  const metadataUpdates: any[] = [];
  zoneRepo.set(zoneId, {
    id: zoneId,
    name: 'Zone',
    sourceMac: '00:00:00:00:00:00',
    config: {} as any,
    state: {
      playerid: zoneId,
      name: 'Zone',
      title: 'Old Title',
      artist: 'Old Artist',
      album: 'Old Album',
      coverurl: 'http://example.invalid/old.jpg',
      audiopath: 'spotify:track:old',
      duration: 194,
      time: 0,
      qindex: 0,
      queueAuthority: 'spotify',
      plshuffle: 0,
      plrepeat: 0,
      volume: 50,
      mode: 'play',
      audiotype: 0,
      sourceName: 'Spotify',
      station: '',
      parent: null,
      type: 3,
      clientState: 'on',
      power: 'on',
    },
    queue: { items: [], shuffle: false, repeat: 0, currentIndex: 0, authority: 'spotify' },
    queueController: {} as any,
    inputAdapter: {} as any,
    spotifyAdapter: {} as any,
    metadata: {},
    outputs: [],
    player: {} as any,
    outputTimingActive: false,
    lastOutputTimingAt: 0,
    lastZoneBroadcastAt: 0,
    lastPositionUpdateAt: 0,
    lastPositionValue: 0,
    lastPlaybackErrorAt: 0,
    activeOutputTypes: new Set(),
    activeOutput: null,
    activeInput: null,
    lastMetadataDispatchAt: 0,
    inputMode: null,
  } as any);

  const store = new ZoneStateStore(zoneRepo, {
    isRadioAudiopath: () => false,
    isLineInAudiopath: () => false,
    syncGroupMembersPatch: () => {},
    notifyOutputMetadata: () => {},
    notifier: {
      notifyZoneStateChanged: () => {},
      notifyQueueUpdated: () => {},
      notifyRoomFavoritesChanged: () => {},
      notifyRecentlyPlayedChanged: () => {},
      notifyRescan: () => {},
      notifyReloadMusicApp: () => {},
      notifyAudioSyncEvent: () => {},
    },
    audioManager: {
      getSession: () => ({
        metadata: {
          title: 'Old Title',
          artist: 'Old Artist',
          album: 'Old Album',
          coverurl: 'http://example.invalid/old.jpg',
          audiopath: 'spotify:track:old',
          duration: 194,
        },
        elapsed: 0,
        duration: 194,
      }),
      updateSessionTiming: () => {},
      updateSessionMetadata: (_zoneId: number, metadata: any) => {
        metadataUpdates.push(metadata);
      },
    } as any,
  });

  store.patch(zoneId, {
    title: 'New Title',
    artist: 'New Artist',
    audiopath: 'spotify:track:new',
  });

  assert.equal(metadataUpdates.length, 1);
  assert.deepEqual(metadataUpdates[0], {
    title: 'New Title',
    artist: 'New Artist',
    album: '',
    coverurl: '',
    duration: 0,
    audiopath: 'spotify:track:new',
    station: '',
    trackId: undefined,
    stationIndex: undefined,
    queue: undefined,
    queueIndex: undefined,
  });
});
