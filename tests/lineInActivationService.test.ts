import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from './testHarness';
import { LineInActivationService } from '../src/application/inputs/lineInActivationService';
import type { LineInSession, LineInSourcePort } from '../src/ports/LineInSourcePort';
import type { ZoneManagerFacade } from '../src/application/zones/createZoneManager';

// This path had no coverage while it lived inside the Loxone command handlers, and
// several of its behaviours are subtle enough to look like bugs: the two audiopath
// spellings, the watch that deliberately outlives playback, and a stop that must
// not withdraw the want. These tests pin all three so the extraction — and anything
// after it — cannot quietly change them.

type Call = { fn: string; args: unknown[] };

function createSource(): LineInSourcePort & {
  calls: Call[];
  sessions: Map<string, LineInSession>;
  fireStart: (inputId: string) => void;
  fireStop: (inputId: string) => void;
  controls: Map<string, string[]>;
} {
  const calls: Call[] = [];
  const sessions = new Map<string, LineInSession>();
  const controls = new Map<string, string[]>();
  const starts = new Map<string, Set<() => void>>();
  const stops = new Map<string, Set<() => void>>();
  const record = (fn: string, ...args: unknown[]) => calls.push({ fn, args });

  return {
    calls,
    sessions,
    controls,
    fireStart: (inputId) => starts.get(inputId)?.forEach((listener) => listener()),
    fireStop: (inputId) => stops.get(inputId)?.forEach((listener) => listener()),
    getSession: (inputId) => sessions.get(inputId) ?? null,
    onStart: (inputId, listener) => {
      record('onStart', inputId);
      const set = starts.get(inputId) ?? new Set();
      set.add(listener);
      starts.set(inputId, set);
      return () => {
        record('offStart', inputId);
        set.delete(listener);
      };
    },
    onStop: (inputId, listener) => {
      record('onStop', inputId);
      const set = stops.get(inputId) ?? new Set();
      set.add(listener);
      stops.set(inputId, set);
      return () => {
        record('offStop', inputId);
        set.delete(listener);
      };
    },
    sendCommand: (inputId, command, args) => record('sendCommand', inputId, command, args),
    markWanted: (inputId) => record('markWanted', inputId),
    clearWanted: (inputId) => record('clearWanted', inputId),
    requestStart: (inputId) => record('requestStart', inputId),
    requestStop: (inputId) => record('requestStop', inputId),
    getControlSupport: (inputId) => (controls.get(inputId) ?? null) as never,
  };
}

function createZones(): ZoneManagerFacade & { patches: Array<Record<string, unknown>>; played: unknown[] } {
  const state: Record<number, Record<string, unknown>> = {
    12: { playerid: 12, name: 'Living', volume: 30, audiopath: '' },
  };
  const patches: Array<Record<string, unknown>> = [];
  const played: unknown[] = [];
  return {
    patches,
    played,
    getZoneState: (zoneId: number) => (state[zoneId] ?? null) as never,
    applyPatch: (zoneId: number, patch: Record<string, unknown>) => {
      patches.push({ zoneId, ...patch });
      Object.assign(state[zoneId] ?? {}, patch);
    },
    inputs: {
      playInputSource: (zoneId: number, kind: string, source: unknown, metadata: Record<string, unknown>) => {
        played.push({ zoneId, kind, source, metadata });
        // Mirror the real path: a started input leaves the `//` form in the state.
        Object.assign(state[zoneId] ?? {}, { audiopath: metadata.audiopath });
      },
    },
  } as unknown as ZoneManagerFacade & { patches: Array<Record<string, unknown>>; played: unknown[] };
}

function createConfig(inputs: Array<Record<string, unknown>> = [{ id: 'in-1', name: 'Turntable', iconType: 7 }]) {
  return {
    getConfig: () => ({
      system: { audioserver: { macId: 'AA:BB' } },
      zones: [{ id: 12, name: 'Living', sourceMac: 'ZONE-MAC' }],
      inputs: { lineIn: { inputs } },
    }),
  } as never;
}

