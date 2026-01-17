import { buildResponse } from '@/modules/loxone/commands/responses';
import { groupManager } from '@/modules/groups';
import {
  getGroupByExternalId,
  getGroupByLeader,
  getGroupByZone,
  removeGroupByLeader,
} from '@/modules/groups/groupTracker';
import { zoneManager } from '@/modules/zones/zoneManager';
import { createLogger } from '@/core/logging/logger';

function clampVolume(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(n)));
}

const GROUP_UPDATE_RE = /^audio\/cfg\/dgroup\/update\/([^/]+)(?:\/([^/]+))?$/;
const MASTER_VOLUME_RE = /^audio\/(\d+)\/mastervolume\/(-?\d+)(?:\/.*)?$/;
const GROUP_VOLUME_RE = /^audio\/grouped\/volume\/([^/]+)\/([^/]+)(?:\/.*)?$/;
const GROUP_PLAYBACK_RE = /^audio\/grouped\/(pause|play|resume|stop)\/([^/]+)(?:\/.*)?$/;

function resolveOutputProtocol(zoneId: number): string {
  const snapshot = zoneManager.getTechnicalSnapshot(zoneId);
  if (!snapshot) {
    return 'unknown';
  }
  const fallback = snapshot.transports.find((type) => type !== 'spotify-input') ?? null;
  return snapshot.activeOutput ?? fallback ?? 'unknown';
}

function filterMembersByProtocol(leader: number, members: number[]): number[] {
  const leaderProtocol = resolveOutputProtocol(leader);
  return members.filter((memberId) => resolveOutputProtocol(memberId) === leaderProtocol);
}

export async function audioCfgDynamicGroup(command: string) {
  const match = command.match(GROUP_UPDATE_RE);
  if (!match) {
    return buildResponse(command, 'dgroup_update', { success: false, error: 'invalid-url' });
  }

  const groupIdRaw = match[1];
  const zoneListRaw = match[2];

  if (!zoneListRaw) {
    const existing = getGroupByExternalId(groupIdRaw);
    if (existing) {
      groupManager.removeGroup(groupIdRaw);
    }
    return buildResponse(command, 'dgroup_update', { id: groupIdRaw });
  }

  const zoneIds = zoneListRaw
    .split(',')
    .map(Number)
    .filter((id) => Number.isFinite(id) && id > 0);

  if (!zoneIds.length) {
    return buildResponse(command, 'dgroup_update', { success: false, error: 'no-zones' });
  }

  const [leader, ...members] = zoneIds;
  const leaderState = zoneManager.getState(leader);
  if (!leaderState) {
    return buildResponse(command, 'dgroup_update', { success: false, error: 'leader-missing' });
  }
  const filteredMembers = filterMembersByProtocol(leader, members);
  const droppedMembers = members.filter((memberId) => !filteredMembers.includes(memberId));
  if (droppedMembers.length) {
    createLogger('Groups', 'Handlers').debug('dropped group members (protocol mismatch)', {
      leader,
      droppedMembers,
    });
  }

  const existing = getGroupByExternalId(groupIdRaw) ?? getGroupByLeader(leader);
  if (existing) {
    removeGroupByLeader(existing.leader);
  }

  const externalId =
    groupIdRaw === 'new'
      ? `grp-${leader}-${resolveOutputProtocol(leader)}-${Date.now().toString(36)}`
      : groupIdRaw;
  groupManager.upsert({
    leader,
    members: filteredMembers,
    backend: 'Unknown',
    externalId,
    source: 'manual',
  });

  return buildResponse(command, 'dgroup_update', { id: externalId });
}

export async function audioMasterVolume(command: string) {
  const match = command.match(MASTER_VOLUME_RE);
  if (!match) {
    return buildResponse(command, 'mastervolume', { success: false, error: 'invalid-url' });
  }

  const zoneId = Number(match[1]);
  const target = clampVolume(match[2]);
  const leaderState = zoneManager.getState(zoneId);

  if (!leaderState) {
    return buildResponse(command, 'mastervolume', { success: false, error: 'zone-not-found' });
  }

  await groupManager.applyMasterVolume(zoneId, target);
  const group = getGroupByZone(zoneId);

  return buildResponse(command, 'mastervolume', {
    success: true,
    target,
    group: group?.externalId ?? null,
  });
}

export async function audioGroupedVolume(command: string) {
  const match = command.match(GROUP_VOLUME_RE);
  if (!match) {
    return buildResponse(command, 'grouped_volume', { success: false, error: 'invalid-url' });
  }

  const valueToken = decodeURIComponent(match[1]);
  const zonesToken = decodeURIComponent(match[2]);
  const zoneIds = zonesToken
    .split(',')
    .map(Number)
    .filter((id) => id > 0);

  const results: Array<{ zoneId: number; newVolume: number }> = [];
  const skipped: Array<{ zoneId: number; reason: string }> = [];
  const plus = new Set(['+', 'plus', 'up']);
  const minus = new Set(['-', 'minus', 'down']);

  for (const zoneId of zoneIds) {
    const state = zoneManager.getState(zoneId);
    if (!state) {
      skipped.push({ zoneId, reason: 'zone-not-found' });
      continue;
    }

    const current = clampVolume(state.volume);
    let next = current;
    if (plus.has(valueToken)) {
      next = current + 1;
    } else if (minus.has(valueToken)) {
      next = current - 1;
    } else {
      next = clampVolume(Number(valueToken));
    }

    next = clampVolume(next);

    try {
      zoneManager.handleCommand(zoneId, 'volume_set', String(next));
      results.push({ zoneId, newVolume: next });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      skipped.push({ zoneId, reason });
    }
  }

  if (results.length > 0) {
    groupManager.broadcastGroupState();
  }

  return buildResponse(command, 'grouped_volume', {
    success: results.length > 0,
    updated: results,
    skipped,
  });
}

export async function audioGroupedPlayback(command: string) {
  const match = command.match(GROUP_PLAYBACK_RE);
  if (!match) {
    return buildResponse(command, 'grouped_playback', { success: false, error: 'invalid-url' });
  }

  const action = match[1];
  const targets = decodeURIComponent(match[2])
    .split(',')
    .map(Number)
    .filter((id) => id > 0);

  const cmdMap: Record<string, 'pause' | 'resume' | 'stop'> = {
    pause: 'pause',
    stop: 'stop',
    play: 'resume',
    resume: 'resume',
  };

  const mapped = cmdMap[action];

  const updated: number[] = [];
  const skipped: Array<{ zoneId: number; reason: string }> = [];

  for (const zoneId of targets) {
    const state = zoneManager.getState(zoneId);
    if (!state) {
      skipped.push({ zoneId, reason: 'zone-not-found' });
      continue;
    }

    try {
      zoneManager.handleCommand(zoneId, mapped);
      updated.push(zoneId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      skipped.push({ zoneId, reason });
    }
  }

  return buildResponse(command, 'grouped_playback', {
    success: updated.length > 0,
    action: mapped,
    updated,
    skipped,
  });
}
