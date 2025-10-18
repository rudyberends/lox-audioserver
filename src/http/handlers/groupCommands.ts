import { CommandResult, response } from './commandTypes';
import logger from '../../utils/troxorlogger';
import {
  sendCommandToZone,
  sendGroupCommandToZone,
  updateZoneGroup,
  getZoneById,
  applyMasterVolumeToGroup,
  updateZonePlayerStatus,
} from '../../backend/zone/zonemanager';
import {
  upsertGroup,
  removeGroupByLeader,
  getGroupByExternalId,
  getGroupByLeader,
  getGroupByZone,
} from '../../backend/zone/groupTracker';

const GROUP_UPDATE_RE = /^audio\/cfg\/dgroup\/update\/([^/]+)(?:\/([^/]+))?$/;
const MASTER_VOLUME_RE = /^audio\/(\d+)\/mastervolume\/(-?\d+)(?:\/.*)?$/;
const GROUP_VOLUME_RE = /^audio\/grouped\/volume\/([^/]+)\/([^/]+)(?:\/.*)?$/;
const GROUP_PLAYBACK_RE = /^audio\/grouped\/(pause|play|resume|stop)\/([^/]+)(?:\/.*)?$/;
const GROUP_VOLUME_STEP = 1;

export async function audioCfgDynamicGroup(url: string): Promise<CommandResult> {
  const match = url.match(GROUP_UPDATE_RE);
  if (!match) {
    logger.warn(`[audioCfgDynamicGroup] Invalid URL format: ${url}`);
    return response(url, 'dgroup_update', { success: false, error: 'invalid-url' });
  }

  const groupIdRaw = match[1];
  const zoneListRaw = match[2];

  if (groupIdRaw === 'new') {
    if (!zoneListRaw) {
      logger.warn(`[audioCfgDynamicGroup] Missing zone list for new group creation in ${url}`);
      return response(url, 'dgroup_update', { success: false, error: 'no-zones' });
    }

    const zoneIds = zoneListRaw
      .split(',')
      .map((zone) => Number(zone))
      .filter((zone) => Number.isFinite(zone) && zone > 0);

    if (zoneIds.length === 0) {
      logger.warn(`[audioCfgDynamicGroup] No valid zone IDs provided for new group in ${url}`);
      return response(url, 'dgroup_update', { success: false, error: 'no-zones' });
    }

    const [leader, ...members] = zoneIds;
    const leaderZone = getZoneById(leader);
    if (!leaderZone) {
      logger.warn(`[audioCfgDynamicGroup] Leader zone ${leader} not found.`);
      return response(url, 'dgroup_update', { success: false, error: 'leader-missing' });
    }

    const groupId = `grp-${leader}-${Date.now()}`;

    await sendGroupCommandToZone('groupJoinMany', 'Audio', [leader, ...members].join(','));

    const { changed } = upsertGroup({
      leader,
      members,
      backend: leaderZone.player.backend ?? 'Unknown',
      externalId: groupId,
      source: 'manual',
    });
    if (changed) updateZoneGroup();
    return response(url, 'dgroup_update', { success: true, group: { id: groupId, leader, members } });
  }

  if (!zoneListRaw) {
    const existing = getGroupByExternalId(groupIdRaw);

    if (!existing) {
      logger.warn(`[audioCfgDynamicGroup] Group ${groupIdRaw} not found for removal.`);
      return response(url, 'dgroup_update', { success: false, error: 'group-missing' });
    }

    const leaderZone = getZoneById(existing.leader);
    const members = existing.members.filter((member) => member !== existing.leader);

    if (!leaderZone) {
      logger.warn(`[audioCfgDynamicGroup] Leader zone ${existing.leader} not found while removing group ${groupIdRaw}.`);
    } else if (members.length > 0) {
      await sendGroupCommandToZone('groupLeaveMany', 'Audio', [existing.leader, ...members].join(','));
    } else {
      await sendCommandToZone(existing.leader, 'groupLeave');
    }

    const removed = removeGroupByLeader(existing.leader);
    if (removed) updateZoneGroup();
    return response(url, 'dgroup_update', { success: true, removed: groupIdRaw });
  }

  const zoneIds = zoneListRaw
    .split(',')
    .map((zone) => Number(zone))
    .filter((zone) => Number.isFinite(zone) && zone > 0);

  if (zoneIds.length === 0) {
    logger.warn(`[audioCfgDynamicGroup] No valid zone IDs provided in ${url}`);
    return response(url, 'dgroup_update', { success: false, error: 'no-zones' });
  }

  const [leader, ...members] = zoneIds;
  const leaderZone = getZoneById(leader);
  if (!leaderZone) {
    logger.warn(`[audioCfgDynamicGroup] Leader zone ${leader} not found for update.`);
    return response(url, 'dgroup_update', { success: false, error: 'leader-missing' });
  }

  const previousRecord = getGroupByExternalId(groupIdRaw) ?? getGroupByLeader(leader);
  const previousMembers = previousRecord
    ? previousRecord.members.filter((member) => member !== previousRecord.leader)
    : [];

  const addedMembers = members.filter((member) => !previousMembers.includes(member));
  const removedMembers = previousMembers.filter((member) => !members.includes(member));

  let changed =
    addedMembers.length > 0 || removedMembers.length > 0 || (previousRecord && previousRecord.leader !== leader);

  if (addedMembers.length > 0) {
    await sendGroupCommandToZone('groupJoinMany', 'Audio', [leader, ...addedMembers].join(','));
  }

  if (removedMembers.length > 0) {
    await sendGroupCommandToZone('groupLeaveMany', 'Audio', [leader, ...removedMembers].join(','));
  }

  if (previousRecord && previousRecord.leader !== leader) {
    const replaced = removeGroupByLeader(previousRecord.leader);
    changed = changed || replaced;
  }

  const result = upsertGroup({
    leader,
    members,
    backend: leaderZone.player.backend ?? 'Unknown',
    externalId: groupIdRaw,
    source: 'manual',
  });
  changed = changed || result.changed;
  if (changed) updateZoneGroup();
  return response(url, 'dgroup_update', { success: true, group: { id: groupIdRaw, leader, members } });
}

