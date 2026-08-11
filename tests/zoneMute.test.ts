import assert from 'node:assert/strict';
import { test } from './testHarness';
import { handleZoneCommand } from '../src/application/zones/playback/commandHandlers';
import { mapZoneCommandToIntent } from '../src/application/zones/playback/commandIntents';
import { applyZonePatch } from '../src/domain/zones/reducer';
import { buildInitialState } from '../src/application/zones/helpers/stateHelpers';
import { parseMqttCommand } from '../src/domain/server/mqttCommands';
import type { ZoneContext } from '../src/application/zones/internal/zoneTypes';
import type { ZoneState } from '../src/domain/zones/zoneState';
import type { ZoneConfig } from '../src/domain/config/types';

// Mute is silence with a way back, which is the whole reason it is not just "volume 0":
// the level has to survive being silenced, and no caller should have to unmute before
// turning something up. HA's volume_mute is the immediate consumer, but a remote's mute
// key and a wall button on an MQTT topic want exactly the same behaviour.

const zoneConfig = {
  id: 3,
  name: 'Kitchen',
  sourceMac: 'aa',
  volumes: { maxVolume: 100, default: 20, volstep: 1 },
} as unknown as ZoneConfig;

type Harness = {
  ctx: ZoneContext;
  patches: Array<Partial<ZoneState>>;
  dispatched: number[];
  playerVolumes: number[];
  send: (command: string, payload?: string) => void;
};

function harness(overrides: Partial<ZoneState> = {}, config: ZoneConfig = zoneConfig): Harness {
  const patches: Array<Partial<ZoneState>> = [];
  const dispatched: number[] = [];
  const playerVolumes: number[] = [];

  const ctx = {
    id: 3,
    name: 'Kitchen',
    config,
    state: { ...buildInitialState(config), volume: 40, ...overrides },
    inputMode: 'queue',
    outputs: [],
    queue: { items: [], shuffle: false, repeat: 0, currentIndex: 0, authority: 'local' },
    queueController: { current: () => null, currentIndex: () => -1 },
    player: { setVolume: (level: number) => playerVolumes.push(level) },
  } as unknown as ZoneContext;

  const coordinator = {
    log: { debug: () => undefined, spam: () => undefined, warn: () => undefined },
    // Real reducer, so the tests see the state a consumer would rather than the raw patch.
    applyPatch: (_zoneId: number, patch: Partial<ZoneState>) => {
      patches.push(patch);
      ctx.state = applyZonePatch(ctx.state, patch);
    },
    dispatchVolume: (_ctx: ZoneContext, _outputs: unknown, volume: number) => dispatched.push(volume),
  } as unknown as Parameters<typeof handleZoneCommand>[0]['coordinator'];

  return {
    ctx,
    patches,
    dispatched,
    playerVolumes,
    send: (command, payload) =>
      handleZoneCommand({ coordinator, ctx, zoneId: 3, command, payload }),
  };
}

test('muting silences the outputs and unmuting gives the level back', () => {
  const h = harness({ volume: 40 });

  h.send('mute', '1');
  assert.equal(h.ctx.state.volume, 0);
  assert.equal(h.ctx.state.muted, true);
  // Mute is not a separate signal to an output — an output handed zero is silent, and
  // that is the whole of it. A zone whose output never heard about it would keep playing.
  assert.deepEqual(h.dispatched, [0]);
  assert.deepEqual(h.playerVolumes, [0]);

  h.send('mute', '0');
  assert.equal(h.ctx.state.volume, 40);
  assert.equal(h.ctx.state.muted, false);
  assert.deepEqual(h.dispatched, [0, 40]);
});

test('mute toggles when the command carries no value, like a remote key', () => {
  const h = harness({ volume: 35 });

  h.send('mute');
  assert.equal(h.ctx.state.muted, true);
  h.send('mute');
  assert.equal(h.ctx.state.muted, false);
  assert.equal(h.ctx.state.volume, 35);
});

test('muting twice is harmless, so a retried request cannot un-silence a zone', () => {
  const h = harness({ volume: 40 });

  h.send('mute', '1');
  h.send('mute', '1');

  assert.equal(h.ctx.state.muted, true);
  assert.equal(h.ctx.state.volume, 0);
  // The second one must not remember zero as the level to come back to.
  h.send('mute', '0');
  assert.equal(h.ctx.state.volume, 40);
});

