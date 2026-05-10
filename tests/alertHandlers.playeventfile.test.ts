import assert from 'node:assert/strict';
import { test } from './testHarness';
import { createAlertHandlers } from '../src/adapters/loxone/commands/handlers/alertHandlers';
import type { AlertsPort } from '../src/ports/AlertsPort';

type EventFileCapture = {
  relativePath: string;
  targets: Array<{ zoneId: number; volume?: number }>;
};

function buildHarness(captureEnabled = true) {
  let lastCapture: EventFileCapture | null = null;
  let calls = 0;
  const port: AlertsPort = {
    handleGroupedAlert: async (_leader, type, action) => ({ success: true, type, action }),
    handleUploadedAlert: async (_filename, _zones) => ({
      success: true,
      type: 'uploaded',
      action: 'on',
    }),
    handlePlayEventFile: async (relativePath, targets) => {
      calls += 1;
      if (captureEnabled) {
        lastCapture = { relativePath, targets };
      }
      return { success: true, type: 'playeventfile', action: 'on' };
    },
  };
  const handlers = createAlertHandlers(port);
  return {
    handlers,
    get calls() {
      return calls;
    },
    get capture() {
      return lastCapture;
    },
  };
}

test('audio playeventfile parses zone volume target and relative path', async () => {
  const harness = buildHarness();
  await harness.handlers.audioPlayEventFile(
    'audio/grouped/playeventfile/7~55/Event_Sounds/mycustomaudiofile.mp3',
  );
  assert.equal(harness.capture?.relativePath, 'Event_Sounds/mycustomaudiofile.mp3');
  assert.deepEqual(harness.capture?.targets, [{ zoneId: 7, volume: 55 }]);
});

test('audio playeventfile rejects invalid zone segment', async () => {
  const harness = buildHarness(false);
  await harness.handlers.audioPlayEventFile(
    'audio/grouped/playeventfile/not-a-zone/Event_Sounds/mycustomaudiofile.mp3',
  );
  assert.equal(harness.calls, 0);
});

test('audio playeventfile supports custom_url with raw http path', async () => {
  const harness = buildHarness();
  await harness.handlers.audioPlayEventFile(
    'audio/grouped/playeventfile/27~55/custom_url/http://test.nl/1.mp3',
  );
  assert.equal(harness.capture?.relativePath, 'custom_url/http://test.nl/1.mp3');
  assert.deepEqual(harness.capture?.targets, [{ zoneId: 27, volume: 55 }]);
});

test('audio playeventfile supports custom_url with encoded url payload', async () => {
  const harness = buildHarness();
  await harness.handlers.audioPlayEventFile(
    'audio/grouped/playeventfile/11/custom_url/https%3A%2F%2Fcdn.example.com%2Ffx%2Fdoor.mp3%3Fv%3D1',
  );
  assert.equal(
    harness.capture?.relativePath,
    'custom_url/https://cdn.example.com/fx/door.mp3?v=1',
  );
  assert.deepEqual(harness.capture?.targets, [{ zoneId: 11, volume: undefined }]);
});
