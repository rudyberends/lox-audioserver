import assert from 'node:assert/strict';
import { test } from './testHarness';
import { ZoneStateStore } from '../src/application/zones/ZoneStateStore';
import { ZoneRepository } from '../src/application/zones/ZoneRepository';
import type { ZoneContext } from '../src/application/zones/internal/zoneTypes';
import type { LoxoneZoneState } from '../src/domain/loxone/types';
import { AudioType } from '../src/domain/loxone/enums';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type StoreFakes = {
  zones: ZoneRepository;
  ctx: ZoneContext;
  broadcasts: LoxoneZoneState[];
  groupSyncs: Array<{ leaderId: number; patch: Partial<LoxoneZoneState>; force: boolean }>;
  metadataCalls: Array<{ zoneId: number; patch: Partial<LoxoneZoneState> }>;
  sessionTimingCalls: Array<{ zoneId: number; elapsed: number; duration: number }>;
  sessionMetadataCalls: Array<{ zoneId: number; metadata: unknown }>;
  onStatePatchCalls: Array<{ zoneId: number; patch: Partial<LoxoneZoneState> }>;
  audioSession: { metadata?: Record<string, unknown> } | null;
};

function buildStore(opts: {
  initialState?: Partial<LoxoneZoneState>;
  isRadioAudiopath?: (a: string | undefined, t?: number | null) => boolean;
  isLineInAudiopath?: (a: string | undefined) => boolean;
  audioSession?: { metadata?: Record<string, unknown> } | null;
  metadata?: Record<string, unknown>;
} = {}): { store: ZoneStateStore; fakes: StoreFakes } {
  const zones = new ZoneRepository();
  // Default type = FileType.Playlist (3) so resolveLoxoneType does not auto-mutate the patch.
  const initial: LoxoneZoneState = {
    id: 1,
    name: 'Zone',
    volume: 30,
    mode: 'stop',
    audiopath: '',
    title: '',
    artist: '',
    album: '',
    time: 0,
    duration: 0,
    audiotype: 0,
    type: 3,
    ...(opts.initialState ?? {}),
  } as LoxoneZoneState;

  const fakes: StoreFakes = {
    zones,
    ctx: {
      id: 1,
      state: initial,
      metadata: opts.metadata ?? {},
      lastZoneBroadcastAt: 0,
      outputs: [],
      activeOutput: null,
      inputMode: null,
      activeInput: null,
    } as unknown as ZoneContext,
    broadcasts: [],
    groupSyncs: [],
    metadataCalls: [],
    sessionTimingCalls: [],
    sessionMetadataCalls: [],
    onStatePatchCalls: [],
    audioSession: opts.audioSession ?? null,
  };
  zones.set(1, fakes.ctx);

  const store = new ZoneStateStore(zones, {
    isRadioAudiopath: opts.isRadioAudiopath ?? (() => false),
    isLineInAudiopath: opts.isLineInAudiopath ?? (() => false),
    syncGroupMembersPatch: (leaderId, patch, force) => {
      fakes.groupSyncs.push({ leaderId, patch, force });
    },
    onStatePatch: (zoneId, patch) => {
      fakes.onStatePatchCalls.push({ zoneId, patch });
    },
    notifyOutputMetadata: (zoneId, _ctx, patch) => {
      fakes.metadataCalls.push({ zoneId, patch });
    },
    notifier: {
      notifyZoneStateChanged: (state) => fakes.broadcasts.push(state),
      notifyQueueUpdated: () => {},
      notifyRoomFavoritesChanged: () => {},
      notifyRecentlyPlayedChanged: () => {},
      notifyRescan: () => {},
      notifyReloadMusicApp: () => {},
      notifyAudioSyncEvent: () => {},
    },
    audioManager: {
      getSession: () => fakes.audioSession as never,
      updateSessionTiming: (zoneId, elapsed, duration) => {
        fakes.sessionTimingCalls.push({ zoneId, elapsed, duration });
      },
      updateSessionMetadata: (zoneId, metadata) => {
        fakes.sessionMetadataCalls.push({ zoneId, metadata });
        if (fakes.audioSession) {
          fakes.audioSession.metadata = metadata as never;
        }
      },
    } as never,
  });

  return { store, fakes };
}