export async function audioMasterVolume(url: string): Promise<CommandResult> {
  const match = url.match(MASTER_VOLUME_RE);
  if (!match) {
    logger.warn(`[audioMasterVolume] Invalid URL format: ${url}`);
    return response(url, 'mastervolume', { success: false, error: 'invalid-url' });
  }

  const zoneId = Number(match[1]);
  const requestedVolume = Number(match[2]);

  if (!Number.isFinite(zoneId) || zoneId <= 0 || !Number.isFinite(requestedVolume)) {
    logger.warn(`[audioMasterVolume] Invalid payload: zone=${match[1]} volume=${match[2]}`);
    return response(url, 'mastervolume', { success: false, error: 'invalid-payload' });
  }

  const trackedGroup = getGroupByZone(zoneId);

  const clamp = (value: number): number => {
    if (!Number.isFinite(value)) return 0;
    if (value < 0) return 0;
    if (value > 100) return 100;
    return Math.round(value);
  };

  if (!trackedGroup || trackedGroup.leader === zoneId) {
    const result = await applyMasterVolumeToGroup(zoneId, requestedVolume);
    const success = result.updates.length > 0;

    return response(url, 'mastervolume', {
      success,
      zone: zoneId,
      group: result.groupId ?? null,
      target: result.targetVolume,
      updated: result.updates,
      skipped: result.skipped,
    });
  }

  const zone = getZoneById(zoneId);
  if (!zone) {
    return response(url, 'mastervolume', {
      success: false,
      zone: zoneId,
      group: trackedGroup.externalId ?? null,
      target: null,
      updated: [],
      skipped: [{ zoneId, reason: 'zone-not-found' }],
    });
  }

  const targetVolume = clamp(requestedVolume);
  const currentVolume = clamp(Number(zone.playerEntry?.volume ?? 0));
  const delta = targetVolume - currentVolume;

  const skipped: Array<{ zoneId: number; reason: string }> = [];
  const updated: Array<{ zoneId: number; volume: number }> = [];

  try {
    if (delta !== 0) {
      await sendCommandToZone(zoneId, 'volume', String(delta));
    }
    updateZonePlayerStatus(zoneId, { volume: targetVolume });
    updated.push({ zoneId, volume: targetVolume });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[audioMasterVolume] Failed to adjust volume for zone ${zoneId}: ${message}`);
    skipped.push({ zoneId, reason: 'command-failed' });
  }

  return response(url, 'mastervolume', {
    success: updated.length > 0,
    zone: zoneId,
    group: trackedGroup.externalId ?? null,
    target: targetVolume,
    updated,
    skipped,
  });
}

export async function audioGroupedVolume(url: string): Promise<CommandResult> {
  const match = url.match(GROUP_VOLUME_RE);
  if (!match) {
    logger.warn(`[audioGroupedVolume] Invalid URL format: ${url}`);
    return response(url, 'grouped_volume', {
      success: false,
      error: 'invalid-url',
    });
  }

  const valueTokenRaw = match[1] ?? '';
  const targetsTokenRaw = match[2] ?? '';

  const decodedTargets = decodeURIComponent(targetsTokenRaw);
  const targetIds = decodedTargets
    .split(',')
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry) && entry > 0);

  if (targetIds.length === 0) {
    logger.warn(`[audioGroupedVolume] No valid target zones resolved from "${decodedTargets}"`);
    return response(url, 'grouped_volume', {
      success: false,
      error: 'no-targets',
      targets: [],
    });
  }

  const candidateGroup = targetIds
    .map((id) => getGroupByZone(id))
    .find((record) => record && record.members.length > 1);

  const candidateLeader = candidateGroup?.leader ?? targetIds[0];

  const leaderZone = getZoneById(candidateLeader);
  if (!leaderZone) {
    logger.warn(`[audioGroupedVolume] Leader zone ${candidateLeader} not found for ${url}`);
    return response(url, 'grouped_volume', {
      success: false,
      error: 'leader-missing',
      targets: targetIds,
    });
  }

  const normalizedValue = decodeURIComponent(valueTokenRaw).trim().toLowerCase();
  const clamp = (value: number): number => {
    if (!Number.isFinite(value)) return 0;
    if (value < 0) return 0;
    if (value > 100) return 100;
    return Math.round(value);
  };

  const currentVolume = clamp(Number(leaderZone.playerEntry?.volume ?? 0));
  let targetVolume: number | undefined;

  const plusTokens = new Set(['plus', 'true', '1', 'up', 'increase', '+']);
  const minusTokens = new Set(['minus', 'false', '0', 'down', 'decrease', '-']);

  if (plusTokens.has(normalizedValue)) {
    targetVolume = clamp(currentVolume + GROUP_VOLUME_STEP);
  } else if (minusTokens.has(normalizedValue)) {
    targetVolume = clamp(currentVolume - GROUP_VOLUME_STEP);
  } else {
    const numeric = Number(normalizedValue);
    if (Number.isFinite(numeric)) {
      targetVolume = clamp(numeric);
    } else {
      logger.warn(`[audioGroupedVolume] Unsupported volume token "${valueTokenRaw}"`);
      return response(url, 'grouped_volume', {
        success: false,
        error: 'invalid-volume-token',
        token: valueTokenRaw,
        targets: targetIds,
      });
    }
  }

  const mode: 'plus' | 'minus' | 'absolute' = plusTokens.has(normalizedValue)
    ? 'plus'
    : minusTokens.has(normalizedValue)
      ? 'minus'
      : 'absolute';
  const absoluteTarget = mode === 'absolute' ? clamp(Number(normalizedValue)) : undefined;

  const targetZoneIdsRaw = mode === 'absolute' ? [targetIds[targetIds.length - 1]] : targetIds;
  const targetZoneIds = Array.from(new Set(targetZoneIdsRaw));

  const players: Array<{ playerid: number; volume: number }> = [];
  const skipped: Array<{ playerid: number; reason: string }> = [];

  for (const zoneId of targetZoneIds) {
    const zone = getZoneById(zoneId);
    if (!zone) {
      skipped.push({ playerid: zoneId, reason: 'zone-not-found' });
      continue;
    }

    const current = clamp(Number(zone.playerEntry?.volume ?? 0));
    let desired = current;
    if (mode === 'plus') desired = clamp(current + GROUP_VOLUME_STEP);
    else if (mode === 'minus') desired = clamp(current - GROUP_VOLUME_STEP);
    else if (absoluteTarget !== undefined) desired = absoluteTarget;

    const delta = desired - current;

    try {
      if (delta !== 0) {
        await sendCommandToZone(zoneId, 'volume', String(delta));
      }
      updateZonePlayerStatus(zoneId, { volume: desired });
      players.push({ playerid: zoneId, volume: desired });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[audioGroupedVolume] Failed to adjust volume for zone ${zoneId}: ${message}`);
      skipped.push({ playerid: zoneId, reason: 'command-failed' });
    }
  }

  // No group membership changes here; avoid triggering mastervolume synchronisation.

  return response(url, 'grouped_volume', {
    success: players.length > 0,
    group: candidateGroup?.externalId ?? null,
    target: absoluteTarget ?? null,
    leader: candidateGroup?.leader ?? candidateLeader,
    players,
    skipped,
  });
}

