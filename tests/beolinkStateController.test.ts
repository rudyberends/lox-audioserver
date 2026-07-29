import assert from 'node:assert/strict';
import { test } from './testHarness';
import { BeoLinkStateController } from '../src/application/zones/state/BeoLinkStateController';
import { AudioType } from '../src/domain/zones/enums';

function createController() {
  return new BeoLinkStateController({
    zone: {
      id: 1,
      name: 'Living',
      host: '127.0.0.1',
      output: { host: '127.0.0.1' } as any,
    } as any,
    onStatePatch: () => undefined,
  }) as any;
}

test('beolink controller ignores ended event for line-in and bluetooth sources', () => {
  const controller = createController();

  controller.lastKnownAudiotype = AudioType.LineIn;
  assert.equal(controller.shouldIgnoreEndedEvent(), true);

  controller.lastKnownAudiotype = AudioType.Bluetooth;
  assert.equal(controller.shouldIgnoreEndedEvent(), true);
});

test('beolink controller does not ignore ended event for non-external sources', () => {
  const controller = createController();

  controller.lastKnownAudiotype = AudioType.AirPlay;
  assert.equal(controller.shouldIgnoreEndedEvent(), false);

  controller.lastKnownAudiotype = null;
  assert.equal(controller.shouldIgnoreEndedEvent(), false);
});

test('beolink controller maps groupJoin command to BeoLink action endpoint', async () => {
  const controller = createController();
  controller.coverBaseOrigin = 'http://127.0.0.1:8080';

  let captured: { command: string; request: { method: string; path: string }; extra: any } | null = null;
  controller.sendSingleRequest = async (
    command: string,
    request: { method: string; path: string },
    extra: any,
  ) => {
    captured = { command, request, extra };
    return true;
  };

  const handled = controller.handleCommand('groupJoin', 'my-group');
  await Promise.resolve();

  assert.equal(handled, true);
  assert.deepEqual(captured, {
    command: 'groupJoin',
    request: {
      method: 'POST',
      path: '/BeoZone/Zone/Device/OneWayJoin/my-group',
    },
    extra: {
      actionPath: 'Device/OneWayJoin',
      hasParam: true,
    },
  });
});

test('beolink controller maps absolute volume command to speaker level endpoint', async () => {
  const controller = createController();
  controller.coverBaseOrigin = 'http://127.0.0.1:8080';
  controller.lastKnownVolumeMax = 90;

  let captured: { command: string; request: { method: string; path: string; body?: string }; extra: any } | null = null;
  controller.sendSingleRequest = async (
    command: string,
    request: { method: string; path: string; body?: string },
    extra: any,
  ) => {
    captured = { command, request, extra };
    return true;
  };

  const handled = controller.handleCommand('volume', '95');
  await Promise.resolve();

  assert.equal(handled, true);
  assert.deepEqual(captured, {
    command: 'volume',
    request: {
      method: 'PUT',
      path: '/BeoZone/Zone/Sound/Volume/Speaker/Level',
      body: '{"level":90}',
      contentType: 'application/json',
    },
    extra: {
      resolvedLevel: 90,
      isRelative: false,
    },
  });
});

test('beolink controller maps relative volume command using last known volume', async () => {
  const controller = createController();
  controller.coverBaseOrigin = 'http://127.0.0.1:8080';
  controller.lastKnownVolume = 53;
  controller.lastKnownVolumeMax = 90;

  let captured: { command: string; request: { method: string; path: string; body?: string }; extra: any } | null = null;
  controller.sendSingleRequest = async (
    command: string,
    request: { method: string; path: string; body?: string },
    extra: any,
  ) => {
    captured = { command, request, extra };
    return true;
  };

  const handled = controller.handleCommand('volume', '+5');
  await Promise.resolve();

  assert.equal(handled, true);
  assert.deepEqual(captured, {
    command: 'volume',
    request: {
      method: 'PUT',
      path: '/BeoZone/Zone/Sound/Volume/Speaker/Level',
      body: '{"level":58}',
      contentType: 'application/json',
    },
    extra: {
      resolvedLevel: 58,
      isRelative: true,
    },
  });
});