test('ZoneStateStore.patch is a no-op when zone does not exist', () => {
  const { store, fakes } = buildStore();
  store.patch(999, { volume: 99 });
  assert.equal(fakes.broadcasts.length, 0);
});

test('ZoneStateStore.patch skips broadcast when nothing actually changes', () => {
  const { store, fakes } = buildStore({ initialState: { volume: 30, mode: 'stop' } });
  store.patch(1, { volume: 30, mode: 'stop' });
  assert.equal(fakes.broadcasts.length, 0);
  assert.equal(fakes.ctx.state.volume, 30);
});

test('ZoneStateStore.patch with force broadcasts even when nothing changes', () => {
  const { store, fakes } = buildStore({ initialState: { volume: 30 } });
  store.patch(1, { volume: 30 }, true);
  assert.equal(fakes.broadcasts.length, 1);
});

test('ZoneStateStore.patch updates state and broadcasts on change', () => {
  const { store, fakes } = buildStore({ initialState: { volume: 30 } });
  store.patch(1, { volume: 55 });
  assert.equal(fakes.ctx.state.volume, 55);
  assert.equal(fakes.broadcasts.length, 1);
  assert.equal(fakes.broadcasts[0]?.volume, 55);
});

test('ZoneStateStore.patch calls onStatePatch hook with patch and zone id', () => {
  const { store, fakes } = buildStore();
  store.patch(1, { volume: 60 });
  assert.equal(fakes.onStatePatchCalls.length, 1);
  assert.equal(fakes.onStatePatchCalls[0]?.zoneId, 1);
  assert.equal(fakes.onStatePatchCalls[0]?.patch.volume, 60);
});

test('ZoneStateStore.patch always calls syncGroupMembersPatch', () => {
  const { store, fakes } = buildStore();
  store.patch(1, { volume: 55 }, true);
  assert.equal(fakes.groupSyncs.length, 1);
  assert.equal(fakes.groupSyncs[0]?.leaderId, 1);
  assert.equal(fakes.groupSyncs[0]?.force, true);
});

test('ZoneStateStore.patch throttles time-only updates to ~1 Hz', async () => {
  const { store, fakes } = buildStore({ initialState: { time: 0 } });
  store.patch(1, { time: 10 });
  store.patch(1, { time: 11 });
  store.patch(1, { time: 12 });
  // First broadcast went through; rest throttled
  assert.equal(fakes.broadcasts.length, 1);
  // State still updates internally though
  assert.equal(fakes.ctx.state.time, 12);
});

test('ZoneStateStore.patch does NOT throttle time + duration updates', () => {
  const { store, fakes } = buildStore({ initialState: { time: 0, duration: 100 } });
  store.patch(1, { time: 10, duration: 120 });
  // Two-field updates are not throttled
  assert.equal(fakes.broadcasts.length, 1);
});

test('ZoneStateStore.patch drops zero duration for non-radio non-linein non-stopping zones', () => {
  const { store, fakes } = buildStore({ initialState: { duration: 100, mode: 'play' } });
  store.patch(1, { duration: 0 });
  // Duration drop should leave state untouched
  assert.equal(fakes.ctx.state.duration, 100);
});

test('ZoneStateStore.patch keeps larger duration when track has not changed', () => {
  const { store, fakes } = buildStore({ initialState: { duration: 200, mode: 'play' } });
  store.patch(1, { duration: 150 });
  assert.equal(fakes.ctx.state.duration, 200);
});

test('ZoneStateStore.patch accepts zero duration when stopping', () => {
  const { store, fakes } = buildStore({ initialState: { duration: 200 } });
  store.patch(1, { mode: 'stop', duration: 0 });
  assert.equal(fakes.ctx.state.duration, 0);
});

test('ZoneStateStore.patch forces audiotype=1/time=0/duration=0 for radio audiopaths', () => {
  const { store, fakes } = buildStore({
    isRadioAudiopath: (audiopath) => audiopath === 'radio://x',
  });
  store.patch(1, { audiopath: 'radio://x' });
  assert.equal(fakes.ctx.state.audiotype, 1);
  assert.equal(fakes.ctx.state.time, 0);
  assert.equal(fakes.ctx.state.duration, 0);
});

