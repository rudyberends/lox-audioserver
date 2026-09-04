import assert from 'node:assert/strict';
import { test } from './testHarness';
import { EventType, PlayerState } from '@sonn-audio/node-slimproto';
import { createSqueezeliteGroupController } from '../src/application/outputs/squeezeliteGroupController';
import { getGroupByZone, removeGroupByLeader, upsertGroup } from '../src/application/groups/groupTracker';
import { SqueezeliteOutput } from '../src/adapters/outputs/squeezelite/squeezeliteOutput';
import type { OutputPorts } from '../src/adapters/outputs/outputPorts';
import type { PlaybackSession } from '../src/application/playback/audioManager';

// Grouping in squeezelite is leader-centric: members follow the leader's stream URL and
// are unpaused against its clock. A mixed group has a leader on another protocol, so none
// of that applies — the mixed group controller feeds each member its own pipe instead.
// The output used to treat every group it was in as a slimproto sync-group, which meant a
// member of a mixed group returned from play() without ever sending a strm, and paused by
// asking a group that has no leader to pause. Both left the zone silent.

const SONOS = 5;
const SQ_A = 11;
const SQ_B = 12;

const PLAYER_ID = 'aa:bb:cc:dd:ee:ff';

function fakePlayer(state: PlayerState = PlayerState.STOPPED) {
  const calls = { play: [] as string[], pause: 0, unpauseAt: [] as number[] };
  return {
    calls,
    player: {
      playerId: PLAYER_ID,
      name: 'Kitchen',
      connected: true,
      state,
      jiffies: 1000,
      clockSync: { rttMs: 4, jiffies: 1000, serverTimeMs: Date.now() },
      playUrl: async (url: string) => {
        calls.play.push(url);
      },
      pause: async () => {
        calls.pause += 1;
      },
      stop: async () => undefined,
      play: async () => undefined,
      requestClockSync: async () => true,
      estimateJiffiesAt: (ms: number) => ms,
      unpauseAt: async (target: number) => {
        calls.unpauseAt.push(target);
      },
    },
  };
}

function participant(zoneId: number, player: unknown) {
  return { zoneId, getPlayer: () => player as never, getLatencyMs: () => 0 };
}

test('a group led by another protocol is not a slimproto sync-group', () => {
  // Two squeezelite zones behind a Sonos leader. There is no leader player to follow and
  // no leader stream to share, so the pair must not be held for a coordinated start.
  const controller = createSqueezeliteGroupController();
  upsertGroup({
    leader: SONOS,
    members: [SONOS, SQ_A, SQ_B],
    backend: 'Unknown',
    source: 'manual',
    externalId: 'mixed',
  });
  try {
    controller.register(participant(SQ_A, fakePlayer().player));
    controller.register(participant(SQ_B, fakePlayer().player));

    assert.equal(controller.isSyncGroup(SQ_A), false);
    const info = controller.preparePlayback(SQ_A);
    assert.equal(info.grouped, false, 'each member plays its own stream');
    assert.equal(info.leaderZoneId, SQ_A, 'and never builds a url on the Sonos zone');
    assert.equal(info.expectedCount, 1);
  } finally {
    removeGroupByLeader(SONOS);
  }
});

test('one squeezelite zone alongside another protocol is not a sync-group either', () => {
  // The case from the feature request: one Sonos, one squeezelite. Nothing to sync with.
  const controller = createSqueezeliteGroupController();
  upsertGroup({
    leader: SONOS,
    members: [SONOS, SQ_A],
    backend: 'Unknown',
    source: 'manual',
    externalId: 'mixed',
  });
  try {
    controller.register(participant(SQ_A, fakePlayer().player));
    assert.equal(controller.isSyncGroup(SQ_A), false);
  } finally {
    removeGroupByLeader(SONOS);
  }
});

test('a group led by a squeezelite zone still syncs its members', async () => {
  // The regression guard: gating on the leader must not disarm real sync-groups.
  const controller = createSqueezeliteGroupController();
  const leader = fakePlayer(PlayerState.BUFFER_READY);
  const member = fakePlayer(PlayerState.BUFFER_READY);
  upsertGroup({
    leader: SQ_A,
    members: [SQ_A, SQ_B, SONOS],
    backend: 'Unknown',
    source: 'manual',
    externalId: 'native',
  });
  try {
    controller.register(participant(SQ_A, leader.player));
    controller.register(participant(SQ_B, member.player));

    assert.equal(controller.isSyncGroup(SQ_B), true);
    const info = controller.preparePlayback(SQ_A);
    assert.equal(info.grouped, true);
    assert.equal(info.leaderZoneId, SQ_A);
    assert.equal(info.expectedCount, 2, 'the Sonos member is not a slimproto player');

    // Both are buffered, so the controller should unpause them against one timestamp.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(leader.calls.unpauseAt.length, 1, 'leader scheduled');
    assert.equal(member.calls.unpauseAt.length, 1, 'member scheduled');
  } finally {
    removeGroupByLeader(SQ_A);
  }
});

