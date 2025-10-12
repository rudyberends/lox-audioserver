import { CommandResult, emptyCommand, response } from './commandTypes';
import {
  resolveAlertMedia,
  resolveAlertTargets,
  buildAlertMediaUrl,
  AlertMediaResource,
} from '../../backend/alerts/alertService';
import { getZoneById, sendCommandToZone } from '../../backend/zone/zonemanager';
import logger from '../../utils/troxorlogger';
import { FileType, AudioEventType, RepeatMode } from '../../backend/zone/loxoneTypes';

const MAX_TTS_CHARACTERS = 800;
const STOP_KEYWORDS = new Set(['off', 'stop', 'cancel']);
const LOOPING_ALERT_TYPES = new Set(['alarm', 'firealarm', 'buzzer']);

type AlertAction = 'start' | 'stop';

interface ParsedTtsPayload {
  text: string;
  language?: string;
}

interface LoopStateSnapshot {
  previousRepeat: RepeatMode | number | undefined;
}

const loopState = new Map<string, LoopStateSnapshot>();

/**
 * Handles grouped alert commands emitted by Loxone (`audio/grouped/...` URLs).
 *
 * Supported flow:
 *  - `{type}/<targets>` (legacy behaviour) → start alert
 *  - `{type}/off/<targets>` → stop alert (restore repeat mode + pause)
 *  - looped types (`alarm`, `firealarm`, `buzzer`) use `serviceplay + repeat track`
 *  - other types leverage Music Assistant announcements when available
 */
export async function handleGroupedAlert(url: string): Promise<CommandResult> {
  const segments = url.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 4 || segments[0] !== 'audio' || segments[1] !== 'grouped') {
    return emptyCommand(url, []);
  }

  const type = segments[2]?.toLowerCase() ?? '';
  if (!type) {
    return emptyCommand(url, []);
  }

  let pointer = 3;
  let action: AlertAction = 'start';
  const potentialAction = segments[pointer]?.toLowerCase() ?? '';

  if (STOP_KEYWORDS.has(potentialAction)) {
    action = 'stop';
    pointer += 1;
  } else if (potentialAction === 'on' || potentialAction === 'start') {
    action = 'start';
    pointer += 1;
  }

  const rawTarget = segments[pointer] ?? '';
  const targetToken = decodeURIComponentSafe(rawTarget);
  const targets = resolveAlertTargets(targetToken);

  const payloadSegments = segments.slice(pointer + 1);
  const rawPayload = payloadSegments.join('/');

  if (targets.length === 0) {
    logger.warn(
      `[AlertCommands] Alert ${type} ${action} ignored – no valid zones resolved from "${targetToken}"`,
    );
    return response(url, 'groupalert', [
      {
        success: false,
        reason: 'no-targets',
        type,
        action,
        targets: [],
      },
    ]);
  }

  if (action === 'stop') {
    const stopResult = await stopAlert(type, targets);
    return response(url, 'groupalert', [
      {
        success: stopResult.commands.length > 0,
        type,
        action,
        targets,
        commands: stopResult.commands,
        skipped: stopResult.skipped,
      },
    ]);
  }

  const ttsPayload = type === 'tts' ? parseTtsPayload(rawPayload) : undefined;
  const media = await resolveAlertMedia({
    type,
    text: ttsPayload?.text,
    language: ttsPayload?.language,
  });

  if (!media) {
    logger.warn(`[AlertCommands] Alert ${type} ignored – unable to resolve media resource`);
    return response(url, 'groupalert', [
      {
        success: false,
        reason: 'media-unavailable',
        type,
        action,
        targets,
      },
    ]);
  }

  const mediaUrl = buildAlertMediaUrl(media.relativePath);
  const startResult = await startAlert(type, targets, media, mediaUrl);

  return response(url, 'groupalert', [
    {
      success: startResult.commands.length > 0,
      type,
      action,
      source: media.source,
      media: media.relativePath,
      language: media.language,
      textLength: media.text?.length ?? 0,
      url: mediaUrl,
      looping: LOOPING_ALERT_TYPES.has(type),
      targets,
      commands: startResult.commands,
      skipped: startResult.skipped,
    },
  ]);
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Extracts optional `LANG|text` encoding used by Loxone for TTS alerts. */
function parseTtsPayload(raw: string): ParsedTtsPayload | undefined {
  if (!raw) return undefined;
  const decoded = decodeURIComponentSafe(raw).replace(/\+/g, ' ').trim();
  if (!decoded) return undefined;

  const [langCandidate, ...rest] = decoded.split('|');
  let language: string | undefined;
  let text: string;

  if (rest.length === 0) {
    language = undefined;
    text = decoded;
  } else {
    language = normalizeLanguage(langCandidate);
    text = rest.join('|').trim();
  }

  if (text.length > MAX_TTS_CHARACTERS) {
    text = `${text.slice(0, MAX_TTS_CHARACTERS - 1)}…`;
  }

  return text ? { text, language } : undefined;
}

