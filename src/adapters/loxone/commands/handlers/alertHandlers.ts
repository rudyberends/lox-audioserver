import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { alertsManager } from '@/application/alerts/alertsManager';
import type { AlertAction } from '@/application/alerts/types';
import { createLogger } from '@/shared/logging/logger';
import { buildResponse } from '@/adapters/loxone/commands/responses';
import { decodeSegment, splitCommand } from '@/adapters/loxone/commands/utils/commandUtils';

export type { AlertAction };

const alertsCacheRoot = path.resolve(process.cwd(), 'public', 'alerts', 'cache');
const log = createLogger('Alerts', 'Upload');

export async function audioGroupedAlert(command: string) {
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
    const [langCandidate, ...textParts] = rawTts.split('|');
    if (textParts.length > 0) {
      ttsLang = langCandidate.trim().toLowerCase();
      ttsText = textParts.join('|').trim();
    } else {
      ttsText = langCandidate.trim();
    }
  }

  const result = await alertsManager.handleGroupedAlert(
    zones[0],
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

export async function audioPlayUploadedAlert(command: string) {
  const parts = splitCommand(command);
  const filename = decodeSegment(parts[3]);
  const zonesPart = parts[4] ?? '';
  const zones = zonesPart
    .split(',')
    .map((segment) => Number(segment))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (!filename || zones.length === 0) {
    return buildResponse(command, 'groupalert', [
      { success: false, type: 'uploaded', action: 'on', reason: 'invalid-url' },
    ]);
  }

  const result = await alertsManager.handleUploadedAlert(filename, zones);
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
