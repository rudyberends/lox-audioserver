import type { GroupTrackerPort } from '@/ports/GroupTrackerPort';
import {
  clearJoinedLeader,
  getGroupByExternalId,
  getGroupByLeader,
  getGroupByZone,
  getJoinedLeader,
  onGroupChanged,
  removeGroupByLeader,
  setJoinedLeader,
  upsertGroup,
} from '@/application/groups/groupTracker';

/**
 * Returns a GroupTrackerPort backed by the application's shared group-registry
 * module. Wraps the existing module-level functions so adapters can depend on
 * the port abstraction instead of importing the application module directly.
 */
export function createGroupTrackerPort(): GroupTrackerPort {
  return {
    upsertGroup,
    removeGroupByLeader,
    getGroupByZone,
    getGroupByLeader,
    getGroupByExternalId,
    onGroupChanged,
    setJoinedLeader,
    getJoinedLeader,
    clearJoinedLeader,
  };
}
