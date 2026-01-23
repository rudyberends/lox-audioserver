import { createLogger } from '@/shared/logging/logger';
import type { GroupRecord } from '@/application/groups/types/groupRecord';

export type GroupChangeEvent = 'new' | 'update' | 'remove';

export type GroupChangeListener = (
  event: GroupChangeEvent,
  leader: number,
  record?: GroupRecord,
) => void;

const log = createLogger('Groups', 'Tracker');

/** Groups indexed by leader zone ID */
const groupsByLeader = new Map<number, GroupRecord>();
/** Reverse lookup: member zone → leader zone */
const leaderByZone = new Map<number, number>();
/** External backend ID → leader zone */
const leaderByExternalId = new Map<string, number>();
/** Event listeners */
const listeners = new Set<GroupChangeListener>();
/** Tracks a zone's chosen leader for join operations (adapter metadata) */
const joinedLeaderMap = new Map<number, number>();

export function setJoinedLeader(zoneId: number, leaderZoneId: number): void {
  joinedLeaderMap.set(zoneId, leaderZoneId);
}

export function getJoinedLeader(zoneId: number): number | null {
  return joinedLeaderMap.get(zoneId) ?? null;
}

export function clearJoinedLeader(zoneId: number): void {
  joinedLeaderMap.delete(zoneId);
}

function normalizeMembers(leader: number, members: number[]): number[] {
  const unique = new Set<number>();
  unique.add(leader);
  for (const member of members) {
    const id = Math.floor(member);
    if (Number.isFinite(id) && id > 0) {
      unique.add(id);
    }
  }
  const sorted = Array.from(unique).sort((a, b) => a - b);
  const leaderIndex = sorted.indexOf(leader);
  if (leaderIndex > 0) {
    sorted.splice(leaderIndex, 1);
    sorted.unshift(leader);
  }
  return sorted;
}

function emitChange(event: GroupChangeEvent, leader: number, record?: GroupRecord): void {
  for (const listener of listeners) {
    try {
      listener(event, leader, record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('group change listener failed', { event, leader, message });
    }
  }
}

export function upsertGroup(
  input: Omit<GroupRecord, 'updatedAt'>,
): { record: GroupRecord; changed: boolean } {
  const leader = Math.floor(input.leader);
  const members = normalizeMembers(leader, input.members);
  members.forEach((zoneId) => leaderByZone.set(zoneId, leader));

  const previous = groupsByLeader.get(leader);
  const changed =
    !previous ||
    previous.backend !== input.backend ||
    previous.externalId !== input.externalId ||
    previous.source !== input.source ||
    previous.members.join(',') !== members.join(',');

  const record: GroupRecord = {
    leader,
    members,
    backend: input.backend,
    externalId: input.externalId,
    source: input.source,
    updatedAt: Date.now(),
  };

  groupsByLeader.set(leader, record);
  if (input.externalId) {
    leaderByExternalId.set(input.externalId, leader);
  }

  if (!previous) {
    emitChange('new', leader, record);
  } else if (changed) {
    emitChange('update', leader, record);
  }

  return { record, changed };
}

export function removeGroupByLeader(leader: number): boolean {
  const record = groupsByLeader.get(leader);
  if (!record) {
    return false;
  }
  if (record.externalId) {
    leaderByExternalId.delete(record.externalId);
  }
  record.members.forEach((zoneId) => leaderByZone.delete(zoneId));
  groupsByLeader.delete(leader);
  emitChange('remove', leader, record);
  return true;
}

export function getGroupByZone(zoneId: number): GroupRecord | undefined {
  const leader = leaderByZone.get(zoneId);
  return leader ? groupsByLeader.get(leader) : undefined;
}

export function getGroupByLeader(leader: number): GroupRecord | undefined {
  return groupsByLeader.get(leader);
}

export function getGroupByExternalId(externalId: string): GroupRecord | undefined {
  const leader = leaderByExternalId.get(externalId);
  return leader ? groupsByLeader.get(leader) : undefined;
}

export function getAllGroups(): ReadonlyArray<GroupRecord> {
  return Array.from(groupsByLeader.values());
}

export function getCurrentGroups(): ReadonlyArray<GroupRecord> {
  return getAllGroups();
}

export function clearAllGroups(): void {
  groupsByLeader.clear();
  leaderByZone.clear();
  leaderByExternalId.clear();
  listeners.clear();
  joinedLeaderMap.clear();
}

export function onGroupChanged(listener: GroupChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