test('ZoneStateStore.patch uses radioStationFallback when station empty on radio', () => {
  const { store, fakes } = buildStore({
    isRadioAudiopath: () => true,
    metadata: { radioStationFallback: 'Fallback FM' },
    initialState: { audiopath: 'radio://x' },
  });
  store.patch(1, { artist: 'Some Artist' });
  assert.equal(fakes.ctx.state.station, 'Fallback FM');
});

test('ZoneStateStore.patch resolves line-in audiopath as FileType.LineIn', () => {
  const { store, fakes } = buildStore();
  store.patch(1, { audiopath: 'linein:0' });
  // FileType.LineIn = 6
  assert.equal(fakes.ctx.state.type, 6);
});

test('ZoneStateStore.patch syncs audio session timing on time/duration patch', () => {
  const { store, fakes } = buildStore({ initialState: { time: 0, duration: 100 }, audioSession: { metadata: {} } });
  store.patch(1, { time: 50, duration: 100 });
  assert.equal(fakes.sessionTimingCalls.length, 1);
  assert.equal(fakes.sessionTimingCalls[0]?.elapsed, 50);
});

test('ZoneStateStore.patch propagates metadata changes to audio session', () => {
  const { store, fakes } = buildStore({
    initialState: { title: 'Old', audiopath: '' },
    audioSession: { metadata: { title: 'Old', artist: '', album: '' } },
  });
  store.patch(1, { title: 'New Track' });
  assert.equal(fakes.sessionMetadataCalls.length, 1);
});

test('ZoneStateStore.patch skips session-metadata sync when nothing relevant changes', () => {
  const { store, fakes } = buildStore({
    initialState: { title: 'Same', station: '' },
    audioSession: { metadata: { title: 'Same', artist: '', album: '', station: '' } },
  });
  // No metadata fields in patch → no session-metadata update path
  store.patch(1, { volume: 55 });
  assert.equal(fakes.sessionMetadataCalls.length, 0);
});

test('ZoneStateStore.patch dispatches notifyOutputMetadata', () => {
  const { store, fakes } = buildStore();
  store.patch(1, { title: 'Hello' });
  assert.equal(fakes.metadataCalls.length, 1);
  assert.equal(fakes.metadataCalls[0]?.patch.title, 'Hello');
});

test('ZoneStateStore.getZoneState returns current state or null', () => {
  const { store } = buildStore({ initialState: { volume: 30 } });
  assert.equal(store.getZoneState(1)?.volume, 30);
  assert.equal(store.getZoneState(999), null);
});

test('ZoneStateStore.setInitial replaces state without going through patch logic', () => {
  const { store, fakes } = buildStore();
  const newState = { id: 1, volume: 77, mode: 'play' } as LoxoneZoneState;
  store.setInitial(1, newState);
  assert.equal(fakes.ctx.state.volume, 77);
  assert.equal(fakes.broadcasts.length, 0);
});

test('ZoneStateStore.getTechnicalSnapshot returns null for missing zone', () => {
  const { store } = buildStore();
  assert.equal(store.getTechnicalSnapshot(999), null);
});

test('ZoneStateStore.getTechnicalSnapshot returns transports and active output', () => {
  const { store, fakes } = buildStore();
  fakes.ctx.outputs = [{ type: 'sonos' }, { type: 'squeezelite' }] as never;
  fakes.ctx.activeOutput = 'sonos';
  const snap = store.getTechnicalSnapshot(1);
  assert.deepEqual(snap?.transports, ['sonos', 'squeezelite']);
  assert.deepEqual(snap?.outputs, ['sonos']);
});

// Throttling boundary: after 1100 ms the time-only broadcast must go through again.
test('ZoneStateStore.patch time-only throttle releases after the 1s window', async () => {
  const { store, fakes } = buildStore({ initialState: { time: 0 } });
  store.patch(1, { time: 10 });
  assert.equal(fakes.broadcasts.length, 1);
  store.patch(1, { time: 11 });
  assert.equal(fakes.broadcasts.length, 1);
  await wait(1100);
  store.patch(1, { time: 12 });
  assert.equal(fakes.broadcasts.length, 2);
});

test('ZoneStateStore.patch radio audiotype resolves type to FileType.File', () => {
  const { store, fakes } = buildStore();
  store.patch(1, { audiotype: AudioType.Radio });
  // FileType.File = 2
  assert.equal(fakes.ctx.state.type, 2);
});
