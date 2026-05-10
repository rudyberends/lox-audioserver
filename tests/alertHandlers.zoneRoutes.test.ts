import assert from 'node:assert/strict';
import { test } from './testHarness';
import { createAlertHandlers } from '../src/adapters/loxone/commands/handlers/alertHandlers';
import type { AlertsPort } from '../src/ports/AlertsPort';

type Capture = {
  leaderId: number;
  type: string;
  action: string;
  zones?: number[];
  ttsText?: string;
  ttsLang?: string;
  volumeOverride?: number;
};

function buildHarness() {
  const calls: Capture[] = [];
  const port: AlertsPort = {
    handleGroupedAlert: async (leaderId, type, action, zones, ttsText, ttsLang, volumeOverride) => {
      calls.push({ leaderId, type, action, zones, ttsText, ttsLang, volumeOverride });
      return { success: true, type, action };
    },
    handleUploadedAlert: async (_filename, _zones) => ({
      success: true,
      type: 'uploaded',
      action: 'on',
    }),
    handlePlayEventFile: async (_relativePath, _targets) => ({
      success: true,
      type: 'playeventfile',
      action: 'on',
    }),
  };
  const handlers = createAlertHandlers(port);
  return { handlers, calls };
}

test('audio/<zoneId>/wecker forwards to alertsManager with single zone', async () => {
  const { handlers, calls } = buildHarness();
  await handlers.audioZoneAlert('audio/12/wecker');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].leaderId, 12);
  assert.equal(calls[0].type, 'wecker');
  assert.deepEqual(calls[0].zones, [12]);
  assert.equal(calls[0].volumeOverride, undefined);
});

test('audio/<zoneId>/firealarm/<volume> passes the URL volume override', async () => {
  const { handlers, calls } = buildHarness();
  await handlers.audioZoneAlert('audio/3/firealarm/65');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'firealarm');
  assert.equal(calls[0].volumeOverride, 65);
});

test('audio/<zoneId>/tts/<lang|text>/<volume> parses lang, text and volume', async () => {
  const { handlers, calls } = buildHarness();
  await handlers.audioZoneTts('audio/5/tts/de%7Challo+welt/40');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].leaderId, 5);
  assert.equal(calls[0].type, 'tts');
  assert.equal(calls[0].ttsLang, 'de');
  assert.equal(calls[0].ttsText, 'hallo welt');
  assert.equal(calls[0].volumeOverride, 40);
});

test('audio/<zoneId>/tts without language defaults lang to undefined', async () => {
  const { handlers, calls } = buildHarness();
  await handlers.audioZoneTts('audio/5/tts/hello/30');
  assert.equal(calls[0].ttsLang, undefined);
  assert.equal(calls[0].ttsText, 'hello');
  assert.equal(calls[0].volumeOverride, 30);
});
