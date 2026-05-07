import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  audioZoneAlert,
  audioZoneTts,
} from '../src/adapters/loxone/commands/handlers/alertHandlers';
import { alertsManager } from '../src/application/alerts/alertsManager';

type Capture = {
  leaderId: number;
  type: string;
  action: string;
  zones?: number[];
  ttsText?: string;
  ttsLang?: string;
  volumeOverride?: number;
};

function stubGroupedAlert(): { calls: Capture[]; restore: () => void } {
  const calls: Capture[] = [];
  const original = (alertsManager as any).handleGroupedAlert;
  (alertsManager as any).handleGroupedAlert = async (
    leaderId: number,
    type: string,
    action: string,
    zones?: number[],
    ttsText?: string,
    ttsLang?: string,
    volumeOverride?: number,
  ) => {
    calls.push({ leaderId, type, action, zones, ttsText, ttsLang, volumeOverride });
    return { success: true, type, action };
  };
  return {
    calls,
    restore: () => {
      (alertsManager as any).handleGroupedAlert = original;
    },
  };
}

test('audio/<zoneId>/wecker forwards to alertsManager with single zone', async () => {
  const stub = stubGroupedAlert();
  try {
    await audioZoneAlert('audio/12/wecker');
  } finally {
    stub.restore();
  }
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].leaderId, 12);
  assert.equal(stub.calls[0].type, 'wecker');
  assert.deepEqual(stub.calls[0].zones, [12]);
  assert.equal(stub.calls[0].volumeOverride, undefined);
});

test('audio/<zoneId>/firealarm/<volume> passes the URL volume override', async () => {
  const stub = stubGroupedAlert();
  try {
    await audioZoneAlert('audio/3/firealarm/65');
  } finally {
    stub.restore();
  }
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].type, 'firealarm');
  assert.equal(stub.calls[0].volumeOverride, 65);
});

test('audio/<zoneId>/tts/<lang|text>/<volume> parses lang, text and volume', async () => {
  const stub = stubGroupedAlert();
  try {
    await audioZoneTts('audio/5/tts/de%7Challo+welt/40');
  } finally {
    stub.restore();
  }
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].leaderId, 5);
  assert.equal(stub.calls[0].type, 'tts');
  assert.equal(stub.calls[0].ttsLang, 'de');
  assert.equal(stub.calls[0].ttsText, 'hallo welt');
  assert.equal(stub.calls[0].volumeOverride, 40);
});

test('audio/<zoneId>/tts without language defaults lang to undefined', async () => {
  const stub = stubGroupedAlert();
  try {
    await audioZoneTts('audio/5/tts/hello/30');
  } finally {
    stub.restore();
  }
  assert.equal(stub.calls[0].ttsLang, undefined);
  assert.equal(stub.calls[0].ttsText, 'hello');
  assert.equal(stub.calls[0].volumeOverride, 30);
});
