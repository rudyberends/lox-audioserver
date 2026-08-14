import assert from 'node:assert/strict';
import { test } from './testHarness';
import { commandTopicFilters, parseMqttCommand } from '../src/domain/server/mqttCommands';

// Publishing state was only half the job: an MQTT-only integration could watch but not
// touch, so anything that wanted to act had to fall back to HTTP. These tests pin the
// inbound mapping, which shares its verbs with the HTTP API so the two cannot drift.

const P = 'sonn';
const set = (field: string, payload: string, retained = false) =>
  parseMqttCommand(P, `${P}/zones/3/set/${field}`, payload, retained);
const cmd = (body: unknown, retained = false) =>
  parseMqttCommand(P, `${P}/zones/3/cmd`, JSON.stringify(body), retained);

test('a scalar write becomes the same command the HTTP verb produces', () => {
  // This is the shape a Miniserver or KNX bridge can manage: one value, one topic.
  assert.deepEqual(set('volume', '40'), {
    kind: 'commands',
    zoneId: 3,
    commands: [{ zoneId: 3, command: 'volume', payload: '40' }],
  });
  const pause = set('state', 'pause');
  assert.deepEqual(pause.kind === 'commands' && pause.commands, [
    { zoneId: 3, command: 'pause' },
  ]);
  const repeatAll = set('repeat', 'all');
  assert.deepEqual(repeatAll.kind === 'commands' && repeatAll.commands, [
    { zoneId: 3, command: 'repeat', payload: 'all' },
  ]);
});

test('a replayed command is refused, not obeyed', () => {
  // The retain flag on a *delivered* message means "this is a stored message you are
  // getting because you just subscribed" — not "the publisher asked for retention". MQTT
  // clears it on live delivery (checked against Mosquitto 2.0.18), so this is precisely
  // the replay-on-reconnect case: obeying it makes a zone lurch back after every restart.
  for (const topic of [`${P}/zones/3/set/volume`, `${P}/zones/3/cmd`]) {
    const result = parseMqttCommand(P, topic, topic.endsWith('cmd') ? '{"volume":40}' : '40', true);
    assert.deepEqual(result, { kind: 'ignored', reason: 'retained-command' }, topic);
  }
});

test('a live command published with the retain flag is still applied', () => {
  // Reading the flag as "the publisher wanted retention" would silently drop these, since
  // that is what a naive `mosquitto_pub -r` looks like on arrival: retain=false.
  const result = parseMqttCommand(P, `${P}/zones/3/set/volume`, '40', false);
  assert.equal(result.kind, 'commands');
});

test('what you can read on a topic is what you can write to it', () => {
  // The state tree publishes `playing`/`paused`/`stopped`, so those must be accepted —
  // not only the engine's internal `play`/`pause`/`off`.
  const applied = (raw: string) => {
    const r = set('state', raw);
    return r.kind === 'commands' ? r.commands.map((c) => c.command) : r;
  };
  assert.deepEqual(applied('playing'), ['play']);
  assert.deepEqual(applied('paused'), ['pause']);
  assert.deepEqual(applied('stopped'), ['off']);
  // And the engine's own words keep working, for anyone who read the docs instead.
  assert.deepEqual(applied('play'), ['play']);
  assert.deepEqual(applied('stop'), ['off']);
});

test('a signed volume steps relatively, an unsigned one is absolute', () => {
  // Every physical remote steps relatively, and read-then-write would race with itself.
  const payload = (raw: string) => {
    const r = set('volume', raw);
    return r.kind === 'commands' ? r.commands[0]?.payload : r;
  };
  assert.equal(payload('+5'), '+5');
  assert.equal(payload('-5'), '-5');
  assert.equal(payload('40'), '40');
  // Clamped rather than refused: a bridge sending 150 means "loud", not "error".
  assert.equal(payload('150'), '100');
  assert.equal(payload('-999'), '-100');
});

test('a boolean accepts whatever a scalar bridge actually writes', () => {
  const shuffle = (raw: string) => {
    const r = set('shuffle', raw);
    return r.kind === 'commands' ? r.commands[0]?.payload : r.kind;
  };
  for (const on of ['1', 'true', 'on', 'yes', 'TRUE']) {
    assert.equal(shuffle(on), 'on', on);
  }
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(shuffle(off), 'off', off);
  }
  assert.equal(shuffle('maybe'), 'error');
});

