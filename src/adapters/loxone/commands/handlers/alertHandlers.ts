import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { AlertsPort } from '@/ports/AlertsPort';
import type { AlertAction } from '@/ports/types/alerts';
import { alertsManager } from '@/application/alerts/alertsManager';
import { createLogger } from '@/shared/logging/logger';
import { buildResponse } from '@/adapters/loxone/commands/responses';
import { decodeSegment, splitCommand } from '@/adapters/loxone/commands/utils/commandUtils';

export type { AlertAction };

const alertsCacheRoot = path.resolve(process.cwd(), 'public', 'alerts', 'cache');
const log = createLogger('Alerts', 'Upload');

export function createAlertHandlers(alerts: AlertsPort) {
  return {
    audioGroupedAlert: (command: string) => audioGroupedAlertImpl(alerts, command),
    audioCfgUploadAudiouploadAdd,
    audioPlayUploadedAlert: (command: string) => audioPlayUploadedAlertImpl(alerts, command),
    audioZoneAlert: (command: string) => audioZoneAlertImpl(alerts, command),
    audioZoneTts: (command: string) => audioZoneTtsImpl(alerts, command),
    audioPlayEventFile: (command: string) => audioPlayEventFileImpl(alerts, command),
  };
}

// Module-level convenience wrappers bound to the application's alertsManager
// singleton. Tests stub alertsManager methods directly, so these let test
// imports keep their original shape after the AlertsPort introduction.
// Production wiring goes through createAlertHandlers above.
export const audioGroupedAlert = (command: string) => audioGroupedAlertImpl(alertsManager, command);
export const audioPlayUploadedAlert = (command: string) =>
  audioPlayUploadedAlertImpl(alertsManager, command);
export const audioZoneAlert = (command: string) => audioZoneAlertImpl(alertsManager, command);
export const audioZoneTts = (command: string) => audioZoneTtsImpl(alertsManager, command);
export const audioPlayEventFile = (command: string) =>
  audioPlayEventFileImpl(alertsManager, command);

async function audioGroupedAlertImpl(alerts: AlertsPort, command: string) {
  const parts = splitCommand(command);
  const type = (parts[2] ?? '').toLowerCase();
  const offIndex = parts.findIndex((part) => part === 'off' || part === 'stop');
  const hasOff = offIndex !== -1;
  const zonesIndex = hasOff ? offIndex + 1 : 3;
  const zonesPart = parts[zonesIndex] ?? '';
  const zones = zonesPart
    .split(',')
    .map((segment) => Number(segment))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (!type || zones.length === 0) {
    return buildResponse(command, 'groupalert', [{ success: false, type, action: 'on', reason: 'invalid-url' }]);
  }

  const action: AlertAction = hasOff ? 'off' : 'on';

  let ttsText: string | undefined;
  let ttsLang: string | undefined;

  if (type === 'tts' && parts.length > zonesIndex + 1) {
    const rawTts = decodeSegment(parts.slice(zonesIndex + 1).join('/')).replace(/\+/g, ' ');
    const [langCandidate = '', ...textParts] = rawTts.split('|');
    if (textParts.length > 0) {
      ttsLang = langCandidate.trim().toLowerCase();
      ttsText = textParts.join('|').trim();
    } else {
      ttsText = langCandidate.trim();
    }
  }

  const result = await alerts.handleGroupedAlert(
    zones[0]!,
    type,
    action,
    zones,
    ttsText,
    ttsLang,
  );

  return buildResponse(command, 'groupalert', [result]);
}

export async function audioCfgUploadAudiouploadAdd(command: string, payload?: Buffer) {
  const parts = splitCommand(command);
  const rawPath = parts.slice(5).join('/');
  const filename = decodeSegment(rawPath);
  if (!filename) {
    log.warn('upload rejected: empty filename', { command });
    return buildResponse(command, 'audioupload', { success: false, error: 'invalid-filename' });
  }
  if (!payload?.length) {
    log.warn('upload rejected: missing payload', { filename });
    return buildResponse(command, 'audioupload', { success: false, error: 'missing-payload' });
  }

  const target = resolveUploadPath(filename);
  if (!target) {
    log.warn('upload rejected: invalid path', { filename });
    return buildResponse(command, 'audioupload', { success: false, error: 'invalid-filename' });
  }

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, payload);
  log.info('uploaded alert file', { filename, path: target, bytes: payload.length });

  return buildResponse(command, 'audioupload', { success: true, filename });
}

