/**
 * -----------------------------------------------------------------------------
 * Loxone AudioServer HTTP command handlers for group control.
 *
 * Endpoints implemented:
 *   - /audio/cfg/dgroup/update/{groupId}/{zoneList}
 *   - /audio/{zoneId}/mastervolume/{value}
 *   - /audio/grouped/volume/{value}/{zoneList}
 *   - /audio/grouped/{pause|play|resume|stop}/{zoneList}
 *
 * Responsibilities:
 *   - Create, update, and remove dynamic zone groups.
 *   - Synchronize mastervolume and playback across grouped zones.
 *   - Forward volume and playback commands to zoneRuntime.
 *
 * Depends on:
 *   - groupRuntime (broadcasts, mastervolume)
 *   - zoneRuntime (command routing)
 *   - groupTracker (state management)
 * -----------------------------------------------------------------------------
 */

import logger from '@/utils/troxorLogger';
import { response, CommandResult } from '../requestHandler';
import { zoneRuntime } from '@/runtime/zones/zoneRuntime';
import { zoneStateStore } from '@/runtime/zones/zoneStateStore';
import { groupRuntime } from '@/runtime/groups/groupRuntime';
import {
  upsertGroup,
  removeGroupByLeader,
  getGroupByZone,
  getGroupByExternalId,
  getGroupByLeader,
} from '@/runtime/groups/groupTracker';
import { broadcastMessage } from '@/http/loxoneHttp/websocketManager';

/* -------------------------------------------------------------------------- */
/*  Regex patterns for endpoint routing                                       */
/* -------------------------------------------------------------------------- */

const GROUP_UPDATE_RE = /^audio\/cfg\/dgroup\/update\/([^/]+)(?:\/([^/]+))?$/;
const MASTER_VOLUME_RE = /^audio\/(\d+)\/mastervolume\/(-?\d+)(?:\/.*)?$/;
const GROUP_VOLUME_RE = /^audio\/grouped\/volume\/([^/]+)\/([^/]+)(?:\/.*)?$/;
const GROUP_PLAYBACK_RE = /^audio\/grouped\/(pause|play|resume|stop)\/([^/]+)(?:\/.*)?$/;

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/** Clamp a numeric value to the valid Loxone volume range (0–100). */
function clampVolume(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(n)));
}

/* -------------------------------------------------------------------------- */
/*  Group Management                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Handles creation, update, or deletion of dynamic zone groups.
 *
 * Behavior:
 * - "new" groupId creates a new group
 * - Existing IDs update membership
 * - Missing zone list removes the group
 *
 * Also sends backend `groupJoin` / `groupLeave` commands to each zone.
 */
