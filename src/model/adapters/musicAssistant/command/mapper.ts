import { zoneStateStore } from '@/runtime/zones/zoneStateStore';
import { getAdapterProp, setAdapterProp } from '@/runtime/zones/types/zoneStateTypes';
import { MusicAssistantApi } from '../api';
import { MusicAssistantConfig } from '../types/config';
import { MusicAssistantCommand } from '../types/command';
import { joinLeaderGeneric, leaveGroupGeneric } from '@/runtime/zones/utils/groupUtils';
import { CommandHandler } from '@/core/interfaces/commandHandler';
import { logCommand, logWarn, logDebug } from '@/core/utils/logging';
import { parseRepeat, parseShuffle } from '@/core/utils/media';

/**
 * -----------------------------------------------------------------------------
 * MusicAssistantCommandMapper
 * -----------------------------------------------------------------------------
 * Direct, self-contained mapper for Music Assistant commands.
 * Converts Loxone commands into Music Assistant API calls.
 * -----------------------------------------------------------------------------
 */
export class MusicAssistantCommandMapper implements CommandHandler {
  private readonly zoneId: number;
  private readonly zoneName: string;
  private readonly playerId: string;
  private readonly api: MusicAssistantApi;
  private readonly type = 'musicassistant';

  constructor(config: MusicAssistantConfig) {
    this.zoneId = config.zoneId;
    this.zoneName = config.zoneName;
    this.playerId = config.maPlayerId;
    this.api = MusicAssistantApi.acquire(config.ip, config.port ?? 8095);
  }

  async initialize(): Promise<void> {
    try {
      const zoneState = zoneStateStore.getZoneState(this.zoneId);
      if (zoneState) {
        setAdapterProp(zoneState, 'maPlayerId', this.playerId);
      }
      await this.api.connect();
      logCommand('MusicAssistantCommandMapper', this.zoneName, 'initialized and connected');
    } catch (err) {
      logWarn('MusicAssistantCommandMapper', this.zoneName, `Backend connection failed: ${String(err)}`);
    }
  }

  /**
   * Main entry point from ZoneRuntime → executes mapped Music Assistant command.
   */
  async handle(cmd: MusicAssistantCommand, param?: any): Promise<boolean> {
    const command = cmd.toLowerCase() as MusicAssistantCommand;

    const handlers: Record<string, (() => Promise<void>) | undefined> = {
      play:        () => this.api.play(this.playerId),
      resume:      () => this.api.play(this.playerId),
      pause:       () => this.api.pause(this.playerId),
      stop:        () => this.api.stop(this.playerId),
      queueplus:   () => this.api.next(this.playerId),
      queueminus:  () => this.api.previous(this.playerId),
      position:    () => this.api.position(this.playerId, param),
      volume:      () => this.adjustVolume(param),
      repeat:      () => this.handleRepeat(param),
      shuffle:     () => this.handleShuffle(param),
      groupjoin:   () => this.joinLeader(),
      groupleave:  () => this.leaveGroup(),
    };

    const fn = handlers[command];
    if (!fn) {
      return false;
    }

    await fn();
    return true;
  }

  /* -------------------------------------------------------------------------- */
  /* Volume + playback helpers                                                  */
  /* -------------------------------------------------------------------------- */
  private async adjustVolume(absoluteVolume: number): Promise<void> {
    try {
      await this.api.setVolume(this.playerId, absoluteVolume);
      logDebug('MusicAssistantCommandMapper', this.zoneName, `Volume set → ${absoluteVolume}`);
    } catch (err) {
      logWarn('MusicAssistantCommandMapper', this.zoneName, `Volume update failed: ${String(err)}`);
    }
  }

  private async handleRepeat(param?: any): Promise<void> {
    await this.api.repeat(this.playerId, parseRepeat(param));
  }

  private async handleShuffle(param?: any): Promise<void> {
    await this.api.shuffle(this.playerId, parseShuffle(param));
  }

  /* -------------------------------------------------------------------------- */
  /* Grouping                                                                  */
  /* -------------------------------------------------------------------------- */

  private async joinLeader(): Promise<void> {
    await joinLeaderGeneric<string>({
      zoneId: this.zoneId,
      zoneName: this.zoneName,
      getLeaderExternalId: (leaderZoneId) => {
        const leaderZone = zoneStateStore.getZoneState(leaderZoneId);
        return getAdapterProp<string>(leaderZone, 'maPlayerId');
      },
      joinBackend: async (leaderMaId) => this.api.groupJoin(this.playerId, leaderMaId),
    });
  }

  private async leaveGroup(): Promise<void> {
    await leaveGroupGeneric({
      zoneId: this.zoneId,
      zoneName: this.zoneName,
      leaveBackend: async () => this.api.groupLeave(this.playerId),
    });
  }

  async dispose(): Promise<void> {
    this.api.release();
    logCommand('MusicAssistantCommandMapper', this.zoneName, 'disposed');
  }
}