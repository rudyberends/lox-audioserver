import assert from 'node:assert/strict';
import { test } from './testHarness';
import { toLoxoneZoneState } from '../src/adapters/loxone/ws/zoneStateProjection';
import { LoxoneWsNotifier } from '../src/adapters/loxone/ws/notifier';
import { AudioEventType, AudioType, FileType } from '../src/domain/zones/enums';
import type { ZoneState } from '../src/domain/zones/zoneState';

// Loxone is a projection of the server's zone state, not its source. These tests
// pin the fields the adapter has to *compute* — the ones that must therefore not
// creep back into ZoneState — and the guards that keep raw ids off the wire.

function zoneState(overrides: Partial<ZoneState> = {}): ZoneState {
  return {
    id: 3,
    name: 'Kitchen',
    mode: 'play',
    power: 'on',
    clientState: 'on',
    time: 12,
    duration: 210,
    volume: 40,
    plrepeat: 0,
    plshuffle: 0,
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    coverurl: 'http://cover',
    station: '',
    sourceName: 'Library',
    audiopath: 'library://track/9',
    audiotype: AudioType.File,
    type: FileType.File,
    eq: [0,0,0,0,0,0,0,0,0,0],
    qindex: 0,
    ...overrides,
  } as ZoneState;
}

const noGroup = {
  group: null,
  leaderVolume: 0,
  audiopathToLoxone: (p: string) => p,
};

test('loxone projection reports no sync group as empty syncedzones and zero mastervolume', () => {
  const out = toLoxoneZoneState(zoneState(), noGroup);
  assert.deepEqual(out.syncedzones, []);
  assert.equal(out.mastervolume, 0);
});

test('loxone projection computes mastervolume from the group leader', () => {
  // ZoneState deliberately no longer carries mastervolume: only this payload needs
  // it, so the adapter derives it. A member reports the leader's volume, not its own.
  const out = toLoxoneZoneState(zoneState({ id: 7, volume: 15 }), {
    group: { leader: 3, members: [3, 7] },
    leaderVolume: 42,
    audiopathToLoxone: (p) => p,
  });
  assert.equal(out.mastervolume, 42);
  assert.equal(out.volume, 15, "the member's own volume is untouched");
  assert.deepEqual(out.syncedzones, [3, 7], 'leader first');
});

test('loxone projection clamps mastervolume into the 0-100 the client accepts', () => {
  const high = toLoxoneZoneState(zoneState(), {
    group: { leader: 3, members: [3] },
    leaderVolume: 500,
    audiopathToLoxone: (p) => p,
  });
  assert.equal(high.mastervolume, 100);
});

test('loxone projection dedupes a leader that also appears in members', () => {
  const out = toLoxoneZoneState(zoneState(), {
    group: { leader: 3, members: [3, 3, 9] },
    leaderVolume: 20,
    audiopathToLoxone: (p) => p,
  });
  assert.deepEqual(out.syncedzones, [3, 9]);
});

test('loxone projection translates the audiopath to the form the native client expects', () => {
  const out = toLoxoneZoneState(zoneState({ audiopath: 'applemusic:track:1' }), {
    ...noGroup,
    audiopathToLoxone: (p) => `spotify@bridge-${p}`,
  });
  assert.equal(out.audiopath, 'spotify@bridge-applemusic:track:1');
});

test('loxone projection never lets a raw id reach title or station', () => {
  // A background metadata fill can briefly leave an audiopath in these fields, and
  // the native client renders both verbatim.
  const nativeId = toLoxoneZoneState(
    zoneState({ title: 'applemusic:playlist:pl.42', station: 'applemusic:playlist:pl.42' }),
    noGroup,
  );
  assert.equal(nativeId.title, 'Kitchen', 'falls back to the zone name');
  assert.equal(nativeId.station, '');

  const spotifyId = toLoxoneZoneState(
    zoneState({ title: 'spotify:track:abc', station: 'spotify@bridge-x' }),
    noGroup,
  );
  assert.equal(spotifyId.title, 'Kitchen');
  assert.equal(spotifyId.station, '');
});