function normalizeLanguage(candidate: string): string | undefined {
  if (!candidate) return undefined;
  const trimmed = candidate.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();

  if (/^[a-z]{2}(-[a-z]{2})?$/.test(lower)) {
    return lower;
  }
  if (lower.length === 3) {
    return lower.slice(0, 2);
  }

  const languageAliases: Record<string, string> = {
    nld: 'nl',
    dut: 'nl',
    eng: 'en',
    deu: 'de',
    ger: 'de',
    ita: 'it',
    spa: 'es',
    por: 'pt',
    fra: 'fr',
    fre: 'fr',
  };

  if (languageAliases[lower]) {
    return languageAliases[lower];
  }

  return lower.slice(0, 2);
}

/**
 * Dispatches playback commands to every target zone and, when needed, enables looping (repeat track).
 */
async function startAlert(
  type: string,
  targets: number[],
  media: AlertMediaResource,
  mediaUrl: string,
): Promise<{ commands: Array<{ zone: number; command: string }>; skipped: Array<{ zone: number; reason: string }> }> {
  const commands: Array<{ zone: number; command: string }> = [];
  const skipped: Array<{ zone: number; reason: string }> = [];
  const isLooping = LOOPING_ALERT_TYPES.has(type);

  const servicePayload = JSON.stringify(buildServicePlayPayload(type, media, mediaUrl));
  let announcementPayload: string | undefined;

  for (const zoneIdRaw of targets) {
    const zoneId = Number(zoneIdRaw);
    if (!Number.isFinite(zoneId) || zoneId <= 0) {
      skipped.push({ zone: Number(zoneIdRaw), reason: 'invalid-zone' });
      continue;
    }

    const zone = getZoneById(zoneId);
    if (!zone) {
      skipped.push({ zone: zoneId, reason: 'unknown-zone' });
      continue;
    }

    const backendName = zone.player.backend || '';
    const commandName = selectAlertCommand(backendName, type, isLooping);
    const payload =
      commandName === 'announce'
        ? (announcementPayload ??= buildAnnouncementCommandPayload(mediaUrl))
        : servicePayload;

    try {
      await sendCommandToZone(zoneId, commandName, payload);
      commands.push({ zone: zoneId, command: commandName });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[AlertCommands] Failed to dispatch alert to zone ${zoneId}: ${message}`);
      skipped.push({ zone: zoneId, reason: 'dispatch-failed' });
      continue;
    }

    if (isLooping) {
      const loopKey = buildLoopKey(zoneId, type);
      const previousRepeat = zone.playerEntry?.plrepeat;
      loopState.set(loopKey, { previousRepeat });

      try {
        await sendCommandToZone(zoneId, 'repeat', 'track');
        commands.push({ zone: zoneId, command: 'repeat track' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[AlertCommands] Failed to set repeat mode for zone ${zoneId}: ${message}`);
        skipped.push({ zone: zoneId, reason: 'repeat-failed' });
      }
    } else {
      loopState.delete(buildLoopKey(zoneId, type));
    }
  }

  return { commands, skipped };
}

