import { createLogger } from '@/core/logging/logger';
import { buildEmptyResponse, buildResponse } from '@/modules/loxone/commands/responses';
import { decodeSegment, parseNumberPart, splitCommand } from '@/modules/loxone/commands/utils/commandUtils';
import { zoneManager } from '@/modules/zones/zoneManager';
import { notifyLineInChanged } from '@/modules/loxone/ws/notifier';
import { getConfig, updateConfig } from '@/domain/config/configStore';
import type { AudioServerConfig, LineInInputConfig } from '@/domain/config/types';
import type { LoxoneZoneState } from '@/modules/zones/types/loxoneZoneState';
import { lineInIngestRegistry } from '@/modules/audio/inputs/linein/lineInIngestRegistry';

type ResolvedLineInInput = {
  id: string;
  name: string;
  iconType: number;
  index: number;
};

const log = createLogger('Loxone', 'InputHandlers');

const LINEIN_ID_START = 1000001;
const DEFAULT_ICON_TYPE = 0;
const PCM_SAMPLE_RATE = 48000;
const PCM_CHANNELS = 2;
const pendingLineInByZone = new Map<number, { inputId: string; stop: () => void }>();

function resolveMacId(): string {
  const macId = getConfig()?.system?.audioserver?.macId?.trim().toUpperCase();
  return macId || 'UNKNOWN';
}

function resolveLineInInputs(): ResolvedLineInInput[] {
  const config = getConfig();
  const entries = Array.isArray(config.inputs?.lineIn?.inputs) ? config.inputs!.lineIn!.inputs! : [];
  const macId = resolveMacId();

  return entries.map((entry, index) => {
    const record = entry && typeof entry === 'object' ? (entry as LineInInputConfig) : {};
    const id = typeof record.id === 'string' && record.id.trim()
      ? record.id.trim()
      : `${macId}#${LINEIN_ID_START + index}`;
    const name = typeof record.name === 'string' && record.name.trim()
      ? record.name.trim()
      : `LineIn${index + 1}`;
    const iconType = Number.isFinite(record.iconType) ? Number(record.iconType) : DEFAULT_ICON_TYPE;
    return { id, name, iconType, index };
  });
}

function findLineInIndexById(inputId: string): number | null {
  if (!inputId) return null;
  const match = resolveLineInInputs().find((entry) => entry.id === inputId);
  return match ? match.index : null;
}

function getMutableLineInInputs(config: AudioServerConfig): LineInInputConfig[] {
  if (!config.inputs) {
    config.inputs = {};
  }
  if (!config.inputs.lineIn) {
    config.inputs.lineIn = { inputs: [] };
  }
  if (!Array.isArray(config.inputs.lineIn.inputs)) {
    config.inputs.lineIn.inputs = [];
  }
  return config.inputs.lineIn.inputs;
}

export function audioCfgGetInputs(command: string) {
  const inputs = resolveLineInInputs().map((item) => ({
    cmd: 'linein',
    description: '',
    id: item.id,
    name: item.name,
    icontype: item.iconType,
    type: 6,
  }));
  return buildResponse(command, 'getinputs', inputs);
}

export async function audioCfgInputRename(command: string) {
  const parts = splitCommand(command);
  const inputId = decodeInputId(decodeSegment(parts[3] ?? ''));
  const nextName = decodeSegment(parts[5] ?? '').trim();

  if (!inputId) {
    return buildResponse(command, 'input', [{ action: 'ok' }]);
  }

  const index = findLineInIndexById(inputId);
  if (index === null) {
    return buildResponse(command, 'input', [{ action: 'ok' }]);
  }

  await updateConfig((cfg) => {
    const inputs = getMutableLineInInputs(cfg);
    const current = (inputs[index] ?? {}) as LineInInputConfig;
    const updated: LineInInputConfig = { ...current };
    if (nextName) {
      updated.name = nextName;
    } else {
      delete updated.name;
    }
    inputs[index] = updated;
  });

  notifyLineInChanged();
  return buildResponse(command, 'input', [{ action: 'ok' }]);
}

export async function audioCfgInputType(command: string) {
  const parts = splitCommand(command);
  const inputId = decodeInputId(decodeSegment(parts[3] ?? ''));
  const iconRaw = decodeSegment(parts[5] ?? '');
  const iconType = Number(iconRaw);

  if (!inputId) {
    return buildResponse(command, 'input', [{ action: 'ok' }]);
  }

  const index = findLineInIndexById(inputId);
  if (index === null) {
    return buildResponse(command, 'input', [{ action: 'ok' }]);
  }

  if (Number.isFinite(iconType)) {
    await updateConfig((cfg) => {
      const inputs = getMutableLineInInputs(cfg);
      const current = (inputs[index] ?? {}) as LineInInputConfig;
      inputs[index] = { ...current, iconType };
    });
    notifyLineInChanged();
  }

  return buildResponse(command, 'input', [{ action: 'ok' }]);
}

