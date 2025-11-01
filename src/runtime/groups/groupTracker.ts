/**
 * -----------------------------------------------------------------------------
 * groupTracker.ts
 * -----------------------------------------------------------------------------
 * Pure in-memory tracker for dynamic or backend-created audio groups.
 *
 * Responsibilities:
 * - Maintain bi-directional mapping between zones and their groups.
 * - Allow fast lookup by leader, member, or externalId.
 * - Provide immutable read methods and transactional upsert/remove operations.
 * - Emits strongly typed change events to notify GroupRuntime.
 * -----------------------------------------------------------------------------
 */

import logger from '@/utils/troxorLogger';
import { GroupRecord } from './types/groupRecord';

/** Type of change emitted when a group is modified. */
export type GroupChangeEvent = 'new' | 'update' | 'remove';

/** Callback signature for group change listeners. */
export type GroupChangeListener = (event: GroupChangeEvent, leader: number, record?: GroupRecord) => void;

/* -------------------------------------------------------------------------- */
/* Internal maps                                                              */
/* -------------------------------------------------------------------------- */

const groupsByLeader = new Map<number, GroupRecord>();
const leaderByZone = new Map<number, number>();
const leaderByExternalId = new Map<string, number>();
const listeners = new Set<GroupChangeListener>();

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Normalizes and deduplicates member IDs, ensuring the leader appears first.
 */
function normalizeMembers(leader: number, members: number[]): number[] {
  const unique = new Set<number>();
  unique.add(leader);

  for (const m of members) {
    const id = Math.floor(m);
    if (Number.isFinite(id) && id > 0) {
      unique.add(id);
    }
  }

  // Ensure leader is always first
  const sorted = Array.from(unique).sort((a, b) => a - b);
  const leaderIndex = sorted.indexOf(leader);
  if (leaderIndex > 0) {
    sorted.splice(leaderIndex, 1);
    sorted.unshift(leader);
  }
  return sorted;
}

/**
 * Notifies all registered listeners of a change.
 */
function emitChange(event: GroupChangeEvent, leader: number, record?: GroupRecord): void {
  for (const listener of listeners) {
    try {
      listener(event, leader, record);
    } catch (err) {
      logger.warn(`[GroupTracker] Listener error (${event}, leader=${leader}): ${String(err)}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Core API                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Inserts or updates a group definition.
 * Returns the normalized record and a boolean indicating if any changes occurred.
 */
export function upsertGroup(
  options: Omit<GroupRecord, 'updatedAt'>,
): { record: GroupRecord; changed: boolean } {
  const leader = Math.floor(options.leader);
  const members = normalizeMembers(leader, options.members);

  members.forEach((id) => leaderByZone.set(id, leader));

  const previous = groupsByLeader.get(leader);
  const changed =
    !previous ||
    previous.backend !== options.backend ||
    previous.externalId !== options.externalId ||
    previous.source !== options.source ||
    previous.members.join(',') !== members.join(',');

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

  if (!previous) {
    emitChange('new', leader, record);
  } else if (changed) {
    emitChange('update', leader, record);
  }

  return { record, changed };
}

/**
 * Removes a group (and its mappings) by leader zone ID.
 * Returns true if a group was removed.
 */
export function removeGroupByLeader(leader: number): boolean {
  const record = groupsByLeader.get(leader);
  if (!record) {
    return false;
  }

  if (record.externalId) {
    leaderByExternalId.delete(record.externalId);
  }
  record.members.forEach((z) => leaderByZone.delete(z));
  groupsByLeader.delete(leader);

  emitChange('remove', leader, record);
  return true;
}

/**
 * Finds the group to which a given zone belongs.
 */
export function getGroupByZone(zoneId: number): GroupRecord | undefined {
  const leader = leaderByZone.get(zoneId);
  return leader ? groupsByLeader.get(leader) : undefined;
}

/**
 * Finds a group by its leader ID.
 */
export function getGroupByLeader(leader: number): GroupRecord | undefined {
  return groupsByLeader.get(leader);
}

/**
 * Finds a group by its external identifier (e.g., "grp-123").
 */
export function getGroupByExternalId(externalId: string): GroupRecord | undefined {
  const leader = leaderByExternalId.get(externalId);
  return leader ? groupsByLeader.get(leader) : undefined;
}

/**
 * Returns all active groups as an immutable snapshot.
 */
export function getAllGroups(): ReadonlyArray<GroupRecord> {
  return Array.from(groupsByLeader.values());
}

/**
 * Alias for getAllGroups(), maintained for backward compatibility.
 * Used by MusicAssistantStateMapper for safe disband checks.
 */
export function getCurrentGroups(): ReadonlyArray<GroupRecord> {
  return getAllGroups();
}

/**
 * Clears all group state — used during reinitialization or shutdown.
 */
export function clearAllGroups(): void {
  groupsByLeader.clear();
  leaderByZone.clear();
  leaderByExternalId.clear();
  listeners.clear();
}

/* -------------------------------------------------------------------------- */
/* Event subscription API                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Subscribes to group change events.
 * Returns an unsubscribe function for cleanup.
 */
export function onGroupChanged(listener: GroupChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}