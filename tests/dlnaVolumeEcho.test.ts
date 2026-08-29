import assert from 'node:assert/strict';
import { test } from './testHarness';
import { DlnaOutput } from '../src/adapters/outputs/dlna/dlnaOutput';
import type { ConfigPort } from '../src/ports/ConfigPort';
import type { OutputPorts } from '../src/adapters/outputs/outputPorts';
import type { PlaybackSession } from '../src/application/playback/audioManager';
import { makeOutputPortsFake } from './fakes/outputPorts';

/**
 * Issue #358: a Bose SoundTouch flips Mute alongside every volume write and moderates its GENA
 * events by about a second. The old guard remembered only the last outbound level, so with two
 * levels in flight each delayed echo compared against the other one, passed for a user change,
 * was re-sent, and produced the next echo — the room oscillated 0↔21 at 1 Hz. And because the
 * Volume and Mute branches each answered the same NOTIFY, every cycle sent two SetVolumes.
 * These tests replay that log through onRemoteRendering and pin the repaired decisions.
 */

const configPortStub = {
  getSystemConfig: () => ({ audioserver: { ip: '127.0.0.1' } }),
  getConfig: () => ({ system: { audioserver: { ip: '127.0.0.1' } }, zones: [] }),
  getZones: () => [],
} as unknown as ConfigPort;

type RenderingEvent = { volume?: number; muted?: boolean };
type Harness = {
  output: DlnaOutput;
  commands: Array<{ command: string; payload: string }>;
  soapVolumes: number[];
  emit: (event: RenderingEvent) => void;
};

const makeOutput = (opts: { zoneVolume?: number } = {}): Harness => {
  const commands: Array<{ command: string; payload: string }> = [];
  const soapVolumes: number[] = [];
  const base = makeOutputPortsFake(configPortStub);
  const ports: OutputPorts = {
    ...base,
    zoneManager: {
      ...base.zoneManager,
      getZoneState: () =>
        (typeof opts.zoneVolume === 'number' ? { volume: opts.zoneVolume } : undefined) as never,
      handleCommand: (_zoneId: number, command: string, payload?: string) => {
        commands.push({ command, payload: payload ?? '' });
      },
    },
  };
  // No host and no auto-discovery: nothing may reach the network from a test.
  const output = new DlnaOutput(1, 'Büro', { autoDiscover: false }, ports);
  (output as unknown as { cp: unknown }).cp = {
    setVolume: async (level: number) => {
      soapVolumes.push(level);
      return true;
    },
    stop: async () => true,
    dispose: () => undefined,
  };
  const emit = (event: RenderingEvent): void => {
    (output as unknown as { onRemoteRendering: (e: RenderingEvent) => void }).onRemoteRendering(event);
  };
  return { output, commands, soapVolumes, emit };
};

test('the issue #358 loop: delayed echoes of our own writes are never answered', async () => {
  const { output, commands, emit } = makeOutput();
  // The renderer's initial GENA state dump seeds without being adopted as a user change.
  emit({ volume: 21, muted: false });
  assert.equal(commands.length, 0);

  // Play start dispatches the zone's (poisoned) level; the Bose then asserts its own 21.
  await output.setVolume(0);
  emit({ volume: 21, muted: false });
  assert.deepEqual(commands, [{ command: 'volume_set', payload: '21' }]);

  // The zone adopts 21 and dispatches it back to the output.
  await output.setVolume(21);

  // Now the moderated echoes of BOTH writes trail in — each must die here, not ping-pong.
  emit({ volume: 0, muted: true });
  emit({ volume: 21, muted: false });
  emit({ volume: 0, muted: true });
  assert.deepEqual(commands, [{ command: 'volume_set', payload: '21' }]);
});

test('one NOTIFY is one zone command, even when Volume and Mute flip together', () => {
  const { commands, emit } = makeOutput();
  emit({ volume: 21, muted: false });
  // A genuine device-side change that flips both fields (Bose reports Mute=1 at volume 0).
  emit({ volume: 0, muted: true });
  assert.deepEqual(commands, [{ command: 'volume_set', payload: '0' }]);
});

test('keep-alive snapshots with an unchanged level stay silent (issue #314)', () => {
  const { commands, emit } = makeOutput();
  emit({ volume: 30, muted: false });
  emit({ volume: 30, muted: false });
  emit({ muted: false });
  assert.equal(commands.length, 0);
});

test('the device mute key travels as mute, so the zone keeps its level', () => {
  const { commands, emit } = makeOutput();
  emit({ volume: 30, muted: false });
  emit({ volume: 30, muted: true });
  emit({ volume: 30, muted: false });
  assert.deepEqual(commands, [
    { command: 'mute', payload: 'on' },
    { command: 'mute', payload: 'off' },
  ]);
});

test('a genuine device-side volume turn still reaches the zone', () => {
  const { commands, emit } = makeOutput();
  emit({ volume: 30, muted: false });
  emit({ volume: 45 });
  assert.deepEqual(commands, [{ command: 'volume_set', payload: '45' }]);
});

test('transition noise around a Stop we sent is not adopted as a user change', async () => {
  // The third #358 report: a SoundTouch reports volume 0 when told to Stop, and adopting that
  // parked the zone at silence for the next start. During a transport change we initiated, the
  // device's own reports are noise, not knob turns.
  const { output, commands, emit } = makeOutput();
  emit({ volume: 27, muted: false });
  await output.stop({ playbackSource: {} } as unknown as PlaybackSession);
  emit({ volume: 0, muted: false });
  assert.equal(commands.length, 0);
});

test('once the renderer pulls the stream, a drifted device is put back on the zone level', () => {
  // A SoundTouch restores its own remembered volume around a source change and may override a
  // level written mid-transition. The stream fetch is the settle signal: after it, the zone's
  // level is re-asserted exactly when the device drifted, and left alone when it did not.
  const drifted = makeOutput({ zoneVolume: 20 });
  drifted.emit({ volume: 14, muted: false });
  (drifted.output as unknown as { onStreamFetched: () => void }).onStreamFetched();
  assert.deepEqual(drifted.soapVolumes, [20]);

  const settled = makeOutput({ zoneVolume: 20 });
  settled.emit({ volume: 20, muted: false });
  (settled.output as unknown as { onStreamFetched: () => void }).onStreamFetched();
  assert.deepEqual(settled.soapVolumes, []);
});

test('a disposed output never writes into the zone again', () => {
  // The second #358 report: a zone rebuild replaced the output but nobody disposed the old
  // one, so its still-subscribed twin re-injected every echo as a user change. Unsubscribing
  // is best-effort, so the guard must hold even for events that still arrive after dispose.
  const { output, commands, emit } = makeOutput();
  emit({ volume: 21, muted: false });
  output.dispose();
  emit({ volume: 0, muted: true });
  emit({ volume: 21, muted: false });
  assert.equal(commands.length, 0);
});
