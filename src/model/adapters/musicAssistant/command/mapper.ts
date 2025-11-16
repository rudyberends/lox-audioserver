import { zoneStateStore } from '@/runtime/zones/zoneStateStore';
import { getAdapterProp, setAdapterProp } from '@/runtime/zones/types/zoneStateTypes';
import { MusicAssistantApi } from '../api';
import { MusicAssistantConfig } from '../types/config';
import { MusicAssistantCommand } from '../types/command';
import { dispatch } from '@/runtime/zones/dispatch/commandDispatch';
import { joinLeaderGeneric, leaveGroupGeneric } from '@/runtime/zones/utils/groupUtils';
import { CommandHandler } from '@/core/interfaces/commandHandler';
import { logCommand, logWarn, logDebug } from '@/core/utils/logging';
import { parseRepeat, parseShuffle } from '@/core/utils/media';
import { computeRelativeVolume } from '@/core/utils/volume';

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

    return await dispatch(command, {
      play: async () => this.api.play(this.playerId),
      resume: async () => this.api.play(this.playerId),
      pause: async () => this.api.pause(this.playerId),
      stop: async () => this.api.stop(this.playerId),
      queueplus: async () => this.api.next(this.playerId),
      queueminus: async () => this.api.previous(this.playerId),
      position: async () => this.api.position(this.playerId, param),
      volume: async () => this.adjustVolume(param),
      repeat: async () => this.handleRepeat(param),
      shuffle: async () => this.handleShuffle(param),
      groupjoin: async () => this.joinLeader(),
      groupleave: async () => this.leaveGroup(),
    });
  }

  /* -------------------------------------------------------------------------- */
  /* Volume + playback helpers                                                  */
  /* -------------------------------------------------------------------------- */
  private async adjustVolume(param?: any): Promise<void> {
    const zone = zoneStateStore.getZoneState(this.zoneId);

    if (!zone) {
      logWarn('MusicAssistantCommandMapper', this.zoneName, 'Volume change ignored: zone not found');
      return;
    }

    let target: number;

    // ABSOLUTE VOLUME (used by alerts)
    if (param && typeof param === 'object' && 'absolute' in param) {
      target = Number(param.absolute);
    } else {
      // RELATIVE VOLUME (legacy delta)
      const delta = Number(param?.delta ?? param ?? 0);
      const current = Number(zone.volume ?? 0);
      target = computeRelativeVolume(current, delta);
    }

    try {
      await this.api.setVolume(this.playerId, target);
      logDebug('MusicAssistantCommandMapper', this.zoneName, `Volume set → ${target}`);
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