export async function audioCfgDynamicGroup(url: string): Promise<CommandResult> {
  const match = url.match(GROUP_UPDATE_RE);
  if (!match) {
    logger.warn(`[audioCfgDynamicGroup] Invalid URL format: ${url}`);
    return response(url, 'dgroup_update', { success: false, error: 'invalid-url' });
  }

  const groupIdRaw = match[1];
  const zoneListRaw = match[2];

  /* ---------------------------------------------------------------------- */
  /* 1️⃣ Removal branch                                                     */
  /* ---------------------------------------------------------------------- */
  if (!zoneListRaw) {
    const existing = getGroupByExternalId(groupIdRaw);
    if (!existing) {
      logger.warn(`[audioCfgDynamicGroup] Group ${groupIdRaw} not found for removal.`);
      return response(url, 'dgroup_update', { id: groupIdRaw });
    }

    // Backend: send groupLeave to all members and leader
    const allMembers = [existing.leader, ...existing.members];
    for (const id of allMembers) {
      try {
        await zoneRuntime.sendZoneCommand(id, 'groupLeave');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[audioCfgDynamicGroup] Failed groupLeave for zone ${id}: ${msg}`);
      }
    }

    // Remove from tracker and broadcast
    const removed = removeGroupByLeader(existing.leader);
    if (removed) {
      logger.debug(`[audioCfgDynamicGroup] Removed group ${groupIdRaw} (leader ${existing.leader})`);
      broadcastMessage(JSON.stringify({ audio_sync_event: [] }));
    }

    // Return minimal Loxone response
    return response(url, 'dgroup_update', { id: groupIdRaw });
  }

  /* ---------------------------------------------------------------------- */
  /* 2️⃣ Creation / update branch                                           */
  /* ---------------------------------------------------------------------- */
  const zoneIds = zoneListRaw
    .split(',')
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);

  if (zoneIds.length === 0) {
    return response(url, 'dgroup_update', { success: false, error: 'no-zones' });
  }

  const [leader, ...members] = zoneIds;
  const leaderZone = zoneStateStore.getZoneState(leader);
  if (!leaderZone) {
    logger.warn(`[audioCfgDynamicGroup] Leader zone ${leader} not found.`);
    return response(url, 'dgroup_update', { success: false, error: 'leader-missing' });
  }

  // Clean up old group if leader was reused
  const prev = getGroupByExternalId(groupIdRaw) ?? getGroupByLeader(leader);
  if (prev) {
    removeGroupByLeader(prev.leader);
  }

  const externalId = groupIdRaw === 'new' ? `grp-${leader}-${Date.now()}` : groupIdRaw;

  // Save new group definition
  upsertGroup({
    leader,
    members,
    backend: 'Unknown',
    externalId,
    source: 'manual',
  });

  // Backend: leader joins all members
  try {
    await zoneRuntime.sendZoneCommand(leader, 'groupJoinMany', members.join(','));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[audioCfgDynamicGroup] Leader ${leader} failed groupJoinMany: ${msg}`);
  }

  // Backend: each member joins the leader
  for (const id of members) {
    try {
      await zoneRuntime.sendZoneCommand(id, 'groupJoin', leader.toString());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[audioCfgDynamicGroup] Member ${id} failed groupJoin: ${msg}`);
    }
  }

  // Broadcast updated group state
  groupRuntime.broadcastGroupState();

  // Return Loxone-compliant response
  return response(url, 'dgroup_update', { id: externalId });
}

/* -------------------------------------------------------------------------- */
/*  Master Volume Control                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Adjusts the master volume for a zone or its group.
 * Propagates change to all grouped members via backend mappers.
 */
export async function audioMasterVolume(url: string): Promise<CommandResult> {
  const match = url.match(MASTER_VOLUME_RE);
  if (!match) {
    logger.warn(`[audioMasterVolume] Invalid URL: ${url}`);
    return response(url, 'mastervolume', { success: false, error: 'invalid-url' });
  }

  const zoneId = Number(match[1]);
  const target = clampVolume(match[2]);
  if (!Number.isFinite(zoneId) || zoneId <= 0) {
    return response(url, 'mastervolume', { success: false, error: 'invalid-zone' });
  }

  await groupRuntime.applyMasterVolume(zoneId, target);
  const group = getGroupByZone(zoneId);

  return response(url, 'mastervolume', {
    success: true,
    zone: zoneId,
    group: group?.externalId ?? null,
    target,
  });
}

/* -------------------------------------------------------------------------- */
/*  Grouped Volume Control                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Adjusts absolute or relative volume across multiple zones.
 *
 * Accepts:
 *   /audio/grouped/volume/{plus|minus|<value>}/{zoneList}
 */
export async function audioGroupedVolume(url: string): Promise<CommandResult> {
  const match = url.match(GROUP_VOLUME_RE);
  if (!match) {
    return response(url, 'grouped_volume', { success: false, error: 'invalid-url' });
  }

  const valueToken = decodeURIComponent(match[1]);
  const zonesToken = decodeURIComponent(match[2]);

  const zoneIds = zonesToken
    .split(',')
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);

  if (zoneIds.length === 0) {
    return response(url, 'grouped_volume', { success: false, error: 'no-targets' });
  }

  const plusTokens = new Set(['+', 'plus', 'up', 'increase']);
  const minusTokens = new Set(['-', 'minus', 'down', 'decrease']);
  const step = 1;

  const updates: Array<{ zoneId: number; newVolume: number }> = [];
  const skipped: Array<{ zoneId: number; reason: string }> = [];

  for (const id of zoneIds) {
    const zone = zoneStateStore.getZoneState(id);
    if (!zone) {
      skipped.push({ zoneId: id, reason: 'zone-not-found' });
      continue;
    }

    const current = clampVolume(zone.volume);
    let newVolume = current;

    if (plusTokens.has(valueToken)) {
      newVolume = clampVolume(current + step);
    } else if (minusTokens.has(valueToken)) {
      newVolume = clampVolume(current - step);
    } else {
      const numeric = Number(valueToken);
      if (Number.isFinite(numeric)) {
        newVolume = clampVolume(numeric);
      }
    }

    const delta = newVolume - current;
    if (delta === 0) {
      continue;
    }

    try {
      await zoneRuntime.sendZoneCommand(id, 'volume', delta);
      updates.push({ zoneId: id, newVolume });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      skipped.push({ zoneId: id, reason: msg });
    }
  }

  if (updates.length > 0) {
    groupRuntime.broadcastGroupState();
  }

  return response(url, 'grouped_volume', {
    success: updates.length > 0,
    updated: updates,
    skipped,
  });
}

/* -------------------------------------------------------------------------- */
/*  Grouped Playback Control                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Executes playback commands (pause/play/resume/stop) for multiple zones.
 */
export async function audioGroupedPlayback(url: string): Promise<CommandResult> {
  const match = url.match(GROUP_PLAYBACK_RE);
  if (!match) {
    logger.warn(`[audioGroupedPlayback] Invalid URL: ${url}`);
    return response(url, 'grouped_playback', { success: false, error: 'invalid-url' });
  }

  const action = match[1];
  const targets = decodeURIComponent(match[2])
    .split(',')
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);

  const cmdMap: Record<string, string> = {
    pause: 'pause',
    stop: 'stop',
    play: 'resume',
    resume: 'resume',
  };
  const command = cmdMap[action] ?? 'pause';

  const succeeded: number[] = [];
  const skipped: Array<{ zoneId: number; reason: string }> = [];

  for (const id of targets) {
    try {
      await zoneRuntime.sendZoneCommand(id, command);
      succeeded.push(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[audioGroupedPlayback] Failed to send ${command} to zone ${id}: ${msg}`);
      skipped.push({ zoneId: id, reason: msg });
    }
  }

  return response(url, 'grouped_playback', {
    success: succeeded.length > 0,
    action: command,
    updated: succeeded,
    skipped,
  });
}