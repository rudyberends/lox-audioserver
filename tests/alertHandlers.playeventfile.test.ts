import assert from 'node:assert/strict';
import { test } from './testHarness';
import { audioPlayEventFile } from '../src/adapters/loxone/commands/handlers/alertHandlers';
import { alertsManager } from '../src/application/alerts/alertsManager';

test('audio playeventfile parses zone volume target and relative path', async () => {
  const original = (alertsManager as any).handlePlayEventFile;
  let capturedPath = '';
  let capturedTargets: Array<{ zoneId: number; volume?: number }> = [];

  (alertsManager as any).handlePlayEventFile = async (
    relativePath: string,
    targets: Array<{ zoneId: number; volume?: number }>,
  ) => {
    capturedPath = relativePath;
    capturedTargets = targets;
    return { success: true, type: 'playeventfile', action: 'on' as const };
  };

  try {
    await audioPlayEventFile('audio/grouped/playeventfile/7~55/Event_Sounds/mycustomaudiofile.mp3');
  } finally {
    (alertsManager as any).handlePlayEventFile = original;
  }

  assert.equal(capturedPath, 'Event_Sounds/mycustomaudiofile.mp3');
  assert.deepEqual(capturedTargets, [{ zoneId: 7, volume: 55 }]);
});

test('audio playeventfile rejects invalid zone segment', async () => {
  const original = (alertsManager as any).handlePlayEventFile;
  let called = false;

  (alertsManager as any).handlePlayEventFile = async () => {
    called = true;
    return { success: true, type: 'playeventfile', action: 'on' as const };
  };

  try {
    await audioPlayEventFile('audio/grouped/playeventfile/not-a-zone/Event_Sounds/mycustomaudiofile.mp3');
  } finally {
    (alertsManager as any).handlePlayEventFile = original;
  }

  assert.equal(called, false);
});

test('audio playeventfile supports custom_url with raw http path', async () => {
  const original = (alertsManager as any).handlePlayEventFile;
  let capturedPath = '';
  let capturedTargets: Array<{ zoneId: number; volume?: number }> = [];

  (alertsManager as any).handlePlayEventFile = async (
    relativePath: string,
    targets: Array<{ zoneId: number; volume?: number }>,
  ) => {
    capturedPath = relativePath;
    capturedTargets = targets;
    return { success: true, type: 'playeventfile', action: 'on' as const };
  };

  try {
    await audioPlayEventFile('audio/grouped/playeventfile/27~55/custom_url/http://test.nl/1.mp3');
  } finally {
    (alertsManager as any).handlePlayEventFile = original;
  }

  assert.equal(capturedPath, 'custom_url/http://test.nl/1.mp3');
  assert.deepEqual(capturedTargets, [{ zoneId: 27, volume: 55 }]);
});

test('audio playeventfile supports custom_url with encoded url payload', async () => {
  const original = (alertsManager as any).handlePlayEventFile;
  let capturedPath = '';
  let capturedTargets: Array<{ zoneId: number; volume?: number }> = [];

  (alertsManager as any).handlePlayEventFile = async (
    relativePath: string,
    targets: Array<{ zoneId: number; volume?: number }>,
  ) => {
    capturedPath = relativePath;
    capturedTargets = targets;
    return { success: true, type: 'playeventfile', action: 'on' as const };
  };

  try {
    await audioPlayEventFile(
      'audio/grouped/playeventfile/11/custom_url/https%3A%2F%2Fcdn.example.com%2Ffx%2Fdoor.mp3%3Fv%3D1',
    );
  } finally {
    (alertsManager as any).handlePlayEventFile = original;
  }

  assert.equal(capturedPath, 'custom_url/https://cdn.example.com/fx/door.mp3?v=1');
  assert.deepEqual(capturedTargets, [{ zoneId: 11, volume: undefined }]);
});
