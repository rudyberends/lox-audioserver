import { CommandResult, emptyCommand, response } from './commandTypes';
import {
  resolveAlertMedia,
  resolveAlertTargets,
  buildAlertMediaUrl,
  AlertMediaResource,
} from '../../backend/alerts/alertService';
import { getZoneById, sendCommandToZone } from '../../backend/zone/zonemanager';
import { getStoredVolumePreset, type ZoneVolumeConfig } from '../../config/config';
import logger from '../../utils/troxorlogger';
import { FileType, AudioEventType, RepeatMode } from '../../backend/zone/loxoneTypes';
import {
  parseFadeOptions,
  clampFadeDuration,
  clampVolume,
  cancelFade,
  scheduleFade,
  DEFAULT_FADE_DURATION_MS,
  FadeOptions,
  FadeSnapshot,
  FadeController,
} from '../utils/fade';
import { getGroupByZone } from '../../backend/zone/groupTracker';

const MAX_TTS_CHARACTERS = 800;
const STOP_KEYWORDS = new Set(['off', 'stop', 'cancel']);
const LOOPING_ALERT_TYPES = new Set(['alarm', 'firealarm', 'buzzer']);
const TEMP_GROUP_MIN_DURATION_MS = 6000;
const TEMP_GROUP_MAX_DURATION_MS = 90000;
const TEMP_GROUP_FALLBACK_DURATION_MS = 20000;
const TEMP_GROUP_GRACE_MS = 4000;

type AlertAction = 'start' | 'stop';

interface ParsedTtsPayload {
  text: string;
  language?: string;
}

interface LoopStateSnapshot {
  previousRepeat: RepeatMode | number | undefined;
}

type ZoneStateSnapshot = NonNullable<ReturnType<typeof getZoneById>>;

interface OriginalGroupSnapshot {
  leaderId: number;
  memberZoneIds: number[];
}

interface TemporaryGroupState {
  leaderZoneId: number;
  childMaPlayerIds: string[];
  originalGroups: OriginalGroupSnapshot[];
}

type ZoneAlertContext = {
  id: number;
  zone: ZoneStateSnapshot;
  backendName: string;
  fadeKey: string;
  initialVolume: number;
  targetVolume: number;
};

interface GroupedTtsContext {
  type: string;
  media: AlertMediaResource;
  mediaUrl: string;
  fadeRequested: boolean;
  zoneContexts: ZoneAlertContext[];
  commands: Array<{ zone: number; command: string }>;
  skipped: Array<{ zone: number; reason: string }>;
}

const loopState = new Map<string, LoopStateSnapshot>();
const fadeState = new Map<string, FadeSnapshot>();
const activeFadeControllers = new Map<string, FadeController>();

type ScheduledTemporaryGroup = {
  timer: NodeJS.Timeout;
  state: TemporaryGroupState;
};