async function audioPlayUploadedAlertImpl(alerts: AlertsPort, command: string) {
  const parts = splitCommand(command);
  const filename = decodeSegment(parts[3]);
  const zonesPart = parts[4] ?? '';
  const zones = zonesPart
    .split(',')
    .map((segment) => Number(segment))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (!filename || zones.length === 0) {
    return buildResponse(command, 'playuploadedfile', false);
  }

  const result = await alerts.handleUploadedAlert(filename, zones);
  return buildResponse(command, 'playuploadedfile', Boolean(result?.success));
}

/**
 * Handles `audio/<zoneId>/(alarm|firealarm|bell|wecker)[/<volume>]` —
 * the per-zone alert path the Miniserver uses for direct alarm/clock events.
 */
async function audioZoneAlertImpl(alerts: AlertsPort, command: string) {
  const parts = splitCommand(command);
  const zoneId = Number(parts[1]);
  const type = (parts[2] ?? '').toLowerCase();
  const volumeRaw = parts[3];
  const volume = volumeRaw !== undefined && volumeRaw !== '' ? Number(volumeRaw) : undefined;

  if (!Number.isFinite(zoneId) || zoneId <= 0 || !type) {
    return buildResponse(command, 'groupalert', [
      { success: false, type, action: 'on', reason: 'invalid-url' },
    ]);
  }

  const result = await alerts.handleGroupedAlert(
    zoneId,
    type,
    'on',
    [zoneId],
    undefined,
    undefined,
    Number.isFinite(volume) ? (volume as number) : undefined,
  );
  return buildResponse(command, 'groupalert', [result]);
}

/**
 * Handles `audio/<zoneId>/tts/<language>|<text>/<volume>` — the per-zone TTS path
 * the Miniserver uses for room-targeted announcements.
 */
async function audioZoneTtsImpl(alerts: AlertsPort, command: string) {
  const parts = splitCommand(command);
  const zoneId = Number(parts[1]);
  const volumeRaw = parts[parts.length - 1];
  const volume = Number(volumeRaw);
  const payload = decodeSegment(parts.slice(3, parts.length - 1).join('/')).replace(/\+/g, ' ');

  if (!Number.isFinite(zoneId) || zoneId <= 0 || !payload) {
    return buildResponse(command, 'groupalert', [
      { success: false, type: 'tts', action: 'on', reason: 'invalid-url' },
    ]);
  }

  let ttsLang: string | undefined;
  let ttsText: string;
  const [first = '', ...rest] = payload.split('|');
  if (rest.length > 0) {
    ttsLang = first.trim().toLowerCase();
    ttsText = rest.join('|').trim();
  } else {
    ttsText = first.trim();
  }

  const result = await alerts.handleGroupedAlert(
    zoneId,
    'tts',
    'on',
    [zoneId],
    ttsText,
    ttsLang,
    Number.isFinite(volume) ? volume : undefined,
  );
  return buildResponse(command, 'groupalert', [result]);
}

async function audioPlayEventFileImpl(alerts: AlertsPort, command: string) {
  const parts = splitCommand(command);
  const zoneTargets = parseZoneTargets(parts[3] ?? '');
  const relativePath = decodeSegment(parts.slice(4).join('/'));

  if (!relativePath || zoneTargets.length === 0) {
    return buildResponse(command, 'groupalert', [
      { success: false, type: 'playeventfile', action: 'on', reason: 'invalid-url' },
    ]);
  }

  const result = await alerts.handlePlayEventFile(relativePath, zoneTargets);
  return buildResponse(command, 'groupalert', [result]);
}

function resolveUploadPath(input: string): string | null {
  const safeSegments = input
    .split('/')
    .filter(Boolean)
    .map((segment) => safeDecode(segment))
    .filter((segment) => segment && segment !== '.' && segment !== '..');

  if (!safeSegments.length) {
    return null;
  }

  const candidate = path.resolve(alertsCacheRoot, ...safeSegments);
  if (!candidate.startsWith(alertsCacheRoot)) {
    return null;
  }
  return candidate;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseZoneTargets(raw: string): Array<{ zoneId: number; volume?: number }> {
  const targets: Array<{ zoneId: number; volume?: number }> = [];
  for (const segment of raw.split(',')) {
    const chunk = segment.trim();
    if (!chunk) {
      continue;
    }
    const match = chunk.match(/^(\d+)(?:~(\d+))?$/);
    if (!match) {
      continue;
    }
    const zoneId = Number(match[1]);
    const volume = match[2] ? Number(match[2]) : undefined;
    if (!Number.isFinite(zoneId) || zoneId <= 0) {
      continue;
    }
    if (volume != null && (!Number.isFinite(volume) || volume < 0 || volume > 100)) {
      continue;
    }
    targets.push({ zoneId, volume });
  }
  return targets;
}
