import logger from '@/utils/troxorLogger';
import { upsertGroup, removeGroupByLeader } from '@/runtime/groups/groupTracker';
import { zoneStateStore } from '@/runtime/zones/zoneStateStore';
import { getGroupByZone } from '@/runtime/groups/groupTracker';
import { setAdapterProp } from '@/runtime/zones/types/zoneStateTypes';

export interface JoinContext<TLeaderId = string> {
  zoneId?: number;
  zoneName: string;
  getLeaderExternalId: (leaderZoneId: number) => TLeaderId | undefined;
  joinBackend: (leaderExternalId: TLeaderId) => Promise<void>;
}

export async function joinLeaderGeneric<TLeaderId = string>(ctx: JoinContext<TLeaderId>): Promise<void> {
  if (!ctx.zoneId) {
    return;
  }
  const group = getGroupByZone(ctx.zoneId);
  if (!group) {
    logger.warn(`[Group][${ctx.zoneName}] No group found → join skipped`);
    return;
  }

  const leaderZone = zoneStateStore.getZoneState(group.leader);
  const externalId = ctx.getLeaderExternalId(group.leader);
  if (!externalId) {
    logger.warn(`[Group][${ctx.zoneName}] Leader ${group.leader} has no external id`);
    return;
  }

  const thisZone = zoneStateStore.getZoneState(ctx.zoneId);
  if (thisZone) {
    setAdapterProp(thisZone, 'joinedLeader', group.leader);
  }

  try {
    logger.info(`[Group][${ctx.zoneName}] Joining leader ${group.leader} (${String(externalId)})`);
    await ctx.joinBackend(externalId);
  } catch (err) {
    logger.error(`[Group][${ctx.zoneName}] Join failed: ${String(err)}`);
  }
}

export interface LeaveContext {
  zoneId?: number;
  zoneName: string;
  leaveBackend: () => Promise<void>;
}

export async function leaveGroupGeneric(ctx: LeaveContext): Promise<void> {
  if (!ctx.zoneId) {
    return;
  }
  const group = getGroupByZone(ctx.zoneId);
  if (!group) {
    return;
  }
  if (ctx.zoneId === group.leader) {
    logger.info(`[Group][${ctx.zoneName}] Leader keeps playing (no detach)`);
    return;
  }
  try {
    await ctx.leaveBackend();
    logger.info(`[Group][${ctx.zoneName}] Detached from group ${group.leader}`);
  } catch (err) {
    logger.error(`[Group][${ctx.zoneName}] Leave group failed: ${String(err)}`);
  }
}

export function normalizeMembers<T>(
  raw: T | T[] | undefined | null,
  toId: (v: T) => number | undefined,
): number[] {
  const arr = (Array.isArray(raw) ? raw : raw ? [raw] : []) as T[];
  const ids = arr.map((v) => toId(v)).filter((n): n is number => typeof n === 'number');
  return Array.from(new Set(ids));
}

export function updateGroupFromBackend(options: {
  adapter: string;
  zoneName: string;
  leaderZoneId: number;
  memberZoneIds: number[];
  externalId?: string;
}): void {
  const { adapter, zoneName, leaderZoneId, memberZoneIds, externalId } = options;
  if (!memberZoneIds.includes(leaderZoneId)) memberZoneIds.unshift(leaderZoneId);
  if (memberZoneIds.length <= 1) return;
  const { changed } = upsertGroup({
    leader: leaderZoneId,
    members: memberZoneIds,
    backend: adapter,
    externalId: externalId || `${adapter}-${leaderZoneId}`,
    source: 'backend',
  });
  if (changed) {
    logger.info(`[${adapter}][${zoneName}] Group updated via backend (leader=${leaderZoneId}, members=${memberZoneIds.join(', ')})`);
  }
}

export function disbandGroupFromBackend(adapter: string, zoneName: string, leaderZoneId: number): void {
  const removed = removeGroupByLeader(leaderZoneId);
  if (removed) {
    logger.info(`[${adapter}][${zoneName}] Group disbanded by backend (leader=${leaderZoneId})`);
  }
}
