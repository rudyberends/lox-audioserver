import type { GroupChangeListener, GroupRecord } from '@/ports/types/groups';

/**
 * Port for the in-memory audio sync-group registry. Adapters depend on this
 * abstraction instead of reaching directly into application module state.
 */
export interface GroupTrackerPort {
  upsertGroup(input: Omit<GroupRecord, 'updatedAt'>): { record: GroupRecord; changed: boolean };
  removeGroupByLeader(leader: number): boolean;
  getGroupByZone(zoneId: number): GroupRecord | undefined;
  getGroupByLeader(leader: number): GroupRecord | undefined;
  getGroupByExternalId(externalId: string): GroupRecord | undefined;
  onGroupChanged(listener: GroupChangeListener): () => void;
  setJoinedLeader(zoneId: number, leaderZoneId: number): void;
  getJoinedLeader(zoneId: number): number | null;
  clearJoinedLeader(zoneId: number): void;
}