export function audioLineIn(command: string) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[1], 0);
  const rawId = parts[3] ?? parts[2] ?? '';
  const rawValue =
    typeof rawId === 'string' && rawId.toLowerCase().startsWith('linein')
      ? rawId.slice('linein'.length)
      : rawId;
  const inputId = decodeInputId(rawValue);

  if (!zoneId) {
    return buildEmptyResponse(command);
  }

  const resolvedId = inputId || rawValue || '1';
  const resolvedInputs = resolveLineInInputs();
  let selected = resolvedInputs.find((entry) => entry.id === resolvedId);
  if (!selected && /^\d+$/.test(resolvedId)) {
    const idx = Number(resolvedId) - 1;
    if (idx >= 0 && idx < resolvedInputs.length) {
      selected = resolvedInputs[idx];
    }
  }

  const title = selected?.name ?? (resolvedInputs[0]?.name ?? 'LineIn1');
  const audiopath = selected?.id ?? resolvedId;

  log.info('line-in selected', { zoneId, inputId: audiopath });
  startLineInPlayback(zoneId, audiopath, title);
  return buildEmptyResponse(command);
}

function startLineInPlayback(zoneId: number, inputId: string, title: string): void {
  clearPendingLineIn(zoneId);
  const stream = lineInIngestRegistry.getStream(inputId);
  if (!stream) {
    log.info('line-in ingest pending; waiting for stream', { zoneId, inputId });
    overwriteLineInState(zoneId, inputId, title, 'stop');
    const stop = lineInIngestRegistry.onStart(inputId, (session) => {
      const pending = pendingLineInByZone.get(zoneId);
      if (!pending || pending.inputId !== inputId) {
        return;
      }
      clearPendingLineIn(zoneId);
      startLineInPlayback(zoneId, inputId, title);
    });
    pendingLineInByZone.set(zoneId, { inputId, stop });
    return;
  }

  overwriteLineInState(zoneId, inputId, title, 'play');
  zoneManager.playInputSource(
    zoneId,
    'linein',
    {
      kind: 'pipe',
      path: `linein:${inputId}`,
      format: 's16le',
      sampleRate: PCM_SAMPLE_RATE,
      channels: PCM_CHANNELS,
      stream,
    },
    {
      title,
      artist: '',
      album: '',
      audiopath: `linein://${inputId}`,
      station: '',
      duration: 0,
    },
  );
}

function clearPendingLineIn(zoneId: number): void {
  const pending = pendingLineInByZone.get(zoneId);
  if (pending) {
    pending.stop();
    pendingLineInByZone.delete(zoneId);
  }
}

function overwriteLineInState(
  zoneId: number,
  inputId: string,
  title: string,
  mode: LoxoneZoneState['mode'],
): void {
  const current = zoneManager.getZoneState(zoneId);
  if (!current) {
    return;
  }
  const sourceName = resolveZoneSourceName(zoneId) ?? current.sourceName;
  const patch: Partial<LoxoneZoneState> = {
    playerid: current.playerid,
    name: current.name,
    volume: current.volume,
    plrepeat: 0,
    plshuffle: 0,
    qindex: 0,
    qid: '',
    time: 0,
    duration: 0,
    audiopath: `linein:${inputId}`,
    audiotype: 3,
    type: 6,
    title,
    artist: '',
    album: '',
    coverurl: '',
    station: '',
    parent: null,
    mode,
    clientState: 'on',
    power: 'on',
    queueAuthority: 'local',
    sourceName,
  };
  zoneManager.patchState(zoneId, patch, true);
}

function resolveZoneSourceName(zoneId: number): string | undefined {
  const config = getConfig();
  const zone = config.zones?.find((entry) => entry.id === zoneId);
  const mac = zone?.sourceMac?.trim();
  if (mac) {
    return mac;
  }
  const systemMac = config.system?.audioserver?.macId?.trim();
  return systemMac || undefined;
}

function decodeInputId(raw: string): string {
  if (!raw) {
    return '';
  }
  const table: Record<string, string> = {
    '-': '+',
    _: '/',
  };
  try {
    const decoded = Buffer.from(raw.replace(/[-_]/g, (str) => table[str] ?? str), 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (Array.isArray(parsed) && typeof parsed[0] === 'string') {
      return parsed[0];
    }
  } catch {
    // ignore
  }
  return raw;
}
