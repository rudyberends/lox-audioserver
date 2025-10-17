/**
 * BackendMusicAssistant
 * ---------------------
 * Full-featured Music Assistant backend for a single zone/player.
 *
 * - Connects to a Music Assistant server (one server, many players).
 * - Each instance controls a single Music Assistant player, identified by `maPlayerId`.
 * - Sends RPC commands (play, pause, stop, volume, shuffle, repeat, grouping, etc.).
 * - Receives real-time events (PLAYER_UPDATED, QUEUE_UPDATED, QUEUE_TIME_UPDATED)
 *   and updates the ZoneManager instantly (no polling).
 *
 * ⚠️ Each zone needs its own MA Player ID in the .env file:
 *    ZONE_<LOXONE_ZONE_ID>_MA_PLAYER_ID=<MusicAssistantPlayerID>
 */

import Backend, { BackendProbeOptions } from '../backendBaseClass';
import type { PlayerStatus } from '../loxoneTypes';
import logger from '../../../utils/troxorlogger';
import { updateZoneQueue, updateZoneGroup, sendCommandToZone, findZoneByBackendPlayerId } from '../zonemanager';
import MusicAssistantClient from './client';
import { EventMessage } from './types';
import { mapPlayerToTrack, mapQueueToState } from './stateMapper';
import { handleMusicAssistantCommand, MusicAssistantCommandContext } from './commands';
import { setMusicAssistantSuggestions, clearMusicAssistantSuggestion } from '../../../config/adminState';
import { upsertGroup, removeZoneFromGroups, getGroupByLeader, getGroupByZone, removeGroupByLeader } from '../groupTracker';

export default class BackendMusicAssistant extends Backend {
  private client: MusicAssistantClient;
  private removeEventListener?: () => void;
  private lastQueueItem: any = null;
  private previousQueueItem: any = null;

  private activeQueueId?: string;
  private activeGroupLeaderId?: string;

  private maPlayerId: string; // <- the Music Assistant player ID
  private loxoneZoneId: number; // <- keep track of original zone id for logging

  /**
   * @param serverIp     IP or hostname of the Music Assistant server.
   * @param loxoneZoneId The Loxone zone ID (used only for logging/mapping).
   * @param maPlayerId   The ID of the Music Assistant player this backend controls.
   * @param serverPort   Optional port (default = 8095).
   */
  constructor(serverIp: string, loxoneZoneId: number, maPlayerId?: string, serverPort = 8095) {
    super(serverIp, loxoneZoneId);
    this.client = new MusicAssistantClient(serverIp, serverPort);
    this.loxoneZoneId = loxoneZoneId;
    this.maPlayerId = maPlayerId ?? '';
  }

  static async probe(options: BackendProbeOptions): Promise<void> {
    const port = options.port ?? 8095;
    const client = new MusicAssistantClient(options.ip, port);
    try {
      await client.connect();
      const players = await client.rpc('players/all');
      if (options.maPlayerId) {
        const found = Array.isArray(players)
          ? players.some((player: any) => player?.player_id === options.maPlayerId)
          : false;
        if (!found) {
          throw new Error(`Music Assistant player "${options.maPlayerId}" not found on server ${options.ip}`);
        }
      }
    } finally {
      client.cleanup();
    }
  }

  /**
   * Initialize: connect to server, subscribe to events, and fetch initial state.
   */
  async initialize(): Promise<void> {
    logger.info(`[MusicAssistant][Zone:${this.loxoneZoneId}] Connecting to server ${this.ip}`);
    await this.client.connect();

    const players = await this.client.rpc('players/all');

    this.captureSuggestions(players);

    if (!this.maPlayerId) {
      logger.warn(`[MusicAssistant][Zone:${this.loxoneZoneId}] No Music Assistant player configured. Zone left unconfigured.`);
      return;
    }

    const me = players.find((p: any) => p.player_id === this.maPlayerId);
    if (!me) {
      logger.error(`❌ PLAYER_ID "${this.maPlayerId}" not found on server ${this.ip}`);
      logger.warn(`[MusicAssistant][Zone:${this.loxoneZoneId}] Zone remains unconfigured until a valid player is selected.`);
      return;
    }

    logger.info(`[MusicAssistant][Zone:${this.loxoneZoneId}] Connected to player "${me.name}" (${this.maPlayerId})`);
    clearMusicAssistantSuggestion(this.loxoneZoneId);

    this.registerEventHandlers();
    this.updateFromPlayer(me);

    const queues = await this.client.rpc('player_queues/all');
    const myQueue = queues.find((q: any) => q.queue_id === this.maPlayerId || q.queue_id === me.active_source);
    if (myQueue) await this.updateFromQueue(myQueue);
  }