function createService(options: { inputs?: Array<Record<string, unknown>> } = {}) {
  const source = createSource();
  const zones = createZones();
  const service = new LineInActivationService(createConfig(options.inputs), source);
  service.initOnce({ zoneManager: zones });
  return { service, source, zones };
}

test('listLineInInputs resolves ids and names, filling defaults from position', () => {
  const { service } = createService({ inputs: [{ name: 'Turntable' }, { id: 'custom' }] });
  assert.deepEqual(service.listLineInInputs(), [
    { id: 'AA:BB#1000001', name: 'Turntable', iconType: 0, index: 0 },
    { id: 'custom', name: 'LineIn2', iconType: 0, index: 1 },
  ]);
});

test('activating with no audio yet parks the zone on "No Signal detected"', () => {
  const { service, source, zones } = createService();
  service.activateLineIn(12, 'in-1');

  const patch = zones.patches.at(-1)!;
  assert.equal(patch.title, 'No Signal detected');
  assert.equal(patch.mode, 'pause');
  // The single-colon form, deliberately: only a started input gets `//`.
  assert.equal(patch.audiopath, 'linein:in-1');
  assert.deepEqual(zones.played, [], 'nothing may be played without a stream');
  // The want is parked first, so a polling bridge sees it on its next status post.
  assert.deepEqual(
    source.calls.filter((c) => c.fn === 'markWanted' || c.fn === 'requestStart').map((c) => c.fn),
    ['markWanted', 'requestStart'],
  );
});

test('activating with a live session starts playback with the // audiopath', () => {
  const { service, source, zones } = createService();
  source.sessions.set('in-1', {
    id: 'in-1',
    stream: new PassThrough(),
    format: { sampleRate: 48000, channels: 2, bitDepth: 16, pcmFormat: 's16le' },
  });

  service.activateLineIn(12, 'in-1');

  assert.equal(zones.played.length, 1);
  const play = zones.played[0] as { source: Record<string, unknown>; metadata: Record<string, unknown> };
  assert.equal(play.source.path, 'linein:in-1');
  assert.equal(play.source.sampleRate, 48000);
  assert.equal(play.source.realTime, true);
  // The two spellings differ on purpose; downstream audiotype checks key on `//`.
  assert.equal(play.metadata.audiopath, 'linein://in-1');
  assert.equal(zones.patches.at(-1)!.title, 'Turntable');
  assert.equal(zones.patches.at(-1)!.mode, 'play');
});

test('the session format wins over the configured sample rate', () => {
  const { service, source, zones } = createService({
    inputs: [{ id: 'in-1', name: 'Turntable', source: { sample_rate: 44100 } }],
  });
  source.sessions.set('in-1', {
    id: 'in-1',
    stream: new PassThrough(),
    format: { sampleRate: 96000, channels: 2, bitDepth: 24, pcmFormat: 's24le' },
  });
  service.activateLineIn(12, 'in-1');
  const play = zones.played[0] as { source: Record<string, unknown> };
  assert.equal(play.source.sampleRate, 96000);
  assert.equal(play.source.format, 's24le');
  void zones;
});

test('a source with transport controls presents as a file, not a jack', () => {
  const { service, source, zones } = createService();
  source.controls.set('in-1', ['play', 'pause']);
  service.activateLineIn(12, 'in-1');
  const patch = zones.patches.at(-1)!;
  // AudioType.File (0) / FileType.File (2) rather than the LineIn pair (3 / 6).
  assert.equal(patch.audiotype, 0);
  assert.equal(patch.type, 2);
});

test('a plain jack keeps the line-in audio type', () => {
  const { service, zones } = createService();
  service.activateLineIn(12, 'in-1');
  const patch = zones.patches.at(-1)!;
  assert.equal(patch.audiotype, 3);
  assert.equal(patch.type, 6);
});