const temporaryGroupTimers = new Map<number, ScheduledTemporaryGroup>();

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
  const alertOptions = parseFadeOptions(rawPayload);

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
    const stopResult = await stopAlert(type, targets, alertOptions);
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
  const startResult = await startAlert(type, targets, media, mediaUrl, alertOptions);

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
  options: FadeOptions,
): Promise<{ commands: Array<{ zone: number; command: string }>; skipped: Array<{ zone: number; reason: string }> }> {
  const commands: Array<{ zone: number; command: string }> = [];
  const skipped: Array<{ zone: number; reason: string }> = [];
  const isLooping = LOOPING_ALERT_TYPES.has(type);
  const fadeRequested = options.fade === true;
  const requestedFadeDuration = options.fadeDurationMs ?? DEFAULT_FADE_DURATION_MS;
  const resolvedFadeDuration = clampFadeDuration(requestedFadeDuration);

  const servicePayload = JSON.stringify(buildServicePlayPayload(type, media, mediaUrl));
  let announcementPayload: string | undefined;

  const zoneContexts: ZoneAlertContext[] = [];

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
    const fadeKey = buildLoopKey(zoneId, type);
    const initialVolume = clampVolume(zone.playerEntry?.volume ?? 0);
    const targetVolume = resolveAlertVolume(type, zoneId, initialVolume);
    zoneContexts.push({
      id: zoneId,
      zone,
      backendName,
      fadeKey,
      initialVolume,
      targetVolume,
    });
  }

  const handledByGroup = await maybeHandleGroupedTtsAlert({
    type,
    media,
    mediaUrl,
    fadeRequested,
    zoneContexts,
    commands,
    skipped,
  });

  for (const context of zoneContexts) {
    if (handledByGroup.has(context.id)) {
      continue;
    }

    const { id: zoneId, zone, backendName, fadeKey, initialVolume, targetVolume } = context;
    const enableFade = fadeRequested && resolvedFadeDuration > 0;

    if (enableFade) {
      fadeState.set(fadeKey, {
        originalVolume: initialVolume,
        fadeDurationMs: resolvedFadeDuration,
      });
      cancelFade(fadeKey, activeFadeControllers);

      const dropDelta = -Math.max(Math.round(initialVolume), 100);
      try {
        await sendCommandToZone(zoneId, 'volume', String(dropDelta));
        commands.push({ zone: zoneId, command: `volume ${dropDelta}` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[AlertCommands] Failed to prime fade-in for zone ${zoneId}: ${message}`);
      }
      if (zone) {
        zone.playerEntry.volume = 0;
        zone.fadeTargetVolume = targetVolume;
      }
    } else {
      fadeState.delete(fadeKey);
      cancelFade(fadeKey, activeFadeControllers);
      if (zone) {
        zone.fadeTargetVolume = targetVolume;
      }
    }

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
      if (enableFade) {
        fadeState.delete(fadeKey);
        if (initialVolume > 0) {
          const initialInt = Math.round(clampVolume(initialVolume));
          const currentInt = zone ? Math.round(clampVolume(zone.playerEntry.volume ?? 0)) : 0;
          const delta = initialInt - currentInt;
          if (zone) {
            zone.playerEntry.volume = initialInt;
          }
          if (delta !== 0) {
            sendCommandToZone(zoneId, 'volume', String(delta)).catch((restoreError) => {
              const restoreMessage =
                restoreError instanceof Error ? restoreError.message : String(restoreError);
              logger.warn(
                `[AlertCommands] Failed to restore volume for zone ${zoneId} after failed alert: ${restoreMessage}`,
              );
            });
          }
        }
      }
      continue;
    }

    if (enableFade) {
      try {
        await sendCommandToZone(zoneId, 'volume', '-100');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[AlertCommands] Failed to enforce fade start volume for zone ${zoneId}: ${message}`);
      }
      if (zone) {
        zone.playerEntry.volume = 0;
        zone.fadeTargetVolume = targetVolume;
      }
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

    if (enableFade) {
      const snapshot = fadeState.get(fadeKey);
      const desiredVolume = targetVolume;
      const duration = snapshot?.fadeDurationMs ?? resolvedFadeDuration;

      if (desiredVolume > 0 && duration > 0) {
        commands.push({ zone: zoneId, command: `fade-in ${duration}ms` });
        let lastVolumeInt = 0;
        if (zone) {
          zone.playerEntry.volume = lastVolumeInt;
        }
        scheduleFade(
          zoneId,
          fadeKey,
          activeFadeControllers,
          0,
          targetVolume,
          duration,
          (value) => {
            const next = Math.round(clampVolume(value));
            const delta = next - lastVolumeInt;
            lastVolumeInt = next;
            if (zone) {
              zone.playerEntry.volume = next;
            }
            if (delta === 0) return Promise.resolve();
            return sendCommandToZone(zoneId, 'volume', String(delta));
          },
        );
      } else {
        fadeState.delete(fadeKey);
      }
    } else {
      await alignZoneToTargetVolume(zoneId, zone, targetVolume, commands, skipped);
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
  options: FadeOptions,
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
    const fadeKey = buildLoopKey(zoneId, type);
    const snapshot = fadeState.get(fadeKey);
    const storedDuration = snapshot?.fadeDurationMs;
    const fadeEnabled = options.fade ?? Boolean(snapshot);
    const requestedDuration = options.fadeDurationMs ?? storedDuration;
    const fadeDuration = fadeEnabled
      ? clampFadeDuration(requestedDuration ?? storedDuration ?? DEFAULT_FADE_DURATION_MS)
      : 0;
    const hasFade = fadeEnabled && fadeDuration > 0;

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

    if (hasFade) {
      cancelFade(fadeKey, activeFadeControllers);
      const startVolume = clampVolume(zone.playerEntry?.volume ?? snapshot?.originalVolume ?? 0);
      let lastVolumeInt = Math.round(startVolume);
      if (zone) {
        zone.playerEntry.volume = lastVolumeInt;
      }
      commands.push({ zone: zoneId, command: `fade-out ${fadeDuration}ms` });
      commands.push({ zone: zoneId, command: 'pause (after fade)' });
      scheduleFade(
        zoneId,
        fadeKey,
        activeFadeControllers,
        startVolume,
        0,
        fadeDuration,
        (value) => {
          const next = Math.round(clampVolume(value));
          const delta = next - lastVolumeInt;
          lastVolumeInt = next;
          if (zone) {
            zone.playerEntry.volume = next;
          }
          if (delta === 0) return Promise.resolve();
          return sendCommandToZone(zoneId, 'volume', String(delta));
        },
        async () => {
          try {
            await sendCommandToZone(zoneId, 'pause');
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn(`[AlertCommands] Failed to pause zone ${zoneId} after fade: ${message}`);
          }

          if (snapshot?.originalVolume !== undefined) {
            const restoreTarget = Math.round(clampVolume(snapshot.originalVolume));
            const delta = restoreTarget - lastVolumeInt;
            lastVolumeInt = restoreTarget;
            if (zone) {
              zone.playerEntry.volume = restoreTarget;
            }
            try {
              if (delta !== 0) {
                await sendCommandToZone(zoneId, 'volume', String(delta));
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              logger.warn(`[AlertCommands] Failed to restore volume for zone ${zoneId} after fade: ${message}`);
            }
          }

          fadeState.delete(fadeKey);
        },
      );
    } else {
      fadeState.delete(fadeKey);
      try {
        await sendCommandToZone(zoneId, 'pause');
        commands.push({ zone: zoneId, command: 'pause' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[AlertCommands] Failed to pause zone ${zoneId}: ${message}`);
        skipped.push({ zone: zoneId, reason: 'pause-failed' });
      }
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

interface AnnouncementPayloadOptions {
  playerGroup?: boolean;
}

function buildAnnouncementCommandPayload(mediaUrl: string, options?: AnnouncementPayloadOptions): string {
  const payload: Record<string, unknown> = {
    url: mediaUrl,
  };

  if (options?.playerGroup) {
    payload.player_group = true;
  }

  return JSON.stringify(payload);
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

function resolveAlertVolume(alertType: string, zoneId: number, fallback: number): number {
  const preset = getStoredVolumePreset(zoneId);
  if (!preset) return fallback;

  const mappedKey = mapAlertTypeToPresetKey(alertType);
  if (mappedKey && preset[mappedKey] !== undefined) {
    return clampVolume(preset[mappedKey]);
  }

  if (preset.default !== undefined) {
    return clampVolume(preset.default);
  }

  return fallback;
}

function mapAlertTypeToPresetKey(alertType: string): keyof ZoneVolumeConfig | undefined {
  switch (alertType) {
    case 'alarm':
      return 'alarm';
    case 'firealarm':
      return 'fire';
    case 'bell':
      return 'bell';
    case 'buzzer':
      return 'buzzer';
    case 'tts':
      return 'tts';
    default:
      return undefined;
  }
}

async function alignZoneToTargetVolume(
  zoneId: number,
  zone: ZoneStateSnapshot,
  targetVolume: number,
  commands: Array<{ zone: number; command: string }>,
  skipped: Array<{ zone: number; reason: string }>,
): Promise<void> {
  const clampedTarget = clampVolume(targetVolume);
  const currentVolume = Math.round(clampVolume(zone.playerEntry?.volume ?? 0));
  const delta = clampedTarget - currentVolume;
  if (delta === 0) {
    return;
  }

  try {
    await sendCommandToZone(zoneId, 'volume', String(delta));
    zone.playerEntry.volume = clampedTarget;
    (zone as any).fadeTargetVolume = clampedTarget;
    commands.push({ zone: zoneId, command: `volume ${delta}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[AlertCommands] Failed to adjust volume for zone ${zoneId}: ${message}`);
    skipped.push({ zone: zoneId, reason: 'volume-adjust-failed' });
  }
}

async function maybeHandleGroupedTtsAlert(context: GroupedTtsContext): Promise<Set<number>> {
  const handled = new Set<number>();
  const { type, media, mediaUrl, fadeRequested, zoneContexts, commands, skipped } = context;

  if (type !== 'tts') return handled;
  if (fadeRequested) return handled;

  const maContexts = zoneContexts.filter((ctx) => ctx.backendName === 'BackendMusicAssistant');
  if (maContexts.length < 2) return handled;

  const leader = maContexts[0];
  const members = maContexts.slice(1);

  const leaderMaId = resolveMusicAssistantPlayerId(leader.zone);
  if (!leaderMaId) {
    logger.warn(`[AlertCommands] Skipping grouped TTS – leader zone ${leader.id} missing Music Assistant ID`);
    return handled;
  }

  const childIds = Array.from(
    new Set(
      members
        .map((entry) => resolveMusicAssistantPlayerId(entry.zone))
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    ),
  );

  if (childIds.length === 0) return handled;

  const originalGroups = captureOriginalGroups(maContexts);
  const tempState: TemporaryGroupState = {
    leaderZoneId: leader.id,
    childMaPlayerIds: childIds,
    originalGroups,
  };

  await alignZoneToTargetVolume(leader.id, leader.zone, leader.targetVolume, commands, skipped);

  try {
    await sendCommandToZone(leader.id, 'groupJoinMany', childIds.join(','));
    commands.push({ zone: leader.id, command: `groupJoinMany ${childIds.join(',')}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[AlertCommands] Failed to create temporary MA group: ${message}`);
    return handled;
  }

  const payload = buildAnnouncementCommandPayload(mediaUrl, { playerGroup: true });

  try {
    await sendCommandToZone(leader.id, 'announce', payload);
    commands.push({ zone: leader.id, command: 'announce (group)' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[AlertCommands] Failed to dispatch grouped TTS: ${message}`);
    skipped.push({ zone: leader.id, reason: 'group-announce-failed' });
    await releaseTemporaryGroup(tempState);
    return handled;
  }

  handled.add(leader.id);
  members.forEach((member) => handled.add(member.id));

  scheduleTemporaryGroupRelease(tempState, estimateTtsDuration(media));
  commands.push({ zone: leader.id, command: 'groupLeaveMany (scheduled)' });

  return handled;
}

function resolveMusicAssistantPlayerId(zone: ZoneStateSnapshot): string | undefined {
  const backendInstance = zone.player?.backendInstance as { maPlayerId?: string } | undefined;
  const maPlayerId = typeof backendInstance?.maPlayerId === 'string' ? backendInstance.maPlayerId.trim() : '';
  return maPlayerId || undefined;
}

function estimateTtsDuration(media: AlertMediaResource): number {
  const textLength = media.text?.length ?? 0;
  if (textLength <= 0) return TEMP_GROUP_FALLBACK_DURATION_MS + TEMP_GROUP_GRACE_MS;

  const estimatedSeconds = textLength / 12;
  const clampedSeconds = Math.min(
    Math.max(estimatedSeconds + 1, TEMP_GROUP_MIN_DURATION_MS / 1000),
    TEMP_GROUP_MAX_DURATION_MS / 1000,
  );
  return Math.round(clampedSeconds * 1000) + TEMP_GROUP_GRACE_MS;
}

function scheduleTemporaryGroupRelease(state: TemporaryGroupState, delayMs: number): void {
  const { leaderZoneId } = state;

  const existing = temporaryGroupTimers.get(leaderZoneId);
  if (existing) {
    clearTimeout(existing.timer);
  }

  const safeDelay = Math.min(
    Math.max(delayMs, TEMP_GROUP_MIN_DURATION_MS),
    TEMP_GROUP_MAX_DURATION_MS + TEMP_GROUP_GRACE_MS,
  );

  const timer = setTimeout(() => {
    void releaseTemporaryGroup(state);
    temporaryGroupTimers.delete(leaderZoneId);
  }, safeDelay);

  temporaryGroupTimers.set(leaderZoneId, { timer, state });
}

async function releaseTemporaryGroup(state: TemporaryGroupState): Promise<void> {
  const { leaderZoneId, childMaPlayerIds, originalGroups } = state;

  const scheduled = temporaryGroupTimers.get(leaderZoneId);
  if (scheduled && scheduled.state === state) {
    clearTimeout(scheduled.timer);
    temporaryGroupTimers.delete(leaderZoneId);
  }

  if (childMaPlayerIds.length > 0) {
    try {
      await sendCommandToZone(leaderZoneId, 'groupLeaveMany', childMaPlayerIds.join(','));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[AlertCommands] Failed to disband temporary MA group: ${message}`);
    }
  }

  await restoreOriginalGroups(originalGroups);
}

function captureOriginalGroups(contexts: ZoneAlertContext[]): OriginalGroupSnapshot[] {
  const snapshots = new Map<number, OriginalGroupSnapshot>();

  for (const ctx of contexts) {
    const existingGroup = getGroupByZone(ctx.id);
    if (!existingGroup || existingGroup.members.length <= 1) continue;
    if (snapshots.has(existingGroup.leader)) continue;

    snapshots.set(existingGroup.leader, {
      leaderId: existingGroup.leader,
      memberZoneIds: existingGroup.members.filter((memberId) => memberId !== existingGroup.leader),
    });
  }

  return Array.from(snapshots.values());
}

async function restoreOriginalGroups(snapshots: OriginalGroupSnapshot[]): Promise<void> {
  for (const snapshot of snapshots) {
    if (snapshot.memberZoneIds.length === 0) continue;

    const leaderZone = getZoneById(snapshot.leaderId);
    if (!leaderZone || leaderZone.player.backend !== 'BackendMusicAssistant') continue;

    const childIds = snapshot.memberZoneIds
      .map((memberId) => {
        const memberZone = getZoneById(memberId);
        if (!memberZone || memberZone.player.backend !== 'BackendMusicAssistant') return undefined;
        return resolveMusicAssistantPlayerId(memberZone);
      })
      .filter((value): value is string => typeof value === 'string' && value.length > 0);

    if (childIds.length === 0) continue;

    try {
      await sendCommandToZone(snapshot.leaderId, 'groupJoinMany', childIds.join(','));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[AlertCommands] Failed to restore MA group ${snapshot.leaderId}: ${message}`);
    }
  }
}
