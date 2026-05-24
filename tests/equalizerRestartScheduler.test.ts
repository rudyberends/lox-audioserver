import assert from 'node:assert/strict';
import { test } from './testHarness';
import { EqualizerRestartScheduler } from '../src/application/playback/EqualizerRestartScheduler';
import { createLogger } from '../src/shared/logging/logger';
import type { PlaybackSession } from '../src/ports/types/playback';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type SchedulerFakes = {
  sessions: Map<number, PlaybackSession>;
  hasSession: Set<number>;
  bands: Map<number, ReadonlyArray<number> | null>;
  restartCalls: Array<{ zoneId: number; bands: ReadonlyArray<number> | null }>;
};

function buildScheduler(debounceMs = 5): { scheduler: EqualizerRestartScheduler; fakes: SchedulerFakes } {
  const fakes: SchedulerFakes = {
    sessions: new Map(),
    hasSession: new Set(),
    bands: new Map(),
    restartCalls: [],
  };
  const scheduler = new EqualizerRestartScheduler({
    getSession: (zoneId) => fakes.sessions.get(zoneId),
    playbackService: {
      hasSession: (zoneId: number) => fakes.hasSession.has(zoneId),
      restartZoneForEqualizer: (zoneId: number, bands: ReadonlyArray<number> | null) => {
        fakes.restartCalls.push({ zoneId, bands });
      },
    } as never,
    getEqualizerBands: (zoneId) => fakes.bands.get(zoneId) ?? null,
    log: createLogger('Test', 'EqualizerRestartScheduler'),
  }, debounceMs);
  return { scheduler, fakes };
}

function makeSession(state: PlaybackSession['state'], hasSource = true): PlaybackSession {
  return {
    state,
    playbackSource: hasSource ? ({ kind: 'pipe', path: 'x' } as never) : undefined,
  } as PlaybackSession;
}

test('EqualizerRestartScheduler triggers restart after debounce when session is playing', async () => {
  const { scheduler, fakes } = buildScheduler(5);
  fakes.sessions.set(1, makeSession('playing'));
  fakes.hasSession.add(1);
  fakes.bands.set(1, [0, 0, 0, 0, 0]);

  scheduler.schedule(1);
  await wait(20);

  assert.equal(fakes.restartCalls.length, 1);
  assert.equal(fakes.restartCalls[0]?.zoneId, 1);
  assert.deepEqual(fakes.restartCalls[0]?.bands, [0, 0, 0, 0, 0]);
});

test('EqualizerRestartScheduler debounces repeated schedules into a single restart', async () => {
  const { scheduler, fakes } = buildScheduler(15);
  fakes.sessions.set(1, makeSession('playing'));
  fakes.hasSession.add(1);
  fakes.bands.set(1, null);

  scheduler.schedule(1);
  await wait(2);
  scheduler.schedule(1);
  await wait(2);
  scheduler.schedule(1);
  await wait(40);

  assert.equal(fakes.restartCalls.length, 1);
});

test('EqualizerRestartScheduler skips restart when there is no session', async () => {
  const { scheduler, fakes } = buildScheduler(5);
  scheduler.schedule(1);
  await wait(20);
  assert.equal(fakes.restartCalls.length, 0);
});

test('EqualizerRestartScheduler skips restart when session has no playbackSource', async () => {
  const { scheduler, fakes } = buildScheduler(5);
  fakes.sessions.set(1, makeSession('playing', false));
  fakes.hasSession.add(1);

  scheduler.schedule(1);
  await wait(20);

  assert.equal(fakes.restartCalls.length, 0);
});

test('EqualizerRestartScheduler skips restart when playbackService no longer holds the session', async () => {
  const { scheduler, fakes } = buildScheduler(5);
  fakes.sessions.set(1, makeSession('playing'));

  scheduler.schedule(1);
  await wait(20);

  assert.equal(fakes.restartCalls.length, 0);
});

test('EqualizerRestartScheduler skips restart when session is paused', async () => {
  const { scheduler, fakes } = buildScheduler(5);
  fakes.sessions.set(1, makeSession('paused'));
  fakes.hasSession.add(1);

  scheduler.schedule(1);
  await wait(20);

  assert.equal(fakes.restartCalls.length, 0);
});

test('EqualizerRestartScheduler keeps zones independent', async () => {
  const { scheduler, fakes } = buildScheduler(5);
  fakes.sessions.set(1, makeSession('playing'));
  fakes.sessions.set(2, makeSession('playing'));
  fakes.hasSession.add(1);
  fakes.hasSession.add(2);
  fakes.bands.set(1, [1]);
  fakes.bands.set(2, [2]);

  scheduler.schedule(1);
  scheduler.schedule(2);
  await wait(20);

  assert.equal(fakes.restartCalls.length, 2);
  const zones = fakes.restartCalls.map((c) => c.zoneId).sort();
  assert.deepEqual(zones, [1, 2]);
});

test('EqualizerRestartScheduler reads bands at apply-time, not schedule-time', async () => {
  const { scheduler, fakes } = buildScheduler(10);
  fakes.sessions.set(1, makeSession('playing'));
  fakes.hasSession.add(1);
  fakes.bands.set(1, [0, 0]);

  scheduler.schedule(1);
  // Bands change between schedule and apply — apply should see the new value.
  fakes.bands.set(1, [9, 9]);
  await wait(30);

  assert.equal(fakes.restartCalls.length, 1);
  assert.deepEqual(fakes.restartCalls[0]?.bands, [9, 9]);
});
