import { postBeoLinkCommand, putBeoLinkCommand, deleteBeoLinkCommand } from '../utils/httpHelper';
import { zoneStateStore } from '@/runtime/zones/zoneStateStore';
import { getAdapterProp } from '@/runtime/zones/types/zoneStateTypes';
import { BeoLinkCommand } from '../types/command';
import { BeoLinkCommandConfig } from '../types/config';
import { logCommand, logDebug, logError } from '@/core/utils/logging';
import { joinLeaderGeneric, leaveGroupGeneric } from '@/runtime/zones/utils/groupUtils';
import { CommandHandler } from '@/core/interfaces/commandHandler';

/**
 * -----------------------------------------------------------------------------
 * BeoLinkCommandMapper
 * -----------------------------------------------------------------------------
 * Clean, self-contained adapter for BeoLink HTTP commands.
 *
 * Features:
 * - Shared baseUrl for all requests
 * - Compact actionMap for playback and queue commands
 * - Relative volume control (never absolute)
 * - Group join/leave helpers for leader-follower playback
 * -----------------------------------------------------------------------------
 */
export class BeoLinkCommandMapper implements CommandHandler {
  private readonly zoneId: number;
  private readonly zoneName: string;
  private readonly baseUrl: string;
  private readonly type = 'beolink';

  private readonly actionMap: Record<BeoLinkCommand, string | null> = {
    play: 'Stream/Play',
    resume: 'Stream/Play',
    pause: 'Stream/Pause',
    stop: 'Stream/Stop',
    queueplus: 'Stream/Forward',
    queueminus: 'Stream/Backward',
    repeat: 'List/Repeat',
    shuffle: 'List/Shuffle',
    volume: null,
    groupjoin: null,
    groupleave: null,
  };

  constructor(config: BeoLinkCommandConfig) {
    this.zoneId = config.zoneId!;
    this.zoneName = config.zoneName;
    this.baseUrl = `http://${config.ip}:8080/BeoZone/Zone`;
  }

  async initialize(): Promise<void> {
    logCommand('BeoLink', this.zoneName, 'initialized', `(${this.baseUrl})`);
  }

  /**
   * Main entrypoint for ZoneRuntime → executes mapped BeoLink command.
   */
  async handle(command: BeoLinkCommand, param: number): Promise<boolean> {
    const key = command.toLowerCase() as BeoLinkCommand;

    // 1) Absolute command → via actionMap
    const path = this.actionMap[key];
    if (path) {
      await this.doAction(path);
      return true;
    }

    // 2) Relative commands → inline mini-dispatch
    const handlers: Record<string, (() => Promise<void>) | undefined> = {
      volume:      () => this.adjustVolume(param),
      groupjoin:   () => this.joinLeader(),
      groupleave:  () => this.leaveGroup(),
    };

    const fn = handlers[key];
    if (!fn) {
      return false;
    }

    await fn();
    return true;
  }

  /* -------------------------------------------------------------------------- */
  /* Helpers                                                                    */
  /* -------------------------------------------------------------------------- */

  /** Executes a simple BeoLink action like Play, Pause, Repeat, Shuffle, etc. */
  private async doAction(endpoint: string): Promise<void> {
    const url = `${this.baseUrl}/${endpoint}`;
    try {
      await postBeoLinkCommand(url);
      logCommand('BeoLink', this.zoneName, `→ ${endpoint}`);
    } catch (err) {
      logError('BeoLink', this.zoneName, `Command (${endpoint})`, err);
    }
  }

  /** Sets BeoLink speaker volume (absolute 0–100). */
  private async adjustVolume(absoluteVolume: number): Promise<void> {
  // Clamp to valid range
    const newVolume = Math.max(0, Math.min(100, Math.round(absoluteVolume)));
    const url = `${this.baseUrl}/Sound/Volume/Speaker/Level`;

    try {
      await putBeoLinkCommand(url, { level: newVolume });
      logDebug('BeoLink', this.zoneName, `Volume set → ${newVolume}`);
    } catch (err) {
      logError('BeoLink', this.zoneName, 'Volume update failed', err);
    }
  }

  /** Joins this zone to the leader’s current source. */
  private async joinLeader(): Promise<void> {
    await joinLeaderGeneric<string>({
      zoneId: this.zoneId,
      zoneName: this.zoneName,
      getLeaderExternalId: (leaderZoneId) => {
        const leaderZone = zoneStateStore.getZoneState(leaderZoneId);
        return getAdapterProp<string>(leaderZone, 'currentSourceId');
      },
      joinBackend: async (leaderSourceId) => {
        const url = `${this.baseUrl}/ActiveSources`;
        const body = { activeSources: { primary: leaderSourceId, join: true } };
        await postBeoLinkCommand(url, body);
      },
    });
  }

  /** Leaves the current group — leader keeps playing. */
  private async leaveGroup(): Promise<void> {
    await leaveGroupGeneric({
      zoneId: this.zoneId,
      zoneName: this.zoneName,
      leaveBackend: async () => {
        const url = `${this.baseUrl}/ActiveSources/primaryExperience`;
        await deleteBeoLinkCommand(url);
      },
    });
  }

  async dispose(): Promise<void> {
    // optional cleanup
  }
}