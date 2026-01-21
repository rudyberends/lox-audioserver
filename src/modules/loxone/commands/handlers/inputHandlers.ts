import { createLogger } from '@/core/logging/logger';
import { buildEmptyResponse, buildResponse } from '@/modules/loxone/commands/responses';
import { decodeSegment, parseNumberPart, splitCommand } from '@/modules/loxone/commands/utils/commandUtils';
import { zoneManager } from '@/modules/zones/zoneManager';
import { notifyLineInChanged } from '@/modules/loxone/ws/notifier';
import { getConfig, updateConfig } from '@/domain/config/configStore';
import type { AudioServerConfig, LineInInputConfig } from '@/domain/config/types';
import type { LoxoneZoneState } from '@/modules/zones/types/loxoneZoneState';
import { lineInIngestRegistry } from '@/modules/audio/inputs/linein/lineInIngestRegistry';
import { resolveLineInSampleRate } from '@/modules/audio/inputs/linein/lineInConstants';
import { sendspinLineInService } from '@/modules/audio/inputs/linein/sendspinLineInService';

type ResolvedLineInInput = {
  id: string;
  name: string;
  iconType: number;
  index: number;
};

const log = createLogger('Loxone', 'InputHandlers');

const LINEIN_ID_START = 1000001;
const DEFAULT_ICON_TYPE = 0;
const PCM_CHANNELS = 2;
const NO_SIGNAL_TITLE = 'No Signal detected';
const activeLineInByZone = new Map<number, { inputId: string; stop: () => void }>();
const lineInWatchByZone = new Map<number, { inputId: string; stop: () => void }>();

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

function resolveLineInInputConfig(inputId: string): LineInInputConfig | null {
  const index = findLineInIndexById(inputId);
  if (index == null || index < 0) {
    return null;
  }
  const config = getConfig();
  const entries = Array.isArray(config.inputs?.lineIn?.inputs)
    ? config.inputs!.lineIn!.inputs!
    : [];
  return (entries[index] ?? null) as LineInInputConfig | null;
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
  const rawValue = extractLineInValue(rawId);
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
  const iconType = selected?.iconType ?? DEFAULT_ICON_TYPE;

  log.info('line-in selected', { zoneId, inputId: audiopath });
  ensureLineInWatch(zoneId, audiopath);
  startLineInPlayback(zoneId, audiopath, title, iconType);
  return buildEmptyResponse(command);
}

function extractLineInValue(rawId: string): string {
  if (typeof rawId !== 'string') {
    return rawId as unknown as string;
  }
  const lowered = rawId.toLowerCase();
  if (!lowered.startsWith('linein')) {
    return rawId;
  }
  const candidate = rawId.slice('linein'.length);
  return /^\d+$/.test(candidate) ? candidate : rawId;
}

function startLineInPlayback(zoneId: number, inputId: string, title: string, iconType: number): void {
  clearActiveLineIn(zoneId);
  sendspinLineInService.requestStart(inputId);
  const session = lineInIngestRegistry.getSession(inputId);
  const stream = session?.stream ?? null;
  if (!stream) {
    log.info('line-in ingest pending; waiting for stream', { zoneId, inputId });
    overwriteLineInState(zoneId, inputId, NO_SIGNAL_TITLE, iconType, 'pause');
    return;
  }

  const inputConfig = resolveLineInInputConfig(inputId);
  const sessionFormat = session?.format ?? null;
  const sampleRate = sessionFormat?.sampleRate ?? resolveLineInSampleRate(inputConfig);
  const channels = sessionFormat?.channels ?? PCM_CHANNELS;
  const pcmFormat = sessionFormat?.pcmFormat ?? 's16le';

  overwriteLineInState(zoneId, inputId, title, iconType, 'play');
  const stop = lineInIngestRegistry.onStop(inputId, () => {
    const active = activeLineInByZone.get(zoneId);
    if (!active || active.inputId !== inputId) {
      return;
    }
    handleLineInStopped(zoneId, inputId);
  });
  activeLineInByZone.set(zoneId, { inputId, stop });
  zoneManager.playInputSource(
    zoneId,
    'linein',
    {
      kind: 'pipe',
      path: `linein:${inputId}`,
      format: pcmFormat,
      sampleRate,
      channels,
      realTime: true,
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

function clearActiveLineIn(zoneId: number): void {
  const active = activeLineInByZone.get(zoneId);
  if (active) {
    sendspinLineInService.requestStop(active.inputId);
    active.stop();
    activeLineInByZone.delete(zoneId);
  }
}

function handleLineInStopped(zoneId: number, inputId: string): void {
  const state = zoneManager.getZoneState(zoneId);
  if (!state) {
    return;
  }
  const currentPath = state.audiopath ?? '';
  const matches =
    currentPath === `linein:${inputId}` || currentPath === `linein://${inputId}`;
  if (!matches) {
    return;
  }
  zoneManager.patchState(
    zoneId,
    {
      mode: 'pause',
      time: 0,
      duration: 0,
      title: NO_SIGNAL_TITLE,
      artist: '',
      album: '',
      station: '',
      audiopath: `linein:${inputId}`,
      audiotype: 3,
    },
    true,
  );
  clearActiveLineIn(zoneId);
}

function resolveLineInMeta(inputId: string): { title: string; iconType: number } {
  const resolvedInputs = resolveLineInInputs();
  const match = resolvedInputs.find((entry) => entry.id === inputId);
  return {
    title: match?.name ?? NO_SIGNAL_TITLE,
    iconType: match?.iconType ?? DEFAULT_ICON_TYPE,
  };
}

function ensureLineInWatch(zoneId: number, inputId: string): void {
  const existing = lineInWatchByZone.get(zoneId);
  if (existing) {
    if (existing.inputId === inputId) {
      return;
    }
    sendspinLineInService.requestStop(existing.inputId);
    existing.stop();
    lineInWatchByZone.delete(zoneId);
  }
  const stop = lineInIngestRegistry.onStart(inputId, () => {
    const state = zoneManager.getZoneState(zoneId);
    if (!state) {
      return;
    }
    const currentPath = state.audiopath ?? '';
    const matches =
      currentPath === `linein:${inputId}` || currentPath === `linein://${inputId}`;
    if (!matches) {
      return;
    }
    const { title, iconType } = resolveLineInMeta(inputId);
    startLineInPlayback(zoneId, inputId, title, iconType);
  });
  lineInWatchByZone.set(zoneId, { inputId, stop });
}

function overwriteLineInState(
  zoneId: number,
  inputId: string,
  title: string,
  iconType: number,
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
    icontype: iconType,
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