test('play carries a uri, which is why the JSON shape exists at all', () => {
  // A bare-scalar topic has nowhere to put a uri alongside anything else.
  const flat = set('play', 'applemusic:track:1');
  assert.deepEqual(flat, {
    kind: 'commands',
    zoneId: 3,
    commands: [],
    play: { zoneId: 3, uri: 'applemusic:track:1' },
  });
  assert.equal(set('play', '   ').kind, 'error');

  const json = cmd({ play: 'library://track/9' });
  assert.equal(json.kind === 'commands' && json.play?.uri, 'library://track/9');
});

test('one JSON message can carry several fields, applied in a sane order', () => {
  // Powering on has to happen before the volume lands, and a publisher should not have to
  // reason about JSON key order to get that.
  const result = cmd({ volume: 40, power: 'on' });
  assert.equal(result.kind, 'commands');
  const commands = result.kind === 'commands' ? result.commands.map((c) => c.command) : [];
  assert.deepEqual(commands, ['on', 'volume']);
});

test('state is applied after play, so one message does not fight itself', () => {
  const result = cmd({ play: 'library://track/9', state: 'playing' });
  assert.equal(result.kind, 'commands');
  if (result.kind !== 'commands') return;
  assert.ok(result.play, 'still starts the content');
  assert.deepEqual(result.commands.map((c) => c.command), ['play']);
});

test('a bad value is refused rather than partly applied', () => {
  // Half-applying a message is worse than refusing it: the zone ends up in a state the
  // publisher never asked for and cannot see it happened.
  for (const body of [{ volume: 'loud' }, { repeat: 'sometimes' }, { power: 'maybe' }]) {
    assert.equal(cmd(body).kind, 'error', JSON.stringify(body));
  }
  assert.deepEqual(parseMqttCommand(P, `${P}/zones/3/cmd`, 'not json', false), {
    kind: 'error',
    reason: 'invalid-json',
  });
  // An array is valid JSON but not a command object.
  assert.equal(parseMqttCommand(P, `${P}/zones/3/cmd`, '[1,2]', false).kind, 'error');
});

test('an unknown field is ignored, not treated as an error', () => {
  // Our own state tree publishes topics like track/title that nobody can write; someone
  // echoing them back should be dropped quietly rather than logged as a failure.
  assert.deepEqual(set('title', 'Song'), {
    kind: 'ignored',
    reason: 'unknown-field:title',
  });
  assert.equal(cmd({ title: 'Song' }).kind, 'ignored', 'nothing to do');
});

test('only command topics are claimed', () => {
  for (const topic of [
    `${P}/zones/3`, // the state document
    `${P}/zones/3/volume`, // the state scalar, not `set/volume`
    `${P}/server/online`,
    `other/zones/3/set/volume`, // a different prefix
    `${P}/zones/abc/set/volume`, // not a zone id
    `${P}/zones/3/set`, // no field
  ]) {
    assert.deepEqual(
      parseMqttCommand(P, topic, '40', false),
      { kind: 'ignored', reason: 'not-a-command-topic' },
      topic,
    );
  }
});

test('the subscription covers both shapes and nothing else', () => {
  const filters = commandTopicFilters('attic');
  assert.deepEqual(filters, ['attic/zones/+/set/+', 'attic/zones/+/cmd']);
  // Notably not `attic/#`, which would make us receive our own published state back.
  assert.ok(!filters.some((f) => f.includes('#')));
});

test('next and previous ignore whatever value a bridge sends', () => {
  // A KNX or Loxone bridge typically writes `1` to trigger something; there is no
  // meaningful value for "skip", so the payload is irrelevant.
  for (const raw of ['1', 'true', '', 'go']) {
    const r = set('next', raw);
    assert.deepEqual(r.kind === 'commands' && r.commands, [{ zoneId: 3, command: 'queueplus' }], raw);
  }
  const prev = set('previous', '1');
  assert.deepEqual(prev.kind === 'commands' && prev.commands, [
    { zoneId: 3, command: 'queueminus' },
  ]);
});
