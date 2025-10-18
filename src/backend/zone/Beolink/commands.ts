import logger from '../../../utils/troxorlogger';
export interface BeolinkCommandContext {
  adjustVolume(change: number): Promise<void>;
  doAction(action: string, param?: any): Promise<void>;
  servicePlay(stationId: string, payload?: Record<string, any>): Promise<void>;
}

const actionMap: Record<string, string> = {
  resume: 'Stream/Play',
  play: 'Stream/Play',
  pause: 'Stream/Pause',
  queueminus: 'Stream/Backward',
  queueplus: 'Stream/Forward',
  volume: 'adjustVolume',
  groupJoin: 'Device/OneWayJoin',
  groupJoinMany: 'Device/OneWayJoin',
  groupLeave: 'Device/OneWayLeave',
  groupLeaveMany: 'Device/OneWayLeave',
  repeat: 'List/Repeat',
  shuffle: 'List/Shuffle',
};

export async function handleBeolinkCommand(
  ctx: BeolinkCommandContext,
  command: string,
  param: any,
): Promise<boolean> {
  if (command === 'serviceplay') {
    const { stationId, payload } = normalizeServicePlayPayload(param);
    if (!stationId) {
      logger.warn('[BeoLink] serviceplay command missing station identifier');
      return true;
    }
    await ctx.servicePlay(stationId, payload);
    return true;
  }

  const action = actionMap[command];
  if (!action) return false;

  if (action === 'adjustVolume') {
    await ctx.adjustVolume(Number(param ?? 0));
    return true;
  }

  await ctx.doAction(action, param);
  return true;
}

function normalizeServicePlayPayload(param: unknown): {
  stationId?: string;
  payload?: Record<string, any>;
} {
  const payload = coercePayload(param);
  const stationId =
    extractStationId(payload) ??
    (typeof param === 'string' ? sanitizeStationId(param) : undefined);

  return {
    stationId,
    payload: payload ?? (stationId ? { stationId } : undefined),
  };
}

function coercePayload(param: unknown): Record<string, any> | undefined {
  if (param === undefined || param === null) return undefined;

  if (typeof param === 'string') {
    try {
      return JSON.parse(param);
    } catch {
      return { stationId: param };
    }
  }

  if (Array.isArray(param) && param.length > 0) {
    const [first] = param;
    if (typeof first === 'object' && first !== null) {
      return first as Record<string, any>;
    }
    if (typeof first === 'string') {
      return coercePayload(first);
    }
  }

  if (typeof param === 'object') {
    return param as Record<string, any>;
  }

  if (typeof param === 'number' || typeof param === 'boolean') {
    return { stationId: String(param) };
  }

  return undefined;
}

function extractStationId(payload?: Record<string, any>): string | undefined {
  if (!payload) return undefined;

  const directKeys = ['stationId', 'id', 'audiopath', 'station'];
  for (const key of directKeys) {
    const value = payload[key];
    const sanitized = sanitizeStationId(value);
    if (sanitized) return sanitized;
  }

  const nested =
    payload?.playQueueItem?.station?.tuneIn?.stationId ??
    payload?.station?.tuneIn?.stationId ??
    payload?.tuneIn?.stationId;
  const nestedId = sanitizeStationId(nested);
  if (nestedId) return nestedId;

  return undefined;
}

function sanitizeStationId(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;

    const withoutQuery = trimmed.split('?')[0] ?? trimmed;
    const pathSegments = withoutQuery.split('/').filter((segment) => segment.length > 0);
    const lastPathSegment = pathSegments.length > 0 ? pathSegments[pathSegments.length - 1] : withoutQuery;
    const colonSegments = lastPathSegment.split(':').filter((segment) => segment.length > 0);
    const candidate =
      colonSegments.length > 0 ? colonSegments[colonSegments.length - 1] : lastPathSegment;
    const normalized = candidate.trim();
    return normalized.length > 0 ? normalized : undefined;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return undefined;
}
