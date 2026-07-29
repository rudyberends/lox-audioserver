import type { ZoneState } from '@/domain/zones/zoneState';
import { getGroupByLeader } from '@/application/groups/groupTracker';

type GroupingCoordinatorDeps = {
  getState: (zoneId: number) => ZoneState | undefined;
  applyPatch: (zoneId: number, patch: Partial<ZoneState>, force?: boolean) => void;
};

export class GroupingCoordinator {
  constructor(private readonly deps: GroupingCoordinatorDeps) {}

  public syncGroupMembersToLeader(leaderId: number): void {
    const leaderState = this.deps.getState(leaderId);
    if (!leaderState) {
      return;
    }
    const patch = this.stripGroupStateFields(leaderState);
    this.applyGroupPatchToMembers(leaderId, patch, true);
  }

  public syncGroupMembersPatch(
    leaderId: number,
    patch: Partial<ZoneState>,
    force: boolean,
  ): void {
    const filtered = this.stripGroupStateFields(patch);
    if (!Object.keys(filtered).length) {
      return;
    }
    this.applyGroupPatchToMembers(leaderId, filtered, force);
  }

  private applyGroupPatchToMembers(
    leaderId: number,
    patch: Partial<ZoneState>,
    force: boolean,
  ): void {
    const group = getGroupByLeader(leaderId);
    if (!group) {
      return;
    }
    for (const memberId of group.members) {
      if (memberId === leaderId) {
        continue;
      }
      this.deps.applyPatch(memberId, patch, force);
    }
  }

  private stripGroupStateFields(
    patch: Partial<ZoneState>,
  ): Partial<ZoneState> {
    const {
      playerid: _playerid,
      name: _name,
      volume: _volume,
      eq: _eq,
      ...rest
    } = patch;
    return rest;
  }
}
