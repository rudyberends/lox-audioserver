import { updateZoneGroup, getZoneById, Track } from '../zonemanager';
import logger from '../../../utils/troxorlogger';
import MusicAssistantClient from './client';
import { RepeatMode } from './types';

export interface MusicAssistantCommandContext {
  client: MusicAssistantClient;
  maPlayerId: string;
  loxoneZoneId: number;
  getZoneOrWarn(): ReturnType<typeof getZoneById>;
  pushTrackUpdate(update: Partial<Track>): void;
}

export async function handleMusicAssistantCommand(
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

    case 'serviceplay': {
      const info = parseCommandPayload(param);

      if (!info || !info.audiopath) {
        logger.warn(`[MusicAssistant][Zone:${ctx.loxoneZoneId}] serviceplay payload missing audiopath`);
        return true;
      }

      const stream = String(info.audiopath ?? info.id ?? '');
      if (!stream) {
        logger.warn(`[MusicAssistant][Zone:${ctx.loxoneZoneId}] serviceplay payload missing stream`);
        return true;
      }
      const provider = String(info.provider ?? 'library');
      logger.info(`[MusicAssistant][Zone:${ctx.loxoneZoneId}] serviceplay: ${stream}`);

      try {
        await ctx.client.rpc('player_queues/play_media', {
          queue_id: ctx.maPlayerId,
          media: [stream],
          option: 'replace',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[MusicAssistant] Failed to play radio stream ${stream}: ${message}`);
      }

      return true;
    }

    case 'playlistplay': {
      const info = parseCommandPayload(param);

      if (!info) {
        logger.warn(`[MusicAssistant][Zone:${ctx.loxoneZoneId}] playlistplay payload missing`);
        return true;
      }

      const playlistUri = String(info.audiopath ?? info.id ?? '');
      if (!playlistUri) {
        logger.warn(`[MusicAssistant][Zone:${ctx.loxoneZoneId}] playlistplay payload missing playlist URI`);
        return true;
      }

      const option = typeof info.option === 'string' && info.option ? info.option : 'replace';

      logger.info(`[MusicAssistant][Zone:${ctx.loxoneZoneId}] playlistplay: ${playlistUri}`);

      try {
        await ctx.client.rpc('player_queues/play_media', {
          queue_id: ctx.maPlayerId,
          media: [playlistUri],
          option,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[MusicAssistant] Failed to play playlist ${playlistUri}: ${message}`);
      }

      return true;
    }

    case 'volume': {
      const zone = ctx.getZoneOrWarn();
      if (!zone) return true; // Already logged by helper

      const current = Number(zone.track.volume ?? 0);
      const delta = Number(param || 0);
      const newVol = Math.max(0, Math.min(100, current + delta));

      await ctx.client.rpc('players/cmd/volume_set', {
        player_id: ctx.maPlayerId,
        volume_level: newVol,
      });
      ctx.pushTrackUpdate({ volume: newVol });
      return true;
    }

    case 'repeat': {
      const map: Record<string, RepeatMode> = {
        off: RepeatMode.OFF,
        one: RepeatMode.ONE,
        all: RepeatMode.ALL,
        '0': RepeatMode.OFF,
        '1': RepeatMode.ONE,
        '2': RepeatMode.ALL,
      };
      const mode = map[String(param ?? 'off').toLowerCase()] ?? RepeatMode.OFF;
      await ctx.client.rpc('player_queues/repeat', {
        queue_id: ctx.maPlayerId,
        repeat_mode: mode,
      });
      ctx.pushTrackUpdate({ plrepeat: mode });
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
      ctx.pushTrackUpdate({ plshuffle: enable ? 1 : 0 });
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
          await ctx.client.rpc('player_queues/play_index', {
            queue_id: ctx.maPlayerId,
            index: target,
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

type CommandPayload = Record<string, any>;

function parseCommandPayload(param: unknown): CommandPayload | undefined {
  if (param === undefined || param === null) return undefined;

  if (typeof param === 'string') {
    try {
      return JSON.parse(param);
    } catch {
      return { audiopath: param };
    }
  }

  if (Array.isArray(param) && param.length > 0) {
    const first = param[0];
    if (typeof first === 'object' && first !== null) {
      return first as CommandPayload;
    }
    try {
      return JSON.parse(String(first));
    } catch {
      return { audiopath: String(first) };
    }
  }

  if (typeof param === 'object') {
    return param as CommandPayload;
  }

  return undefined;
}
