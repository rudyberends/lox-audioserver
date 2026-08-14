import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  BluetoothInputService,
  bluetoothClientId,
} from '../src/adapters/inputs/bluetooth/bluetoothInputService';
import type { ZoneConfig } from '../src/domain/config/types';
import type { SendspinSessionHooks } from '@sonn-audio/node-sendspin';

type Registered = { clientId: string; hooks: SendspinSessionHooks; stopped: boolean };

function buildService() {
  const registered: Registered[] = [];
  const service = new BluetoothInputService({
    register: (clientId, hooks) => {
      const entry: Registered = { clientId, hooks, stopped: false };
      registered.push(entry);
      return () => {
        entry.stopped = true;
      };
    },
  });
  const calls: string[] = [];
  service.configure({
    startPlayback: (zoneId, label, source) => {
      const pipe = source.kind === 'pipe' ? source : null;
      calls.push(`start:${zoneId}:${label}:${pipe?.sampleRate}:${pipe?.channels}`);
    },
    updateMetadata: (zoneId, metadata) => calls.push(`meta:${zoneId}:${metadata.title}`),
    updateCover: () => {},
    updateVolume: () => {},
    updateTiming: (zoneId, elapsed, duration) => calls.push(`time:${zoneId}:${elapsed}/${duration}`),
    pausePlayback: () => {},
    resumePlayback: () => {},
    stopPlayback: (zoneId) => calls.push(`stop:${zoneId}`),
  });
  return { service, registered, calls };
}

function zone(id: number, bluetooth: ZoneConfig['inputs'] extends undefined ? never : unknown): ZoneConfig {
  return { id, name: `Zone ${id}`, inputs: { bluetooth } } as unknown as ZoneConfig;
}

const START = { codec: 'pcm', sampleRate: 48000, channels: 2, bitDepth: 16 } as never;

test('bluetooth input listens only for zones that name a device', () => {
  const { service, registered } = buildService();
  service.syncZones([
    zone(1, { enabled: true, deviceId: 'sonn-hal' }),
    // On, but nothing in the room can hear a phone: there is nothing to listen for.
    zone(2, { enabled: true }),
    zone(3, { enabled: false, deviceId: 'sonn-keuken' }),
  ]);
  assert.deepEqual(
    registered.map((entry) => entry.clientId),
    [bluetoothClientId('sonn-hal')],
  );
});

test('a phone that starts playing takes the zone, and stopping gives it back', () => {
  const { service, registered, calls } = buildService();
  service.syncZones([zone(7, { enabled: true, deviceId: 'sonn-hal' })]);
  const hooks = registered[0]!.hooks;

  hooks.onSourceStreamStart?.(null as never, START);
  hooks.onSourceAudio?.(null as never, { data: Buffer.alloc(64) } as never);
  hooks.onSourceStreamEnd?.(null as never);

  assert.deepEqual(calls, ['start:7:bluetooth:48000:2', 'stop:7']);
});

test('the phone\'s own clock decides the position and the length', () => {
  const { service, registered, calls } = buildService();
  service.syncZones([zone(7, { enabled: true, deviceId: 'sonn-hal' })]);
  registered[0]!.hooks.onSourceStreamStart?.(null as never, START);
  calls.length = 0;

  // A phone reports where it is on every poll. Counting elapsed time here instead would keep
  // running through a pause and describe a different moment than the one being heard.
  service.updateNowPlaying('sonn-hal', {
    title: 'Hyperballad',
    duration_ms: 284318,
    position_ms: 194734,
  });
  service.updateNowPlaying('sonn-hal', {
    title: 'Hyperballad',
    duration_ms: 284318,
    position_ms: 199734,
  });

  assert.deepEqual(
    calls.filter((call) => call.startsWith('time:')),
    ['time:7:195/284', 'time:7:200/284'],
  );
});

test('what the phone says it is playing reaches the zone once per change', () => {
  const { service, registered, calls } = buildService();
  service.syncZones([zone(7, { enabled: true, deviceId: 'sonn-hal' })]);
  registered[0]!.hooks.onSourceStreamStart?.(null as never, START);
  calls.length = 0;

  service.updateNowPlaying('sonn-hal', { title: 'Hyperballad', artist: 'Björk' });
  // The same poll answer twice is not news; republishing it would redraw the screen for nothing.
  service.updateNowPlaying('sonn-hal', { title: 'Hyperballad', artist: 'Björk' });
  service.updateNowPlaying('sonn-hal', { title: 'Isobel', artist: 'Björk' });

  assert.deepEqual(calls, ['meta:7:Hyperballad', 'meta:7:Isobel']);
});

test('metadata for a phone that is not playing here is ignored', () => {
  const { service, calls } = buildService();
  service.syncZones([zone(7, { enabled: true, deviceId: 'sonn-hal' })]);
  // Nothing is streaming, so there is no session to describe -- and a device the zone does not
  // listen to should never be able to write on its screen.
  service.updateNowPlaying('sonn-hal', { title: 'Hyperballad' });
  service.updateNowPlaying('sonn-zolder', { title: 'Hyperballad' });
  assert.deepEqual(calls, []);
});

test('taking bluetooth away from a zone stops the music and releases the hooks', () => {
  const { service, registered, calls } = buildService();
  service.syncZones([zone(7, { enabled: true, deviceId: 'sonn-hal' })]);
  registered[0]!.hooks.onSourceStreamStart?.(null as never, START);
  calls.length = 0;

  service.syncZones([zone(7, { enabled: false, deviceId: 'sonn-hal' })]);

  assert.deepEqual(calls, ['stop:7']);
  assert.equal(registered[0]!.stopped, true);
});
