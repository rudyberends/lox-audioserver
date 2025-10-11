import { updateZoneGroup, getZoneById } from '../zonemanager';
import { PlayerStatus, RepeatMode as LoxoneRepeatMode } from '../loxoneTypes';
import logger from '../../../utils/troxorlogger';
import MusicAssistantClient from './client';
import { denormalizeMediaUri, denormalizePlaylistUri, normalizeMediaUri } from '../../provider/musicAssistant/utils';

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
      const targetStream = denormalizeMediaUri(stream);
      logger.info(`[MusicAssistant][Zone:${ctx.loxoneZoneId}] serviceplay: ${stream}`);

      try {
        await ctx.client.rpc('player_queues/play_media', {
          queue_id: ctx.maPlayerId,
          media: [targetStream],
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

      const playlistUri =
        coerceToOptionalString(info.playlistCommandUri) ??
        coerceToOptionalString(info.audiopath) ??
        coerceToOptionalString(info.playlistId) ??
        coerceToOptionalString(info.id);
      const playlistFallback =
        coerceToOptionalString(info.rawId) ??
        coerceToOptionalString(info.playlistId) ??
        coerceToOptionalString(info.id) ??
        coerceToOptionalString(info.audiopath);
      if (!playlistUri) {
        logger.warn(`[MusicAssistant][Zone:${ctx.loxoneZoneId}] playlistplay payload missing playlist URI`);
        return true;
      }

      const option = typeof info.option === 'string' && info.option ? info.option : 'replace';
      const startItem =
        coerceToOptionalString(info.start_item) ??
        coerceToOptionalString(info.startItem) ??
        coerceToOptionalString(info.track);
      const normalizedPlaylistUri = normalizePlaylistCommandUri(playlistUri, playlistFallback);
      const targetUri = normalizedPlaylistUri || playlistUri || playlistFallback;
      const maUri = denormalizePlaylistUri(targetUri ?? playlistUri ?? '') || denormalizeMediaUri(targetUri ?? playlistUri ?? '');

      logger.info(`[MusicAssistant][Zone:${ctx.loxoneZoneId}] playlistplay: ${targetUri}`);

      try {
        const payload: Record<string, any> = {
          queue_id: ctx.maPlayerId,
          media: [maUri],
          option,
        };
        if (startItem) payload.start_item = denormalizeMediaUri(startItem);
        await ctx.client.rpc('player_queues/play_media', payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[MusicAssistant] Failed to play playlist ${playlistUri}: ${message}`);
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

type CommandPayload = Record<string, any>;

/** Attempts to normalise ad-hoc command parameters into a structured payload. */
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

function coerceToOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return undefined;
}

function normalizePlaylistCommandUri(primary: string, fallback?: string): string {
  const candidates = [primary, fallback].filter((value): value is string => typeof value === 'string' && value.length > 0);
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();

    let resolved: string | undefined;

    if (lower.startsWith('library:local:track:') || lower.startsWith('library:local:playlist:')) {
      return trimmed;
    }

    if (lower.startsWith('playlist:')) {
      const rest = trimmed.slice('playlist:'.length);
      if (rest.includes(':') && !rest.includes('://')) {
        return trimmed;
      }
    }

    if (lower.startsWith('library://')) resolved = trimmed;
    else if (lower.startsWith('playlist://')) resolved = trimmed;
    else if (lower.startsWith('http://') || lower.startsWith('https://')) resolved = trimmed;
    else if (lower.startsWith('playlist/')) resolved = `library://${trimmed}`;
    if (lower.startsWith('playlist:')) {
      const rest = trimmed.slice('playlist:'.length);
      if (rest.includes('://')) resolved = rest;
      else if (rest.startsWith('playlist/')) resolved = `library://${rest}`;
      else resolved = `library://playlist/${rest}`;
    }
    if (!resolved && lower.startsWith('library:playlist:')) {
      const rest = trimmed.slice('library:playlist:'.length);
      resolved = `library://playlist/${rest}`;
    }
    if (!resolved && lower.startsWith('library:')) {
      const rest = trimmed.slice('library:'.length);
      if (rest.startsWith('//')) resolved = `library://${rest.slice(2)}`;
      else if (rest.startsWith('playlist:')) resolved = `library://playlist/${rest.slice('playlist:'.length)}`;
      else if (rest.startsWith('playlist/')) resolved = `library://${rest}`;
      else resolved = `library://${rest.replace(/:/g, '/')}`;
    }
    if (!resolved && /^[a-z0-9]+:\/\//i.test(trimmed)) resolved = trimmed;
    if (!resolved && /^\d+$/.test(trimmed)) resolved = `library://playlist/${trimmed}`;
    if (!resolved && /[a-z]:/i.test(trimmed)) resolved = trimmed;

    if (resolved) {
      return normalizeMediaUri(resolved);
    }
  }
  return '';
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
