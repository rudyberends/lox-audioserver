import {
  updateZoneGroup,
  getZoneById,
  findZoneByBackendPlayerId,
  updateZonePlayerStatus,
  sendCommandToZone,
} from '../zonemanager';
import { PlayerStatus, RepeatMode as LoxoneRepeatMode } from '../loxoneTypes';
import logger from '../../../utils/troxorlogger';
import MusicAssistantClient from './client';

type RepeatMapping = {
  ma: 'off' | 'one' | 'all';
  lox: LoxoneRepeatMode;
};

const repeatModeMap: Record<string, RepeatMapping> = {
  off: { ma: 'off', lox: LoxoneRepeatMode.NoRepeat },
  '0': { ma: 'off', lox: LoxoneRepeatMode.NoRepeat },
  disable: { ma: 'off', lox: LoxoneRepeatMode.NoRepeat },
  disabled: { ma: 'off', lox: LoxoneRepeatMode.NoRepeat },
  false: { ma: 'off', lox: LoxoneRepeatMode.NoRepeat },
  no: { ma: 'off', lox: LoxoneRepeatMode.NoRepeat },

  one: { ma: 'one', lox: LoxoneRepeatMode.Track },
  track: { ma: 'one', lox: LoxoneRepeatMode.Track },
  single: { ma: 'one', lox: LoxoneRepeatMode.Track },
  '1': { ma: 'one', lox: LoxoneRepeatMode.Track },

  all: { ma: 'all', lox: LoxoneRepeatMode.Queue },
  queue: { ma: 'all', lox: LoxoneRepeatMode.Queue },
  playlist: { ma: 'all', lox: LoxoneRepeatMode.Queue },
  '2': { ma: 'all', lox: LoxoneRepeatMode.Queue },
  true: { ma: 'all', lox: LoxoneRepeatMode.Queue },
  yes: { ma: 'all', lox: LoxoneRepeatMode.Queue },
};

/**
 * Execution context supplied to every Music Assistant command handler invocation.
 */
export interface MusicAssistantCommandContext {
  client: MusicAssistantClient;
  maPlayerId: string;
  loxoneZoneId: number;
  getZoneOrWarn(): ReturnType<typeof getZoneById>;
  pushPlayerEntryUpdate(update: Partial<PlayerStatus>): void;
}

/**
 * Translates Loxone command verbs into Music Assistant RPC calls.
 */
