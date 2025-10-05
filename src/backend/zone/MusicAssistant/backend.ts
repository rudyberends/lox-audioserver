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
import logger from '../../../utils/troxorlogger';
import { updateZoneQueue, updateZoneGroup } from '../zonemanager';
import MusicAssistantClient from './client';
import { EventMessage, RepeatMode } from './types';
import { mapPlayerToTrack, mapQueueToState } from './stateMapper';
import { handleMusicAssistantCommand, MusicAssistantCommandContext } from './commands';
import { setMusicAssistantSuggestions, clearMusicAssistantSuggestion } from '../../../config/adminState';

export default class BackendMusicAssistant extends Backend {
  private client: MusicAssistantClient;
  private removeEventListener?: () => void;
  private lastQueueItem: any = null;
  private previousQueueItem: any = null;

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
    if (myQueue) this.updateFromQueue(myQueue);
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
      pushTrackUpdate: (update) => this.pushTrackUpdate(update),
    };

    const handled = await handleMusicAssistantCommand(ctx, command, param);

    if (!handled) {
      logger.warn(`[MusicAssistant][Zone:${this.loxoneZoneId}] Unknown command: ${command}`);
    }
  }

  sendGroupCommand(_cmd: string, _type: string, _playerid: string, ...additionalIDs: string[]): void {
    logger.info(`[MusicAssistant] Creating group Leader:${this.maPlayerId}, Members:${additionalIDs.join(', ')}`);
    additionalIDs.forEach((id) => {
      // if (id !== this.maPlayerId) sendCommandToZone(id, 'groupJoin', this.maPlayerId);
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
    const objectId = (evt.object_id ?? '').toString().toLowerCase();
    const myId = (this.maPlayerId ?? '').toString().toLowerCase();

    // Only process events for our configured Music Assistant player
    if (objectId !== myId) return;

    switch (eventName) {
      case 'queue_added':
      case 'queue_updated':
        this.updateFromQueue(evt.data);
        break;

      case 'queue_time_updated':
        this.pushTrackUpdate({
          time: Number(evt.data ?? 0),
        });
        break;

      case 'player_added':
      case 'player_updated':
        this.updateFromPlayer(evt.data);
        break;
    }
  }

  private updateFromPlayer(player: any) {
    const trackUpdate = mapPlayerToTrack(this.loxoneZoneId, player);
    this.pushTrackUpdate(trackUpdate);
  }

  private updateFromQueue(queue: any) {

    const currentQueueId = queue?.current_item?.queue_item_id;
    if (this.lastQueueItem && this.lastQueueItem.queue_item_id !== currentQueueId) {
      this.previousQueueItem = this.lastQueueItem;
    }

    const state = mapQueueToState(this.loxoneZoneId, queue, this.previousQueueItem);
    if (!state) return;

    this.pushTrackUpdate(state.trackUpdate);

    const zone = this.getZoneOrWarn();
    if (zone) {
      zone.queue = {
        id: this.loxoneZoneId,
        items: state.items,
        shuffle: state.shuffleEnabled === 1,
        start: 0,
        totalitems: state.items.length,
      };
      updateZoneQueue(this.loxoneZoneId, state.items.length, 1);
    }

    this.lastQueueItem = queue.current_item;
  }

  private captureSuggestions(players: any[]) {
    const mapped = players.map((p: any) => ({ id: p.player_id, name: p.name }));
    setMusicAssistantSuggestions(this.loxoneZoneId, mapped);
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
