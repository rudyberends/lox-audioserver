import { alertsManager } from '@/runtime/audioServer/alertsManager';
import { CommandResult, response } from '../requestHandler';

/**
 * Handles grouped alert commands emitted by Loxone (audio/grouped/...).
 * Examples:
 *   - audio/grouped/alarm/20,19,38,14,15        → start
 *   - audio/grouped/alarm/off/20,19,38,14,15    → stop
 *   - audio/grouped/tts/20,19/NLD|Dit is een test  → start TTS
 */
export async function handleGroupedAlert(url: string): Promise<CommandResult> {
  const parts = url.split('/');
  // audio/grouped/<type>/[off]/<zones>/[ttsText]
  const type = (parts[2] ?? '').toLowerCase();

  // detect presence of "off"
  const hasOff = parts.includes('off');
  const offIndex = parts.indexOf('off');
  const zonesIndex = hasOff ? offIndex + 1 : 3;

  const zoneList = (parts[zonesIndex] ?? '')
    .split(',')
    .map((s) => Number(s))
    .filter((n) => !isNaN(n) && n > 0);

  if (!type || zoneList.length === 0) {
    return response(url, 'groupalert', [
      { success: false, reason: 'invalid-url' },
    ]);
  }

  const leaderId = zoneList[0];
  const action: 'on' | 'off' = hasOff ? 'off' : 'on';

  let ttsText: string | undefined;
  let ttsLang: string | undefined;

  // Example: audio/grouped/tts/20,19,38,14,15/NLD|Dit is een test
  if (type === 'tts' && parts.length > zonesIndex + 1) {
    const rawTts = decodeURIComponent(parts.slice(zonesIndex + 1).join('/')).replace(/\+/g, ' ');
    const [langCandidate, ...textParts] = rawTts.split('|');
    if (textParts.length > 0) {
      ttsLang = langCandidate.trim().toLowerCase();
      ttsText = textParts.join('|').trim();
    } else {
      ttsText = langCandidate.trim();
    }
  }

  const result = await alertsManager.handleGroupedAlert(
    leaderId,
    type,
    action,
    zoneList,
    ttsText,
    ttsLang,
  );

  return response(url, 'groupalert', [result]);
}