test('audio arriving later starts playback through the armed watch', () => {
  const { service, source, zones } = createService();
  service.activateLineIn(12, 'in-1');
  assert.deepEqual(zones.played, []);

  source.sessions.set('in-1', { id: 'in-1', stream: new PassThrough() });
  source.fireStart('in-1');

  assert.equal(zones.played.length, 1, 'the watch must start playback when audio appears');
});

test('the watch ignores a start once the zone has moved on', () => {
  const { service, source, zones } = createService();
  service.activateLineIn(12, 'in-1');
  // The zone is now playing something else entirely.
  zones.applyPatch(12, { audiopath: 'spotify:track:x' } as never, true);
  zones.played.length = 0;

  source.sessions.set('in-1', { id: 'in-1', stream: new PassThrough() });
  source.fireStart('in-1');

  assert.deepEqual(zones.played, [], 'a stale watch must not resurrect line-in playback');
});

test('stopping stops the stream but keeps the want — the zone may get it back', () => {
  const { service, source } = createService();
  source.sessions.set('in-1', { id: 'in-1', stream: new PassThrough() });
  service.activateLineIn(12, 'in-1');
  source.calls.length = 0;

  source.fireStop('in-1');

  const fns = source.calls.map((c) => c.fn);
  assert.ok(fns.includes('requestStop'), 'the sendspin source must be told to stop');
  assert.equal(fns.includes('clearWanted'), false, 'the want must survive a stop');
});

test('a stop for an input the zone no longer holds is ignored', () => {
  const { service, source, zones } = createService({
    inputs: [{ id: 'in-1', name: 'Turntable' }, { id: 'in-2', name: 'CD' }],
  });
  source.sessions.set('in-1', { id: 'in-1', stream: new PassThrough() });
  service.activateLineIn(12, 'in-1');
  // Zone switches to the other input; the old stop handler must go quiet.
  source.sessions.set('in-2', { id: 'in-2', stream: new PassThrough() });
  service.activateLineIn(12, 'in-2');
  const before = zones.patches.length;

  source.fireStop('in-1');

  assert.equal(zones.patches.length, before, 'a superseded input must not patch the zone');
});

test('switching inputs withdraws the want from the one left behind', () => {
  const { service, source } = createService({
    inputs: [{ id: 'in-1', name: 'Turntable' }, { id: 'in-2', name: 'CD' }],
  });
  service.activateLineIn(12, 'in-1');
  source.calls.length = 0;

  service.activateLineIn(12, 'in-2');

  // Only when a zone points elsewhere is the want actually dropped.
  assert.deepEqual(
    source.calls.filter((c) => c.fn === 'clearWanted').map((c) => c.args[0]),
    ['in-1'],
  );
  assert.deepEqual(
    source.calls.filter((c) => c.fn === 'markWanted').map((c) => c.args[0]),
    ['in-2'],
  );
});

test('re-selecting the same input keeps its watch rather than rearming it', () => {
  const { service, source } = createService();
  service.activateLineIn(12, 'in-1');
  const armedOnce = source.calls.filter((c) => c.fn === 'onStart').length;

  service.activateLineIn(12, 'in-1');

  assert.equal(
    source.calls.filter((c) => c.fn === 'onStart').length,
    armedOnce,
    'the sticky watch must not be re-armed for the same input',
  );
});

test('a caller may override the name and icon it already resolved', () => {
  const { service, source, zones } = createService();
  source.sessions.set('unknown-id', { id: 'unknown-id', stream: new PassThrough() });

  service.activateLineIn(12, 'unknown-id', { title: 'LineIn1', iconType: 3 });

  const patch = zones.patches.at(-1)!;
  // Without the override an unknown id resolves to the no-signal title, which is
  // right for an HTTP caller but not for the Loxone client's own fallbacks.
  assert.equal(patch.title, 'LineIn1');
  assert.equal(patch.icontype, 3);
});