  /**
   * Clean up resources (close WebSocket and timers).
   */
  async cleanup(): Promise<void> {
    logger.info(`[MusicAssistant][Zone:${this.loxoneZoneId}] Cleanup`);
    this.removeEventListener?.();
    this.client.cleanup();
    this.lastQueueItem = null;
    this.previousQueueItem = null;
    await super.cleanup();
  }

  // ---------------------------------------------------------------------
  // Commands (public API for ZoneManager)
  // ---------------------------------------------------------------------

  async sendCommand(command: string, param?: any): Promise<void> {
    logger.info(`[MusicAssistant][Zone ${this.loxoneZoneId}] Command: ${command}`);

    const ctx: MusicAssistantCommandContext = {
      client: this.client,
      maPlayerId: this.maPlayerId,
      loxoneZoneId: this.loxoneZoneId,
      getZoneOrWarn: () => this.getZoneOrWarn(),
      pushPlayerEntryUpdate: (update) => this.pushPlayerStatusUpdate(update),
    };

    const handled = await handleMusicAssistantCommand(ctx, command, param);

    if (!handled) {
      logger.warn(`[MusicAssistant][Zone:${this.loxoneZoneId}] Unknown command: ${command}`);
    }
  }

  sendGroupCommand(_cmd: string, _type: string, _playerid: string, ...additionalIDs: string[]): void {
    logger.info(`[MusicAssistant] Creating group Leader:${this.maPlayerId}, Members:${additionalIDs.join(', ')}`);
    additionalIDs.forEach((id) => {
      if (id !== this.maPlayerId) sendCommandToZone(Number(id), 'groupJoin', this.maPlayerId);
    });
    updateZoneGroup();
  }

  async searchMusic(query: string) {
    return this.client.rpc('music/search', { search_query: query, limit: 50 });
  }

  // ---------------------------------------------------------------------
  // Events & updates
  // ---------------------------------------------------------------------

  private registerEventHandlers() {
    this.removeEventListener = this.client.onEvent((evt) => this.handleEvent(evt));
  }

  private handleEvent(evt: EventMessage) {
    const eventName = (evt.event ?? '').toString().toLowerCase();
    const objectId = this.normaliseId(evt.object_id);
    const myId = this.normaliseId(this.maPlayerId);
    const queueId = this.activeQueueId;
    const leaderId = this.activeGroupLeaderId;

    const relevantIds = new Set<string>();
    if (myId) relevantIds.add(myId);
    if (queueId) relevantIds.add(queueId);
    if (leaderId) relevantIds.add(leaderId);

    if (relevantIds.size > 0) {
      if (objectId) {
        if (!relevantIds.has(objectId)) return;
      } else if (eventName.startsWith('queue_') || eventName.startsWith('player_')) {
        // Skip queue/player events without a target identifier when we have specific IDs to watch.
        return;
      }
    }

    switch (eventName) {
      case 'queue_added':
      case 'queue_updated':
        void this.updateFromQueue(evt.data);
        break;

      case 'queue_time_updated': {
        const seconds = Number(evt.data ?? 0);
        if (!Number.isFinite(seconds) || seconds < 0) {
          break;
        }
        const update: Partial<PlayerStatus> = {
          time: seconds,
          position_ms: Math.round(seconds * 1000),
          // Music Assistant sends a "time updated" event with 0 seconds when playback stops
          ...(seconds === 0 ? { mode: 'pause' } : {}),
        };
        this.pushPlayerStatusUpdate(update);
        break;
      }

      case 'player_added':
      case 'player_updated':
        this.updateFromPlayer(evt.data);
        break;
    }
  }

  private updateFromPlayer(player: any) {
    this.captureActiveContext(player);
    const trackUpdate = mapPlayerToTrack(this.loxoneZoneId, player);
    this.pushPlayerStatusUpdate(trackUpdate);
    void this.updateGroupMembership(player);
    void this.ensureGroupPlaybackState(player);
  }

