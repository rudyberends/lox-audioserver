import assert from 'node:assert/strict';
import { test } from './testHarness';
import { createMixedGroupController } from '../src/application/groups/mixedGroupController';
import { removeGroupByLeader, upsertGroup } from '../src/application/groups/groupTracker';
import type { ZoneManagerFacade } from '../src/application/zones/createZoneManager';
import type { ConfigPort } from '../src/ports/ConfigPort';
import type { AudioManager } from '../src/application/playback/audioManager';
import type { ZoneState } from '../src/domain/zones/zoneState';

// Which members the mixed group controller has to feed is not "do the protocols differ".
// It is "will anything else feed them". Two DLNA zones share a protocol and still have no
// coordinator between them, so without the fanout the member stays silent — that is not a
// mixed group anyone opted into, it is a group that does not work.

const LEADER = 1;
const MEMBER = 2;
const OTHER = 3;

type ZoneSpec = { output: string; nativeGrouping: boolean };

function controllerFor(zones: Record<number, ZoneSpec>, options: { mixedEnabled: boolean }) {
  const played: Array<{ zoneId: number; audiopath: string }> = [];

  const configPort = {
    getConfig: () => ({ groups: { mixedGroupEnabled: options.mixedEnabled } }),
  } as unknown as ConfigPort;

  const audioManager = {
    // No session for the leader: the controller falls back to replaying its audiopath,
    // which is the branch that shows which members it decided to feed.
    getSession: () => undefined,
    getOutputSettings: () => null,
  } as unknown as AudioManager;

  const leaderState = {
    id: LEADER,
    mode: 'play',
    audiopath: 'library://track/9',
    title: 'Song',
  } as unknown as ZoneState;

  const zoneManager = {
    getState: (zoneId: number) => (zoneId === LEADER ? leaderState : ({ id: zoneId } as ZoneState)),
    getTechnicalSnapshot: (zoneId: number) => {
      const spec = zones[zoneId];
      return spec ? { activeOutput: spec.output, transports: [spec.output] } : null;
    },
    supportsNativeGrouping: (zoneId: number) => zones[zoneId]?.nativeGrouping === true,
    playContent: async (zoneId: number, audiopath: string) => {
      played.push({ zoneId, audiopath });
    },
    handleCommand: () => undefined,
    inputs: { playInputSource: () => undefined },
  } as unknown as ZoneManagerFacade;

  const controller = createMixedGroupController(configPort, audioManager);
  controller.initOnce({ zoneManager });
  return { controller, played, leaderState };
}

function fedMembers(
  zones: Record<number, ZoneSpec>,
  members: number[],
  options: { mixedEnabled: boolean },
): number[] {
  const { controller, played, leaderState } = controllerFor(zones, options);
  upsertGroup({
    leader: LEADER,
    members: [LEADER, ...members],
    backend: 'Unknown',
    source: 'manual',
    externalId: 'grp',
  });
  try {
    controller.handleStatePatch(LEADER, { mode: 'play' }, leaderState);
    return played.map((entry) => entry.zoneId).sort((a, b) => a - b);
  } finally {
    removeGroupByLeader(LEADER);
  }
}

const dlna = { output: 'dlna', nativeGrouping: false };
const cast = { output: 'googleCast', nativeGrouping: false };
const squeezelite = { output: 'squeezelite', nativeGrouping: true };
const sonos = { output: 'sonos', nativeGrouping: true };

test('two zones on a protocol that cannot group are fed by the server', () => {
  // Nothing else will: there is no DLNA group coordinator. This used to fall through
  // every branch — same protocol, so "not mixed" — and the member played nothing.
  const fed = fedMembers({ [LEADER]: dlna, [MEMBER]: dlna }, [MEMBER], { mixedEnabled: false });
  assert.deepEqual(fed, [MEMBER]);
});

test('and that does not wait for the mixed groups toggle', () => {
  // The toggle is about combining protocols. A group of one protocol either works or is
  // silent, which is not a choice worth offering.
  const fed = fedMembers({ [LEADER]: cast, [MEMBER]: cast }, [MEMBER], { mixedEnabled: true });
  assert.deepEqual(fed, [MEMBER]);
});

test('a protocol that groups itself is left to do so', () => {
  // Feeding these would fight with the coordinator that already syncs them, and lose:
  // its members play the leader's stream in lock-step, not a copy of it.
  const fed = fedMembers({ [LEADER]: squeezelite, [MEMBER]: squeezelite }, [MEMBER], {
    mixedEnabled: true,
  });
  assert.deepEqual(fed, []);
});

test('crossing protocols still needs the toggle', () => {
  const zones = { [LEADER]: sonos, [MEMBER]: squeezelite };
  assert.deepEqual(fedMembers(zones, [MEMBER], { mixedEnabled: false }), [], 'off');
  assert.deepEqual(fedMembers(zones, [MEMBER], { mixedEnabled: true }), [MEMBER], 'on');
});

test('in one group, only the members nothing else feeds', () => {
  // A squeezelite leader with a squeezelite member and a DLNA member: the first is
  // synced over slimproto, the second has to be fed. Feeding both would waste an
  // encoder on a member that ignores it.
  const fed = fedMembers(
    { [LEADER]: squeezelite, [MEMBER]: squeezelite, [OTHER]: dlna },
    [MEMBER, OTHER],
    { mixedEnabled: true },
  );
  assert.deepEqual(fed, [OTHER]);
});