test('the no-signal branch shows the no-signal title regardless of the override', () => {
  const { service, zones } = createService();
  service.activateLineIn(12, 'in-1', { title: 'Turntable', iconType: 7 });
  const patch = zones.patches.at(-1)!;
  // Pinning existing behaviour: without a stream the title is the state, not the name.
  assert.equal(patch.title, 'No Signal detected');
  assert.equal(patch.icontype, 7, 'the icon still comes from the caller');
});

test('a controllable device is told to start on selection', () => {
  const { service, source } = createService({
    inputs: [{ id: 'in-1', name: 'BeoSound 9000', controllable: true }],
  });

  service.activateLineIn(12, 'in-1');

  const sent = source.calls.filter((c) => c.fn === 'sendCommand');
  assert.deepEqual(sent.map((c) => [c.args[0], c.args[1]]), [['in-1', 'start']]);
  // Sent on selection, not on first audio — waiting for audio is the deadlock,
  // since nothing arrives until the device is told to go.
  const order = source.calls.map((c) => c.fn);
  assert.ok(order.indexOf('sendCommand') < order.indexOf('onStart'));
});

test('a controllable device is told to stop when the zone moves to another input', () => {
  const { service, source } = createService({
    inputs: [
      { id: 'in-1', name: 'BeoSound 9000', controllable: true },
      { id: 'in-2', name: 'Turntable' },
    ],
  });
  service.activateLineIn(12, 'in-1');
  source.calls.length = 0;

  service.activateLineIn(12, 'in-2');

  // Otherwise the CD keeps spinning into a room now playing something else.
  assert.deepEqual(
    source.calls.filter((c) => c.fn === 'sendCommand').map((c) => [c.args[0], c.args[1]]),
    [['in-1', 'stop']],
  );
});

test('releasing an input stops the device and withdraws the want', () => {
  const { service, source } = createService({
    inputs: [{ id: 'in-1', name: 'BeoSound 9000', controllable: true }],
  });
  service.activateLineIn(12, 'in-1');
  source.calls.length = 0;

  service.releaseLineIn('in-1');

  const fns = source.calls.map((c) => c.fn);
  assert.ok(fns.includes('sendCommand'), 'the device must be told to stop');
  assert.ok(fns.includes('clearWanted'), 'the want must be withdrawn');
});

test('the stop is queued after the want is withdrawn, not before', () => {
  const { service, source } = createService({
    inputs: [{ id: 'in-1', name: 'BeoSound 9000', controllable: true }],
  });
  service.activateLineIn(12, 'in-1');
  source.calls.length = 0;

  service.releaseLineIn('in-1');

  // Withdrawing the want also drops queued commands for that input, so a stop
  // queued first would be thrown away by the very next call — which is exactly
  // how start and stop both silently stopped reaching the bridge once.
  const order = source.calls.map((c) => c.fn);
  assert.ok(
    order.indexOf('clearWanted') < order.indexOf('sendCommand'),
    `clearWanted must come first, got: ${order.join(', ')}`,
  );
});

test('an uncontrollable input is never sent anything', () => {
  const { service, source } = createService();

  service.activateLineIn(12, 'in-1');
  service.releaseLineIn('in-1');
  const sent = service.sendCommandIfControllable('in-1', 'next');

  assert.equal(sent, false, 'the call must report it did nothing');
  // A queued command for a turntable would sit until some later selection drained
  // it and drove hardware nobody asked for.
  assert.deepEqual(source.calls.filter((c) => c.fn === 'sendCommand'), []);
});

test('isControllable reflects the input configuration', () => {
  const { service } = createService({
    inputs: [{ id: 'in-1', name: 'Deck', controllable: true }, { id: 'in-2', name: 'Jack' }],
  });
  assert.equal(service.isControllable('in-1'), true);
  assert.equal(service.isControllable('in-2'), false);
  assert.equal(service.isControllable('nope'), false);
});

test('the zone source mac wins over the system one', () => {
  const { service, zones } = createService();
  service.activateLineIn(12, 'in-1');
  assert.equal(zones.patches.at(-1)!.sourceName, 'ZONE-MAC');
});