  private async updateFromQueue(queue: any) {
    if (!queue) return;

    const queueId = queue?.queue_id ?? this.maPlayerId ?? '';
    const normalizedQueueId = this.normaliseId(queueId);
    if (normalizedQueueId) {
      this.activeQueueId = normalizedQueueId;
    }
    let augmentedQueue = queue;

    const needsExpansion =
      !Array.isArray(queue?.items) ||
      queue.items.length <= 3 ||
      queue.items.every((item: any) => item?.queue_item_id === undefined);

    if (needsExpansion && queueId) {
      try {
        const fullItems = await this.client.rpc('player_queues/items', {
          queue_id: queueId,
          offset: 0,
          limit: 250,
        });
        if (Array.isArray(fullItems) && fullItems.length > 0) {
          augmentedQueue = {
            ...queue,
            items: fullItems,
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.debug(`[MusicAssistant] Failed to expand queue items via RPC: ${message}`);
      }
    }

    if (!Array.isArray(augmentedQueue?.items) && queue?.items && Array.isArray(queue.items)) {
      augmentedQueue = { ...augmentedQueue, items: queue.items };
    }

    const currentQueueId = queue?.current_item?.queue_item_id;
    if (this.lastQueueItem && this.lastQueueItem.queue_item_id !== currentQueueId) {
      this.previousQueueItem = this.lastQueueItem;
    }

    const state = mapQueueToState(this.loxoneZoneId, augmentedQueue, this.previousQueueItem);
    if (!state) return;

    this.pushPlayerStatusUpdate(state.trackUpdate);

    const zone = this.getZoneOrWarn();
    if (zone) {
      zone.queue = {
        id: this.loxoneZoneId,
        items: state.items,
        shuffle: state.shuffleEnabled,
        start: 0,
        totalitems: state.items.length,
      };
      updateZoneQueue(this.loxoneZoneId, state.items.length, 1);
    }

    this.lastQueueItem = augmentedQueue.current_item;
  }

  private captureActiveContext(player: any): void {
    const queueId = this.normaliseId(player?.active_queue ?? player?.queue_id ?? this.maPlayerId);
    if (queueId) {
      this.activeQueueId = queueId;
    }

    const leaderId = this.normaliseId(player?.synced_to ?? player?.active_group);
    this.activeGroupLeaderId = leaderId;
  }

  private async updateGroupMembership(player: any): Promise<void> {
    const backendName = 'MusicAssistant';
    const playerRawId: string = typeof player?.player_id === 'string' ? player.player_id : this.maPlayerId;
    const playerNormalized = this.normaliseId(playerRawId);
    const playerLookup = playerNormalized ? findZoneByBackendPlayerId(playerNormalized) : undefined;
    const zoneId = playerLookup?.zoneId ?? this.loxoneZoneId;

    const groupMembersRaw: unknown[] = Array.isArray(player?.group_members) ? player.group_members : [];
    const groupChildsRaw: unknown[] = Array.isArray(player?.group_childs) ? player.group_childs : [];

    const normalisedSelf = playerNormalized;
    const syncedToNormalized = this.normaliseId(player?.synced_to);
    const leaderNormalized = syncedToNormalized ?? normalisedSelf;

    const memberZoneIdsFrom = (entries: unknown[], leaderId?: string): number[] => {
      return entries
        .map((entry) => {
          if (typeof entry === 'string') return entry;
          if (entry && typeof (entry as any).player_id === 'string') return (entry as any).player_id;
          return undefined;
        })
        .map((id) => (id ? this.normaliseId(id) : undefined))
        .filter((id): id is string => Boolean(id) && id !== leaderId)
        .map((id) => findZoneByBackendPlayerId(id))
        .filter((lookup): lookup is NonNullable<typeof lookup> => Boolean(lookup))
        .map((lookup) => lookup.zoneId);
    };

    const membersFromMembers = memberZoneIdsFrom(groupMembersRaw, leaderNormalized);
    const membersFromChilds = memberZoneIdsFrom(groupChildsRaw, leaderNormalized);

    const leaderLookup = leaderNormalized ? findZoneByBackendPlayerId(leaderNormalized) : undefined;

    const cleanedMembersFromChilds = membersFromChilds.filter((memberId) => memberId !== (leaderLookup?.zoneId ?? -1));
    const membersCandidates = membersFromMembers.length > 0 ? membersFromMembers : cleanedMembersFromChilds;

    const isLeaderEvent = !syncedToNormalized || syncedToNormalized === normalisedSelf;

    if (isLeaderEvent && leaderLookup) {
      const uniqueMembers = Array.from(new Set(membersCandidates));
      if (uniqueMembers.length > 0) {
        const existingLeaderRecord = getGroupByLeader(leaderLookup.zoneId);
        const { changed } = upsertGroup({
          leader: leaderLookup.zoneId,
          members: uniqueMembers,
          backend: existingLeaderRecord?.backend ?? backendName,
          externalId: existingLeaderRecord?.externalId ?? this.activeQueueId ?? `group-${leaderLookup.zoneId}`,
          source: existingLeaderRecord?.source ?? 'backend',
        });
        if (changed) updateZoneGroup();
      } else {
        const removed = removeGroupByLeader(leaderLookup.zoneId);
        if (removed) updateZoneGroup();
      }
      return;
    }

    if (syncedToNormalized && leaderLookup) {
      const existingLeaderRecord = getGroupByLeader(leaderLookup.zoneId);
      const currentMembers = new Set(existingLeaderRecord?.members ?? []);
      membersCandidates.forEach((memberId) => {
        if (memberId !== leaderLookup.zoneId) currentMembers.add(memberId);
      });
      if (playerLookup && playerLookup.zoneId !== leaderLookup.zoneId) {
        currentMembers.add(playerLookup.zoneId);
      }

      const filteredMembers = Array.from(currentMembers).filter((memberId) => memberId !== leaderLookup.zoneId);

      if (filteredMembers.length > 0) {
        const { changed } = upsertGroup({
          leader: leaderLookup.zoneId,
          members: filteredMembers,
          backend: existingLeaderRecord?.backend ?? backendName,
          externalId: existingLeaderRecord?.externalId ?? this.activeQueueId ?? `group-${leaderLookup.zoneId}`,
          source: existingLeaderRecord?.source ?? 'backend',
        });
        if (changed) updateZoneGroup();
      } else {
        const removed = removeGroupByLeader(leaderLookup.zoneId);
        if (removed) updateZoneGroup();
      }
      return;
    }

    const existingGroup = getGroupByZone(zoneId);
    if (existingGroup) {
      const changed = removeZoneFromGroups(zoneId);
      if (changed) updateZoneGroup();
    }
  }

  private async ensureGroupPlaybackState(player: any): Promise<void> {
    const queueId = this.normaliseId(player?.active_queue ?? player?.queue_id);
    if (!queueId) return;

    const leaderId = this.normaliseId(player?.synced_to ?? player?.active_group);
    // Fetch the shared queue when we are part of a sync group
    if (!leaderId && queueId === this.normaliseId(this.maPlayerId)) return;

    try {
      const queue = await this.client.rpc('player_queues/get', { queue_id: queueId });
      if (queue) {
        await this.updateFromQueue(queue);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.debug(`[MusicAssistant][Zone:${this.loxoneZoneId}] Failed to fetch active group queue ${queueId}: ${message}`);
    }
  }

  private normaliseId(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    const str = typeof value === 'string' ? value : String(value);
    const trimmed = str.trim();
    if (!trimmed) return undefined;
    return trimmed.toLowerCase();
  }

  private captureSuggestions(players: any[]) {
    const mapped = players.map((p: any) => ({ id: p.player_id, name: p.name }));
    setMusicAssistantSuggestions(this.loxoneZoneId, mapped);
  }

  private handlePlayerRemoved(_payload: any): void {
    // no-op (Music Assistant does not emit player_removed for grouping)
  }

  static async listAvailablePlayers(serverIp: string, serverPort = 8095): Promise<Array<{ id: string; name: string }>> {
    const client = new MusicAssistantClient(serverIp, serverPort);
    await client.connect();
    try {
      const players = await client.rpc('players/all');
      return players.map((p: any) => ({ id: p.player_id, name: p.name }));
    } finally {
      client.cleanup();
    }
  }
}

export async function getMusicAssistantPlayers(serverIp: string, serverPort = 8095) {
  return BackendMusicAssistant.listAvailablePlayers(serverIp, serverPort);
}
