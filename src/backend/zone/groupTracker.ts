type GroupSource = 'manual' | 'backend';

export interface GroupRecord {
  leader: number;
  members: number[]; // always includes leader
  backend: string;
  externalId?: string;
  source: GroupSource;
  updatedAt: number;
}

interface UpsertOptions {
  leader: number;
  members: number[];
  backend: string;
  externalId?: string;
  source: GroupSource;
}

const groupsByLeader = new Map<number, GroupRecord>();
const leaderByZone = new Map<number, number>();
const leaderByExternalId = new Map<string, number>();

function normaliseMembers(leader: number, members: number[]): number[] {
  const unique = new Set<number>();
  unique.add(Math.floor(leader));
  members.forEach((value) => {
    const numeric = Math.floor(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      unique.add(numeric);
    }
  });

  const sorted = Array.from(unique).sort((a, b) => a - b);
  const leaderIndex = sorted.indexOf(Math.floor(leader));
  if (leaderIndex > 0) {
    sorted.splice(leaderIndex, 1);
    sorted.unshift(Math.floor(leader));
  }
  return sorted;
}

export function upsertGroup(options: UpsertOptions): { record: GroupRecord; changed: boolean } {
  const leader = Math.floor(options.leader);
  const members = normaliseMembers(leader, options.members);
  members.forEach((zoneId) => leaderByZone.set(zoneId, leader));

  const previous = groupsByLeader.get(leader);
  const previousMembers = previous?.members ?? [];
  const membersChanged =
    previousMembers.length !== members.length ||
    previousMembers.some((value, index) => value !== members[index]);
  const backendChanged = previous?.backend !== options.backend;
  const externalChanged = previous?.externalId !== options.externalId;
  const sourceChanged = previous?.source !== options.source;
  const somethingChanged = !previous || membersChanged || backendChanged || externalChanged || sourceChanged;

  if (previous?.externalId && previous.externalId !== options.externalId) {
    leaderByExternalId.delete(previous.externalId);
  }

  const record: GroupRecord = {
    leader,
    members,
    backend: options.backend,
    externalId: options.externalId,
    source: options.source,
    updatedAt: Date.now(),
  };

  groupsByLeader.set(leader, record);
  if (options.externalId) {
    leaderByExternalId.set(options.externalId, leader);
  }
  return { record, changed: somethingChanged };
}

export function removeGroupByLeader(leader: number): boolean {
  const record = groupsByLeader.get(leader);
  if (record) {
    if (record.externalId) {
      leaderByExternalId.delete(record.externalId);
    }
    record.members.forEach((zoneId) => {
      if (leaderByZone.get(zoneId) === leader) {
        leaderByZone.delete(zoneId);
      }
    });
    groupsByLeader.delete(leader);
    return true;
  }
  return false;
}

export function removeZoneFromGroups(zoneId: number): boolean {
  const leader = leaderByZone.get(zoneId);
  if (leader === undefined) return false;

  const record = groupsByLeader.get(leader);
  leaderByZone.delete(zoneId);

  if (!record) return false;

  if (leader === zoneId) {
    return removeGroupByLeader(leader);
  }

  const remaining = record.members.filter((member) => member !== zoneId);
  if (remaining.length <= 1) {
    return removeGroupByLeader(leader);
  }

  const updated: GroupRecord = {
    ...record,
    members: remaining,
    updatedAt: Date.now(),
  };
  groupsByLeader.set(leader, updated);
  return true;
}

export function removeGroupsByBackend(backend: string): void {
  const leaders = Array.from(groupsByLeader.values())
    .filter((record) => record.backend === backend)
    .map((record) => record.leader);
  leaders.forEach((leader) => removeGroupByLeader(leader));
}

export function getGroupByZone(zoneId: number): GroupRecord | undefined {
  const leader = leaderByZone.get(zoneId);
  if (leader === undefined) return undefined;
  const record = groupsByLeader.get(leader);
  if (!record) return undefined;
  return {
    ...record,
    members: [...record.members],
  };
}

export function getGroupByLeader(leader: number): GroupRecord | undefined {
  const record = groupsByLeader.get(leader);
  if (!record) return undefined;
  return {
    ...record,
    members: [...record.members],
  };
}

export function getGroupByExternalId(externalId: string): GroupRecord | undefined {
  const leader = leaderByExternalId.get(externalId);
  if (leader === undefined) return undefined;
  return getGroupByLeader(leader);
}

export function getAllGroups(): GroupRecord[] {
  return Array.from(groupsByLeader.values()).map((record) => ({
    ...record,
    members: [...record.members],
  }));
}

export function clearAllGroups(): void {
  groupsByLeader.clear();
  leaderByZone.clear();
  leaderByExternalId.clear();
}