export async function handleMusicAssistantControlCommand(
  ctx: MusicAssistantCommandContext,
  command: string,
  param?: any,
): Promise<boolean> {
  switch (command) {
    case 'resume':
    case 'play':
      await ctx.client.rpc('players/cmd/play', { player_id: ctx.maPlayerId });
      return true;

    case 'pause':
      await ctx.client.rpc('players/cmd/pause', { player_id: ctx.maPlayerId });
      return true;

    case 'stop':
      await ctx.client.rpc('players/cmd/stop', { player_id: ctx.maPlayerId });
      return true;

    case 'queueminus':
      await ctx.client.rpc('players/cmd/previous', { player_id: ctx.maPlayerId });
      return true;

    case 'queueplus':
      await ctx.client.rpc('players/cmd/next', { player_id: ctx.maPlayerId });
      return true;

    case 'position': {
      const requestedSeconds = coerceToOptionalNumber(param);
      if (requestedSeconds === undefined) {
        logger.warn(`[MusicAssistant][Zone:${ctx.loxoneZoneId}] position command missing numeric payload`);
        return true;
      }

      const seconds = Math.max(0, requestedSeconds);
      try {
        await ctx.client.rpc('player_queues/seek', {
          queue_id: ctx.maPlayerId,
          position: seconds,
        });
        ctx.pushPlayerEntryUpdate({
          time: seconds,
          position_ms: Math.round(seconds * 1000),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[MusicAssistant] Failed to seek to position ${seconds}: ${message}`);
      }
      return true;
    }

    case 'volume': {
      const zone = ctx.getZoneOrWarn();
      if (!zone) return true; // Already logged by helper

      const current = Number(zone.playerEntry.volume ?? 0);
      const delta = Number(param || 0);
      const newVol = Math.max(0, Math.min(100, current + delta));

      await ctx.client.rpc('players/cmd/volume_set', {
        player_id: ctx.maPlayerId,
        volume_level: newVol,
      });
      ctx.pushPlayerEntryUpdate({ volume: newVol });
      return true;
    }

    case 'repeat': {
      const key = String(param ?? 'off').toLowerCase();
      const entry = repeatModeMap[key] ?? repeatModeMap.off;

      await ctx.client.rpc('player_queues/repeat', {
        queue_id: ctx.maPlayerId,
        repeat_mode: entry.ma,
      });

      ctx.pushPlayerEntryUpdate({ plrepeat: entry.lox });
      return true;
    }

    case 'shuffle': {
      let enable: boolean;
      if (Array.isArray(param) && param.length > 0) {
        const flag = String(param[0]).toLowerCase();
        enable = flag === 'enable' || flag === 'true' || flag === '1';
      } else if (typeof param === 'string') {
        const flag = param.toLowerCase();
        enable = flag === 'enable' || flag === 'true' || flag === '1';
      } else if (param !== undefined) {
        enable = Boolean(param);
      } else {
        const queues = await ctx.client.rpc('player_queues/all');
        const mine = queues.find((x: any) => x.queue_id === ctx.maPlayerId);
        enable = mine ? !mine.shuffle_enabled : true;
      }
      await ctx.client.rpc('player_queues/shuffle', {
        queue_id: ctx.maPlayerId,
        shuffle_enabled: enable,
      });
      ctx.pushPlayerEntryUpdate({ plshuffle: enable });
      const zone = ctx.getZoneOrWarn();
      if (zone?.queue) {
        zone.queue.shuffle = enable;
      }
      return true;
    }

    case 'groupJoin': {
      const targetLeader = String(param);
      await ctx.client.rpc('players/cmd/group', {
        player_id: ctx.maPlayerId,
        target_player: targetLeader,
      });
      if (targetLeader) {
        await alignVolumeOnJoin(ctx, targetLeader, [ctx.maPlayerId]);
      }
      updateZoneGroup();
      return true;
    }

    case 'groupJoinMany': {
      const childIds = normalizeList(param);
      if (childIds.length === 0) return true;
      await ctx.client.rpc('players/cmd/group_many', {
        target_player: ctx.maPlayerId,
        child_player_ids: childIds,
      });
      if (childIds.length > 0) {
        await alignVolumeOnJoin(ctx, ctx.maPlayerId, childIds);
      }
      updateZoneGroup();
      return true;
    }

    case 'groupLeaveMany': {
      const childIds = normalizeList(param);
      if (childIds.length === 0) return true;
      await ctx.client.rpc('players/cmd/ungroup_many', {
        player_ids: childIds,
      });
      updateZoneGroup();
      return true;
    }

    case 'groupLeave':
      await ctx.client.rpc('players/cmd/ungroup', { player_id: ctx.maPlayerId });
      updateZoneGroup();
      return true;

    case 'queue': {
      const segments = Array.isArray(param)
        ? param
        : typeof param === 'string'
          ? param.split('/')
          : [];

      const [action, target] = segments.filter(Boolean);

      if (action === 'play' && target) {
        try {
          const playIndex = Number(target);
          if (!Number.isFinite(playIndex)) {
            logger.warn(
              `[MusicAssistant][Zone:${ctx.loxoneZoneId}] Invalid queue play index received: ${target}`,
            );
            return true;
          }
          await ctx.client.rpc('player_queues/play_index', {
            queue_id: ctx.maPlayerId,
            index: playIndex,
          });
          logger.info(
            `[MusicAssistant][Zone:${ctx.loxoneZoneId}] Queue play_index requested for: ${target}`,
          );
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(`[MusicAssistant] Failed to send queue play_index command: ${message}`);
          return true; // command was intended; treat as handled to avoid unknown warning
        }
      }

      return false;
    }

    default:
      return false;
  }
}

function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry ?? '').trim())
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === 'string') {
    return value
      .split(/[;,]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
}

function coerceToOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    if (value === 1) return true;
    if (value === 0) return false;
    return value > 0;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return undefined;
    if (['true', 'yes', '1', 'on', 'enable', 'enabled'].includes(trimmed)) return true;
    if (['false', 'no', '0', 'off', 'disable', 'disabled'].includes(trimmed)) return false;
  }
  return undefined;
}

function clampVolumeValue(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric < 0) return 0;
  if (numeric > 100) return 100;
  return Math.round(numeric);
}

async function alignVolumeOnJoin(
  ctx: MusicAssistantCommandContext,
  leaderBackendId: string,
  participantBackendIds: string[],
): Promise<void> {
  const leaderLookup = findZoneByBackendPlayerId(leaderBackendId);
  if (!leaderLookup) {
    logger.warn(
      `[MusicAssistant][Zone:${ctx.loxoneZoneId}] Cannot align volume: leader ${leaderBackendId} not found`,
    );
    return;
  }

  const leaderVolume = clampVolumeValue(leaderLookup.zone.playerEntry?.volume ?? 0);
  const normalizedLeader = leaderBackendId.trim().toLowerCase();

  const uniqueParticipants = Array.from(
    new Set(
      participantBackendIds
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry) => entry.length > 0),
    ),
  );

  await Promise.all(
    uniqueParticipants.map(async (participantId) => {
      if (participantId.toLowerCase() === normalizedLeader) return;
      const lookup = findZoneByBackendPlayerId(participantId);
      if (!lookup) {
        logger.warn(
          `[MusicAssistant][Zone:${ctx.loxoneZoneId}] Cannot align volume: participant ${participantId} not found`,
        );
        return;
      }

      const currentVolume = clampVolumeValue(lookup.zone.playerEntry?.volume ?? 0);
      const delta = leaderVolume - currentVolume;
      if (delta === 0) {
        updateZonePlayerStatus(lookup.zoneId, { volume: leaderVolume });
        return;
      }

      try {
        await sendCommandToZone(lookup.zoneId, 'volume', String(delta));
        updateZonePlayerStatus(lookup.zoneId, { volume: leaderVolume });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(
          `[MusicAssistant][Zone:${ctx.loxoneZoneId}] Failed to align volume for zone ${lookup.zoneId}: ${message}`,
        );
      }
    }),
  );
}

function coerceToOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (Array.isArray(value) && value.length > 0) {
    return coerceToOptionalNumber(value[0]);
  }
  if (typeof value === 'object') {
    const source = (value as Record<string, unknown>).position ?? (value as Record<string, unknown>).time ?? (value as Record<string, unknown>).seconds;
    return coerceToOptionalNumber(source);
  }
  return undefined;
}