type OutputHarness = {
  output: SqueezeliteOutput;
  session: PlaybackSession;
  calls: { play: string[]; pause: number };
};

/**
 * The output wired to the real group controller and the real tracker, because the bug
 * lived in what the controller told the output about a group it did not lead.
 */
function outputHarness(options: {
  zoneId: number;
  group: { leader: number; members: number[] };
  alsoRegister?: number[];
}): OutputHarness {
  const controller = createSqueezeliteGroupController();
  const fake = fakePlayer(PlayerState.BUFFER_READY);
  const session = {
    state: 'playing',
    playbackSource: { url: 'http://example/stream.flac' },
    source: 'library://track/9',
    stream: { coverUrl: '', url: `/streams/${options.zoneId}/current.flac` },
    metadata: { title: 'Song', artist: 'Artist', album: 'Album' },
  } as unknown as PlaybackSession;

  upsertGroup({
    leader: options.group.leader,
    members: options.group.members,
    backend: 'Unknown',
    source: 'manual',
    externalId: `grp-${options.group.leader}`,
  });
  for (const zoneId of options.alsoRegister ?? []) {
    controller.register(participant(zoneId, fakePlayer(PlayerState.BUFFER_READY).player));
  }

  const ports = {
    audioManager: {
      getSession: () => session,
      getOutputSettings: () => null,
      startExternalPlayback: () => null,
    },
    groupTracker: {
      getGroupByZone: (zoneId: number) => getGroupByZone(zoneId),
      onGroupChanged: () => () => undefined,
      clearJoinedLeader: () => undefined,
    },
    squeezeliteCore: {
      getPlayer: () => fake.player,
      players: [fake.player],
      waitForPlayer: async () => fake.player,
      subscribe: (_fn: (event: { type: EventType; playerId: string }) => void) => () => undefined,
    },
    squeezeliteGroup: controller,
    zoneAudioPrefs: {
      getEffectiveOutputSettings: () => ({ sampleRate: 44100, channels: 2, pcmBitDepth: 16 }),
    },
    outputHandlers: {
      onOutputState: () => undefined,
      onOutputError: () => undefined,
      onOutputTrackEnded: () => undefined,
    },
    config: {
      getConfig: () => ({}),
      getSystemConfig: () => ({ audioserver: { ip: '10.0.0.2' } }),
    },
    zoneManager: { getZoneState: () => ({ id: options.zoneId, volume: 40 }) },
  } as unknown as OutputPorts;

  return {
    output: new SqueezeliteOutput(options.zoneId, 'Kitchen', { playerId: PLAYER_ID }, ports),
    session,
    calls: fake.calls,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('a member of a mixed group plays its own stream instead of nothing', async () => {
  // Two squeezelite zones behind a Sonos leader. The group used to report itself as
  // synced with the Sonos zone as leader, so both members returned from play() without
  // ever sending a strm and the pipe handed to them was never played.
  const h = outputHarness({
    zoneId: SQ_A,
    group: { leader: SONOS, members: [SONOS, SQ_A, SQ_B] },
    alsoRegister: [SQ_B],
  });
  try {
    await h.output.play(h.session);
    assert.equal(h.calls.play.length, 1, 'a strm was sent');
    assert.match(
      h.calls.play[0]!,
      new RegExp(`/streams/${SQ_A}/`),
      "its own stream, not the leader's",
    );
    assert.match(h.calls.play[0]!, /expect=1/, 'and not as a sync-group member');
  } finally {
    removeGroupByLeader(SONOS);
  }
});

test('a member of a mixed group pauses itself', async () => {
  // One Sonos, one squeezelite: the case from the feature request. Pause asked the group
  // to pause and returned either way; with no leader player nothing happened at all.
  const h = outputHarness({ zoneId: SQ_A, group: { leader: SONOS, members: [SONOS, SQ_A] } });
  try {
    await h.output.pause(null);
    assert.equal(h.calls.pause, 1);
  } finally {
    removeGroupByLeader(SONOS);
  }
});

test('a member of a real squeezelite group still waits for its leader', async () => {
  // The regression guard on the output side: members of a genuine sync-group must not
  // start their own stream, because the leader orchestrates all of them at once.
  const h = outputHarness({
    zoneId: SQ_B,
    group: { leader: SQ_A, members: [SQ_A, SQ_B] },
    alsoRegister: [SQ_A],
  });
  try {
    await h.output.play(h.session);
    assert.equal(h.calls.play.length, 0, 'left to the leader');
    await settle();
  } finally {
    removeGroupByLeader(SQ_A);
  }
});
