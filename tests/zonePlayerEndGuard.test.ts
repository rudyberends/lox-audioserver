import assert from 'node:assert/strict';
import { test } from './testHarness';
import { ZonePlayer } from '../src/application/playback/zonePlayer';

test('zone player emits ended when end guard is configured', () => {
  const audioManager = { getSession: () => null } as any;
  const player = new ZonePlayer(audioManager, 1, 'Zone', '00:00:00:00:00:00', true);

  let ended = false;
  player.on('ended', () => {
    ended = true;
  });

  // Simulate we're exactly at the end, but an output latency guard was applied.
  player.setEndGuardMs(500); // 0.5s
  (player as any).state = {
    mode: 'playing',
    time: 10,
    duration: 10,
    playbackSource: { kind: 'url', url: 'http://example.invalid' },
  };
  (player as any).endedEmitted = false;
  (player as any).lastTickAt = Date.now() - 1000;

  (player as any).tick();

  assert.equal(ended, true);
});

