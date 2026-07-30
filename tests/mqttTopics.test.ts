import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  DEFAULT_TOPIC_PREFIX,
  availabilityTopic,
  progressMessages,
  sanitizeTopicPrefix,
  zoneMessages,
} from '../src/domain/server/mqttTopics';
import type { ApiZoneState } from '../src/domain/zones/apiTypes';
import { isPublicAdminApiRoute } from '../src/adapters/http/adminApi/auth/adminSessionStore';

// The MQTT tree publishes our own API vocabulary, not Loxone's. Mirroring Loxone here
// would freeze the field names we just removed from the internal state into a brand-new
// surface, which is the mistake this whole decoupling exists to avoid.

function zone(overrides: Partial<ApiZoneState> = {}): ApiZoneState {
  return {
    id: 3,
    name: 'Kitchen',
    state: 'playing',
    powerState: { power: 'on', target: 'on', managed: false, offDelayMs: null },
    position: 42,
    duration: 210,
    volume: 40,
    volumeLimits: { max: 100, default: 20, step: 1 },
    repeat: 'off',
    shuffle: false,
    track: { title: 'Song', artist: 'Artist', album: 'Album', coverUrl: 'http://c' },
    source: { kind: 'track', name: 'Apple Music', id: 'applemusic:track:1', seekable: true },
    group: null,
    output: { protocol: 'sendspin', device: { id: 'aa', name: 'Living', connected: true } },
    ...overrides,
  } as ApiZoneState;
}

const asMap = (messages: Array<{ topic: string; payload: string }>) =>
  new Map(messages.map((m) => [m.topic, m.payload]));

test('a zone is published as one JSON document plus flat scalars', () => {
  const messages = zoneMessages('sonn', zone());
  const map = asMap(messages);

  // The JSON topic is the full API contract, byte-identical to what SSE delivers.
  assert.deepEqual(JSON.parse(map.get('sonn/zones/3')!), zone());

  // The scalars exist for consumers that cannot parse JSON — a Miniserver, a KNX
  // gateway — which is most of why the plugin had to build its own bridge.
  assert.equal(map.get('sonn/zones/3/state'), 'playing');
  assert.equal(map.get('sonn/zones/3/power/state'), 'on');
  assert.equal(map.get('sonn/zones/3/power/target'), 'on');
  assert.equal(map.get('sonn/zones/3/power/managed'), '0');
  assert.equal(map.get('sonn/zones/3/power/idleTimeoutMs'), '');
  assert.equal(map.get('sonn/zones/3/volume'), '40');
  assert.equal(map.get('sonn/zones/3/track/title'), 'Song');
  assert.equal(map.get('sonn/zones/3/source/name'), 'Apple Music');
  assert.equal(map.get('sonn/zones/3/output/protocol'), 'sendspin');
});

test('the field names are ours, not Loxone\'s', () => {
  const topics = zoneMessages('sonn', zone()).map((m) => m.topic);
  for (const loxone of ['mode', 'plrepeat', 'plshuffle', 'audiopath', 'audiotype', 'qindex']) {
    assert.ok(
      !topics.some((topic) => topic.endsWith(`/${loxone}`)),
      `${loxone} is Loxone vocabulary and must not appear`,
    );
  }
  assert.ok(topics.includes('sonn/zones/3/state'), 'state, not mode');
  assert.ok(topics.includes('sonn/zones/3/repeat'), 'repeat, not plrepeat');
});

test('everything about a zone is retained, so a late consumer sees current state', () => {
  // Needing the next change before you know anything is precisely what forced polling.
  assert.ok(zoneMessages('sonn', zone()).every((m) => m.retain));
});

test('an empty field is published as blank, not omitted and not "null"', () => {
  // A consumer's display must clear when playback stops rather than keep the last track,
  // and a topic that vanishes leaves the old retained value in place.
  const map = asMap(zoneMessages('sonn', zone({ track: null, source: null, output: null })));
  assert.equal(map.get('sonn/zones/3/track/title'), '');
  assert.equal(map.get('sonn/zones/3/source/name'), '');
  assert.equal(map.get('sonn/zones/3/output/protocol'), '');
  assert.ok(map.has('sonn/zones/3/track/artist'), 'still published');
});

test('booleans are 1 and 0, for consumers wiring them to a digital input', () => {
  const on = asMap(zoneMessages('sonn', zone({ shuffle: true })));
  assert.equal(on.get('sonn/zones/3/shuffle'), '1');
  const off = asMap(zoneMessages('sonn', zone({ shuffle: false })));
  assert.equal(off.get('sonn/zones/3/shuffle'), '0');
});

test('grouping is readable without parsing the group object', () => {
  const leader = asMap(zoneMessages('sonn', zone({ group: { leader: 3, members: [3, 7] } })));
  assert.equal(leader.get('sonn/zones/3/group/leader'), '3');
  assert.equal(leader.get('sonn/zones/3/group/isLeader'), '1');

  const member = asMap(
    zoneMessages('sonn', zone({ id: 7, group: { leader: 3, members: [3, 7] } })),
  );
  assert.equal(member.get('sonn/zones/7/group/leader'), '3');
  assert.equal(member.get('sonn/zones/7/group/isLeader'), '0');

  const alone = asMap(zoneMessages('sonn', zone({ group: null })));
  assert.equal(alone.get('sonn/zones/3/group/leader'), '');
});

test('a progress tick moves only the scalar, and is not retained', () => {
  // Rewriting a ~550-byte retained document every second per zone to advance a clock is
  // the cost this feature exists to avoid; a stale retained position is worse than none.
  const messages = progressMessages('sonn', 3, 99);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.topic, 'sonn/zones/3/position');
  assert.equal(messages[0]!.payload, '99');
  assert.equal(messages[0]!.retain, false);
});

test('the prefix cannot break out of its own subtree', () => {
  // `#` and `+` are wildcards and a slash silently adds a level, which would put this
  // server's topics somewhere the admin UI does not claim they are.
  assert.equal(sanitizeTopicPrefix('house/#'), 'house');
  assert.equal(sanitizeTopicPrefix('+/attic'), 'attic');
  assert.equal(sanitizeTopicPrefix('/leading/'), 'leading');
  // Absent or blank falls back rather than producing topics starting with `/`.
  for (const empty of [undefined, '', '   ', '#', '/']) {
    assert.equal(sanitizeTopicPrefix(empty), DEFAULT_TOPIC_PREFIX, JSON.stringify(empty));
  }
  assert.equal(sanitizeTopicPrefix('  attic  '), 'attic', 'trimmed');
});

test('the prefix a consumer configured is the prefix used', () => {
  const map = asMap(zoneMessages('attic', zone()));
  assert.ok(map.has('attic/zones/3'));
  assert.equal(availabilityTopic('attic'), 'attic/server/online');
});

test('the broker password is never reachable without a session', () => {
  // The status route returns config; a leak here would hand out broker credentials to
  // anyone on the network, which is exactly the hole /spotify/librespot/credentials was.
  for (const method of ['GET', 'POST', 'PUT']) {
    assert.equal(isPublicAdminApiRoute('/mqtt/status', method), false, method);
    assert.equal(isPublicAdminApiRoute('/mqtt/config', method), false, method);
  }
});
