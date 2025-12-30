import { alertsManager } from '@/modules/alerts/alertsManager';
import type { AlertAction } from '@/modules/alerts/types';
import { buildResponse } from '@/modules/loxone/commands/responses';
import { decodeSegment, splitCommand } from '@/modules/loxone/commands/utils/commandUtils';

export type { AlertAction };

export async function audioGroupedAlert(command: string) {
  const parts = splitCommand(command);
  const type = (parts[2] ?? '').toLowerCase();
  const hasOff = parts.includes('off');
  const offIndex = parts.indexOf('off');
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
