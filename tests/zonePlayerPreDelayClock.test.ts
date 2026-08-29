import assert from 'node:assert/strict';
import { test } from './testHarness';
import { ZonePlayer } from '../src/application/playback/zonePlayer';
import type { PlaybackSession } from '../src/ports/types/playback';

type Scheduled = { ms: number; fn: () => void };

function buildSession(preDelayMs?: number): PlaybackSession {
  return {
    zoneId: 1,
    source: 'alerts://bell.mp3',
    stream: { id: 'stream-1', url: 'http://example.invalid/1', coverUrl: '', createdAt: 0 },
    state: 'playing',
    elapsed: 0,
    duration: 6,
    startedAt: 0,
    updatedAt: 0,
    profiles: ['flac'],
    playbackSource: { kind: 'file', path: '/tmp/bell.mp3', ...(preDelayMs ? { preDelayMs } : {}) },
  } as PlaybackSession;
}

/**
 * Captures the timer calls the player makes, so its scheduling decisions can be
 * asserted (and fired) without waiting for real time to pass.
 */
function captureTimers(): {
  timeouts: Scheduled[];
  intervals: Scheduled[];
  settle: () => Promise<void>;
  restore: () => void;
} {
  const timeouts: Scheduled[] = [];
  const intervals: Scheduled[] = [];
  const realSetTimeout = global.setTimeout;
  const realSetInterval = global.setInterval;
  (global as any).setTimeout = (handler: () => void, ms?: number) => {
    timeouts.push({ ms: ms ?? 0, fn: handler });
    return { unref: () => {} };
  };
  (global as any).setInterval = (handler: () => void, ms?: number) => {
    intervals.push({ ms: ms ?? 0, fn: handler });
    return { unref: () => {} };
  };
  return {
    timeouts,
    intervals,
    // The first-chunk promise resolves on the microtask queue; give it room to run.
    settle: async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    restore: () => {
      (global as any).setTimeout = realSetTimeout;
      (global as any).setInterval = realSetInterval;
    },
  };
}

test('zone clock waits out the amp wake-up silence before it starts counting (#293)', async () => {
  const session = buildSession(3000);
  const audioManager = {
    startPlayback: () => session,
    waitForFirstChunk: () => Promise.resolve(true),
    getSession: () => session,
  } as any;
  const player = new ZonePlayer(audioManager, 1, 'Zone', '00:00:00:00:00:00', true);

  const timers = captureTimers();
  try {
    player.playUri('alerts://bell.mp3', { title: 'bell', artist: '', album: '', duration: 6 });
    await timers.settle();

    // The first chunk is the start of the prepended silence, not of the audio: counting it
    // would end the clip 3 s before the room has heard it out.
    assert.equal(timers.intervals.length, 0);
    assert.deepEqual(
      timers.timeouts.map((entry) => entry.ms),
      [3000],
    );

    timers.timeouts[0]?.fn();
    assert.equal(timers.intervals.length, 1);
  } finally {
    timers.restore();
  }
});

test('zone clock starts on the first chunk when nothing is prepended', async () => {
  const session = buildSession();
  const audioManager = {
    startPlayback: () => session,
    waitForFirstChunk: () => Promise.resolve(true),
    getSession: () => session,
  } as any;
  const player = new ZonePlayer(audioManager, 1, 'Zone', '00:00:00:00:00:00', true);

  const timers = captureTimers();
  try {
    player.playUri('http://example.invalid/track.mp3', {
      title: 'track',
      artist: '',
      album: '',
      duration: 6,
    });
    await timers.settle();

    assert.equal(timers.timeouts.length, 0);
    assert.equal(timers.intervals.length, 1);
  } finally {
    timers.restore();
  }
});

test('stopping playback cancels a clock that is still waiting on the silence', async () => {
  const session = buildSession(3000);
  const audioManager = {
    startPlayback: () => session,
    stopPlayback: () => session,
    waitForFirstChunk: () => Promise.resolve(true),
    getSession: () => session,
  } as any;
  const player = new ZonePlayer(audioManager, 1, 'Zone', '00:00:00:00:00:00', true);

  const timers = captureTimers();
  try {
    player.playUri('alerts://bell.mp3', { title: 'bell', artist: '', album: '', duration: 6 });
    await timers.settle();
    assert.equal(timers.timeouts.length, 1);

    player.stop('command_stop');
    // The pending start must not resurrect the ticker for a session that is gone.
    timers.timeouts[0]?.fn();
    assert.equal(timers.intervals.length, 0);
  } finally {
    timers.restore();
  }
});