test('unmuting a zone that was already silent goes to its default, not back to silence', () => {
  const h = harness({ volume: 0 });

  h.send('mute', '1');
  h.send('mute', '0');

  // Restoring 0 would leave a zone that looks unmuted and plays nothing, with the only
  // way out being a volume command the user has no reason to expect they need.
  assert.equal(h.ctx.state.volume, 20);
  assert.equal(h.ctx.state.muted, false);
});

test('turning the volume up clears mute, without anyone having to unmute first', () => {
  const h = harness({ volume: 40 });

  h.send('mute', '1');
  h.send('volume', '55');

  assert.equal(h.ctx.state.volume, 55);
  assert.equal(h.ctx.state.muted, false);
});

test('a relative step out of mute lands on the step, not back on the old level', () => {
  const h = harness({ volume: 40 });

  h.send('mute', '1');
  h.send('volume', '+5');

  // Relative commands work off the current level, and while muted that is zero. Anything
  // else would make a remote's volume-up jump to a value nobody chose.
  assert.equal(h.ctx.state.volume, 5);
  assert.equal(h.ctx.state.muted, false);
});

test('mute is honoured through the zone volume cap', () => {
  const capped = { ...zoneConfig, volumes: { maxVolume: 70, default: 20, volstep: 1 } } as ZoneConfig;
  const h = harness({ volume: 65 }, capped);

  h.send('mute', '1');
  h.send('mute', '0');

  // The remembered level is below the cap and must not be re-clamped upward or downward.
  assert.equal(h.ctx.state.volume, 65);
});

test('the reducer never lets a zone be muted and audible at once', () => {
  const state = { ...buildInitialState(zoneConfig), volume: 0, muted: true };

  // Any path that makes a zone audible clears mute: a device reporting its own knob, an
  // alert restoring a level, a state controller syncing from a Sonos group.
  assert.equal(applyZonePatch(state, { volume: 30 }).muted, false);
  // Still silent, so still muted.
  assert.equal(applyZonePatch(state, { volume: 0 }).muted, true);
  // An explicit flag wins, which is how mute sets zero and mutes in one patch.
  assert.equal(applyZonePatch(state, { volume: 0, muted: true }).muted, true);
  assert.equal(applyZonePatch(state, { volume: 30, muted: true }).muted, true);
});

test('a zone starts unmuted', () => {
  assert.equal(buildInitialState(zoneConfig).muted, false);
});

test('the mute command reads the values every surface writes', () => {
  const forms: Array<[string | undefined, boolean | null]> = [
    ['1', true],
    ['on', true],
    ['true', true],
    ['yes', true],
    ['0', false],
    ['off', false],
    ['false', false],
    [undefined, null],
    ['toggle', null],
  ];
  for (const [payload, expected] of forms) {
    const intent = mapZoneCommandToIntent({ command: 'mute', payload, mode: 'queue' });
    assert.deepEqual(intent, { kind: 'Mute', muted: expected }, `payload ${String(payload)}`);
  }
  // A value nobody can mean is refused rather than guessed at.
  assert.equal(mapZoneCommandToIntent({ command: 'mute', payload: 'perhaps', mode: 'queue' }), null);
});

test('MQTT writes mute with the same verb the HTTP route uses', () => {
  const set = (payload: string) =>
    parseMqttCommand('sonn', 'sonn/zones/3/set/muted', payload, false);

  assert.deepEqual(set('1'), {
    kind: 'commands',
    zoneId: 3,
    commands: [{ zoneId: 3, command: 'mute', payload: '1' }],
  });
  // An empty payload toggles: a wall button wired to a topic has no value to send.
  assert.deepEqual(set('').kind === 'commands' && set('').commands, [
    { zoneId: 3, command: 'mute', payload: 'toggle' },
  ]);
  assert.equal(set('perhaps').kind, 'error');

  // One message carrying both applies the level first, so the mute is not undone by the
  // volume write that came with it.
  const both = parseMqttCommand(
    'sonn',
    'sonn/zones/3/cmd',
    JSON.stringify({ muted: true, volume: 40 }),
    false,
  );
  assert.deepEqual(
    both.kind === 'commands' && both.commands.map((c) => c.command),
    ['volume', 'mute'],
  );
});