test('loxone projection leaves real titles and station names alone', () => {
  const out = toLoxoneZoneState(
    zoneState({ title: 'Song', station: 'Radio Paradise' }),
    noGroup,
  );
  assert.equal(out.title, 'Song');
  assert.equal(out.station, 'Radio Paradise');
});

test('loxone projection serialises the equalizer bands to the string the app parses', () => {
  // The core holds ten dB values; only this payload wants them comma-joined.
  const out = toLoxoneZoneState(
    zoneState({ eq: [1, 2, 3, 4, 5, 6, -6, 0, 0, 6] }),
    noGroup,
  );
  assert.equal(out.equalizerSettings, '1,2,3,4,5,6,-6,0,0,6');
});

test('loxone projection emits a null parent, which the server never populates', () => {
  const out = toLoxoneZoneState(zoneState(), noGroup);
  assert.equal(out.parent, null);
});

test('the connect snapshot and the steady-state broadcast send the same shape', () => {
  // The snapshot used to spread ZoneState directly, so it skipped syncedzones,
  // mastervolume and the audiopath/title/station guards: reconnecting during
  // grouped playback showed ungrouped zones, and a raw service-native id could
  // reach a field the native client renders verbatim. Both paths now go through
  // projectForLoxone, so a client cannot see two different payloads for one zone.
  const group = { leader: 3, members: [3, 9] };
  const notifier = new LoxoneWsNotifier(
    { registerConnection: () => {}, unregisterConnection: () => {}, broadcastMessage: () => {} } as any,
    { getGroupByZone: () => group } as any,
  );
  notifier.setZoneStateLookup(() => zoneState({ volume: 55 }));
  notifier.setOutputProtocolLookup(() => 'sendspin');
  notifier.setMixedGroupLookup(() => true);
  notifier.setAudiopathToLoxone((p) => `spotify@bridge-${p}`);

  const state = zoneState({ id: 9, volume: 20, station: 'applemusic:playlist:pl.1' });
  const projected = notifier.projectForLoxone(state);

  assert.deepEqual(projected.syncedzones, [3, 9], 'snapshot carries the sync group');
  assert.equal(projected.mastervolume, 55, "and the leader's volume");
  assert.equal(projected.station, '', 'and blanks a raw id the client would render');
  assert.equal(projected.audiopath, 'spotify@bridge-library://track/9');
  assert.equal(projected.outputProtocol, 'sendspin');
  assert.equal(projected.mixedGroupEnabled, true);
});

test('loxone projection passes an alert event type through the shared type field', () => {
  // `type` is overloaded on purpose: normally a FileType, but an AudioEventType
  // while an alert plays. The client reads it that way and the numbering does not
  // overlap, so the projection must not coerce it to one enum or the other.
  const out = toLoxoneZoneState(zoneState({ type: AudioEventType.Bell }), noGroup);
  assert.equal(out.type, AudioEventType.Bell);

  const normal = toLoxoneZoneState(zoneState({ type: FileType.Playlist }), noGroup);
  assert.equal(normal.type, FileType.Playlist);
});

test('loxone projection carries the fields the native client needs verbatim', () => {
  const out = toLoxoneZoneState(zoneState({ type: FileType.Playlist, icontype: 5 }), noGroup);
  // These are still Loxone's encodings, and the client cannot read anything else.
  assert.equal(out.type, FileType.Playlist);
  assert.equal(out.icontype, 5);
  assert.equal(out.audiotype, AudioType.File);
  assert.equal(out.clientState, 'on');
  // The state calls this `id`; the wire field is `playerid` and has to stay that
  // way — the rename was internal, the protocol did not move.
  assert.equal(out.playerid, 3);
  assert.ok(!('id' in out), 'the Loxone payload has no `id` key');
});