/**
 * Stops active alerts by restoring repeat mode and pausing playback on the target zones.
 */
async function stopAlert(
  type: string,
  targets: number[],
): Promise<{ commands: Array<{ zone: number; command: string }>; skipped: Array<{ zone: number; reason: string }> }> {
  const commands: Array<{ zone: number; command: string }> = [];
  const skipped: Array<{ zone: number; reason: string }> = [];
  const isLooping = LOOPING_ALERT_TYPES.has(type);

  for (const zoneIdRaw of targets) {
    const zoneId = Number(zoneIdRaw);
    if (!Number.isFinite(zoneId) || zoneId <= 0) {
      skipped.push({ zone: Number(zoneIdRaw), reason: 'invalid-zone' });
      continue;
    }

    const zone = getZoneById(zoneId);
    if (!zone) {
      skipped.push({ zone: zoneId, reason: 'unknown-zone' });
      continue;
    }

    if (isLooping) {
      const loopKey = buildLoopKey(zoneId, type);
      const snapshot = loopState.get(loopKey);
      const repeatTarget = repeatModeToParam(snapshot?.previousRepeat);

      try {
        await sendCommandToZone(zoneId, 'repeat', repeatTarget);
        commands.push({ zone: zoneId, command: `repeat ${repeatTarget}` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[AlertCommands] Failed to restore repeat mode for zone ${zoneId}: ${message}`);
        skipped.push({ zone: zoneId, reason: 'repeat-restore-failed' });
      } finally {
        loopState.delete(loopKey);
      }
    }

    try {
      await sendCommandToZone(zoneId, 'pause');
      commands.push({ zone: zoneId, command: 'pause' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[AlertCommands] Failed to pause zone ${zoneId}: ${message}`);
      skipped.push({ zone: zoneId, reason: 'pause-failed' });
    }
  }

  return { commands, skipped };
}

/**
 * Chooses the backend command per zone: announcements for MA when possible, serviceplay otherwise.
 */
function selectAlertCommand(
  backend: string,
  type: string,
  isLooping: boolean,
): 'announce' | 'serviceplay' {
  if (isLooping) {
    return 'serviceplay';
  }
  if (backend === 'BackendMusicAssistant') {
    return 'announce';
  }
  return 'serviceplay';
}

function buildServicePlayPayload(type: string, media: AlertMediaResource, mediaUrl: string) {
  const identifier = media.relativePath;
  const name = media.title || `Alert ${type}`;
  const payload: Record<string, unknown> = {
    id: `alerts:${identifier}`,
    name,
    audiopath: mediaUrl,
    coverurl: '',
    provider: 'alerts',
    rawId: identifier,
    type: FileType.File,
    option: 'replace',
    event: mapEventType(type),
  };

  if (media.source === 'tts') {
    payload.text = media.text;
    payload.language = media.language;
  }

  return payload;
}

function mapEventType(rawType: string): AudioEventType {
  switch (rawType) {
    case 'bell':
      return AudioEventType.Bell;
    case 'buzzer':
      return AudioEventType.Buzzer;
    case 'tts':
      return AudioEventType.TTS;
    case 'firealarm':
      return AudioEventType.Fire;
    case 'alarm':
      return AudioEventType.Alarm;
    default:
      return AudioEventType.CustomFile;
  }
}

function buildAnnouncementCommandPayload(mediaUrl: string): string {
  return JSON.stringify({
    url: mediaUrl,
  });
}

function buildLoopKey(zoneId: number, type: string): string {
  return `${zoneId}:${type}`;
}

function repeatModeToParam(value: RepeatMode | number | undefined): string {
  switch (value) {
    case RepeatMode.Track:
      return 'track';
    case RepeatMode.Queue:
      return 'queue';
    default:
      return 'off';
  }
}
