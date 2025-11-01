/**
 * -----------------------------------------------------------------------------
 * groupRuntime.ts
 * -----------------------------------------------------------------------------
 * Runtime manager for dynamic audio groups.
 *
 * Responsibilities:
 * - Broadcast group membership and mastervolume sync events to Loxone clients.
 * - Apply group-level commands (e.g., unified volume changes).
 * - Keep the group state consistent with ZoneRuntime and ZoneStore.
 * -----------------------------------------------------------------------------
 */

import logger from '@/utils/troxorLogger';
import { broadcastMessage } from '@/http/loxoneHttp/websocketManager';
import { zoneStateStore } from '@/runtime/zones/zoneStateStore';
import { zoneRuntime } from '@/runtime/zones/zoneRuntime';
import {
  getAllGroups,
  getGroupByZone,
  upsertGroup,
  removeGroupByLeader,
  onGroupChanged,
} from './groupTracker';
import type { AudioSyncEventPlayer } from './types/audioSyncEventPlayer';
import type { AudioSyncGroupPayload } from './types/AudioSyncGroupPayload';
import type { GroupRecord } from './types/groupRecord';

/** Defines the shape of a group change event. */
type GroupChangeEvent = 'new' | 'update' | 'remove';

/** Loxone-compatible group removal payload. */
interface EmptyGroupPayload {
  audio_sync_event: [
    {
      group: string;
      mastervolume: number;
      players: AudioSyncEventPlayer[];
      type: 'dynamic';
    },
  ];
}

export class GroupRuntime {
  constructor() {
    // Subscribe to all group changes from the tracker
    onGroupChanged((event: GroupChangeEvent, leader: number): void => {
      const prefix = `[GroupRuntime][leader=${leader}]`;

      switch (event) {
        case 'new':
          logger.info(`${prefix} ➕ Group created`);
          break;
        case 'update':
          logger.info(`${prefix} ♻️ Group updated`);
          break;
        case 'remove': {
          logger.info(`${prefix} ❌ Group removed`);
          // Send explicit empty event to unregister group in Loxone
          const emptyPayload: EmptyGroupPayload = {
            audio_sync_event: [
              {
                group: `group-${leader}`,
                mastervolume: 0,
                players: [],
                type: 'dynamic',
              },
            ],
          };
          broadcastMessage(JSON.stringify(emptyPayload));
          break;
        }
        default:
          logger.warn(`${prefix} Unknown group change event: ${String(event)}`);
          break;
      }

      try {
        this.broadcastGroupState();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`${prefix} Broadcast failed after ${event}: ${msg}`);
      }
    });
  }

  /**
   * Broadcasts all currently tracked groups to connected Loxone clients.
   */
  public broadcastGroupState(): void {
    const groups = getAllGroups();
    const payload: AudioSyncGroupPayload[] = groups
      .map((record) => this.buildGroupPayload(record))
      .filter((p): p is AudioSyncGroupPayload => Boolean(p));

    if (payload.length === 0) {
      logger.debug('[GroupRuntime] No groups to broadcast');
      return;
    }

    const message = JSON.stringify({ audio_sync_event: payload });
    broadcastMessage(message);
    logger.debug(`[GroupRuntime] Broadcast ${payload.length} group(s)`);
  }

  /**
   * Builds a valid Loxone broadcast payload for a given group.
   */
  private buildGroupPayload(record: GroupRecord): AudioSyncGroupPayload | null {
    const members = record.members
      .map((id) => zoneStateStore.getZoneState(id))
      .filter((z): z is NonNullable<ReturnType<typeof zoneStateStore.getZoneState>> => Boolean(z));

    if (members.length === 0) {
      return null;
    }

    const leader = zoneStateStore.getZoneState(record.leader);
    const masterVolume = leader?.volume ?? 0;

    const players: AudioSyncEventPlayer[] = members.map((z) => ({
      id: `zone-${z.playerid}`,
      playerid: z.playerid,
      name: z.name,
    }));

    return {
      group: record.externalId ?? `group-${record.leader}`,
      mastervolume: masterVolume,
      players,
      type: 'dynamic',
    };
  }

  /**
   * Applies a mastervolume change across all group members.
   */
  public async applyMasterVolume(zoneId: number, target: number): Promise<void> {
    const group = getGroupByZone(zoneId);
    if (!group) {
      logger.debug(`[GroupRuntime] No group found for zone ${zoneId}`);
      return;
    }

    const leader = zoneStateStore.getZoneState(group.leader);
    if (!leader) {
      logger.warn(`[GroupRuntime] Leader zone ${group.leader} missing for group`);
      return;
    }

    const delta = target - (leader.volume ?? 0);
    const members = group.members
      .map((id) => zoneStateStore.getZoneState(id))
      .filter((z): z is NonNullable<ReturnType<typeof zoneStateStore.getZoneState>> => Boolean(z));

    for (const member of members) {
      try {
        await zoneRuntime.sendZoneCommand(member.playerid, 'volume', String(delta));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[GroupRuntime] Failed to update volume for zone ${member.playerid}: ${msg}`);
      }
    }

    this.broadcastGroupState();
  }

  /**
   * Removes a group by leader ID or external ID, then notifies clients.
   * Sends a special empty payload before broadcasting the updated state,
   * ensuring Loxone correctly unregisters the group.
   */
  public removeGroup(identifier: number | string): void {
    const groups = getAllGroups();
    if (groups.length === 0) {
      logger.debug('[GroupRuntime] No active groups to remove');
      return;
    }

    const record = typeof identifier === 'number'
      ? groups.find((g) => g.leader === identifier)
      : typeof identifier === 'string'
        ? groups.find((g) => g.externalId === identifier.trim())
        : undefined;

    if (!record) {
      logger.debug(`[GroupRuntime] No group found for removal: ${identifier}`);
      return;
    }

    const removed = removeGroupByLeader(record.leader);
    if (!removed) {
      logger.warn(`[GroupRuntime] Attempted to remove group ${identifier}, but tracker returned false`);
      return;
    }

    logger.info(`[GroupRuntime][leader=${record.leader}] Group removed manually (${record.externalId ?? 'n/a'})`);

    const emptyPayload: EmptyGroupPayload = {
      audio_sync_event: [
        {
          group: record.externalId ?? `group-${record.leader}`,
          mastervolume: 0,
          players: [],
          type: 'dynamic',
        },
      ],
    };

    broadcastMessage(JSON.stringify(emptyPayload));
    this.broadcastGroupState();
  }

  /**
   * Upserts (creates or updates) a group, then synchronizes it to clients.
   */
  public upsert(record: Omit<GroupRecord, 'updatedAt'>): void {
    const { changed } = upsertGroup(record);
    if (changed) {
      logger.debug(`[GroupRuntime][leader=${record.leader}] Updated group ${record.externalId ?? 'n/a'}`);
      this.broadcastGroupState();
    }
  }
}

export const groupRuntime = new GroupRuntime();