export async function audioGroupedPlayback(url: string): Promise<CommandResult> {
  const match = url.match(GROUP_PLAYBACK_RE);
  if (!match) {
    logger.warn(`[audioGroupedPlayback] Invalid URL format: ${url}`);
    return response(url, 'grouped_playback', {
      success: false,
      error: 'invalid-url',
    });
  }

  const action = match[1];
  const targetsTokenRaw = match[2] ?? '';

  const decodedTargets = decodeURIComponent(targetsTokenRaw);
  const targetIds = decodedTargets
    .split(',')
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry) && entry > 0);

  if (targetIds.length === 0) {
    logger.warn(`[audioGroupedPlayback] No valid target zones resolved from "${decodedTargets}"`);
    return response(url, 'grouped_playback', {
      success: false,
      error: 'no-targets',
      targets: [],
    });
  }

  const commandMap: Record<string, string> = {
    pause: 'pause',
    stop: 'stop',
    play: 'resume',
    resume: 'resume',
  };
  const zoneCommand = commandMap[action] ?? 'pause';

  const succeeded: number[] = [];
  const skipped: Array<{ playerid: number; reason: string }> = [];

  for (const zoneId of targetIds) {
    const zone = getZoneById(zoneId);
    if (!zone) {
      skipped.push({ playerid: zoneId, reason: 'zone-not-found' });
      continue;
    }

    try {
      await sendCommandToZone(zoneId, zoneCommand);
      succeeded.push(zoneId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[audioGroupedPlayback] Failed to execute ${zoneCommand} for zone ${zoneId}: ${message}`);
      skipped.push({ playerid: zoneId, reason: 'command-failed' });
    }
  }

  return response(url, 'grouped_playback', {
    success: succeeded.length > 0,
    action: zoneCommand,
    targets: targetIds,
    updated: succeeded,
    skipped,
  });
}
