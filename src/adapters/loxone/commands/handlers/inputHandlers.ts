import { createLogger } from '@/shared/logging/logger';
import { buildEmptyResponse, buildResponse } from '@/adapters/loxone/commands/responses';
import { decodeSegment, parseNumberPart, splitCommand } from '@/adapters/loxone/commands/utils/commandUtils';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';
import type { AudioServerConfig, LineInInputConfig } from '@/domain/config/types';
import type { LoxoneZoneState } from '@/domain/loxone/types';
import { AudioType, FileType } from '@/domain/loxone/enums';
import { resolveLineInSampleRate } from '@/adapters/inputs/linein/lineInConstants';
import type { LineInIngestRegistry } from '@/adapters/inputs/linein/lineInIngestRegistry';
import type { SendspinLineInService } from '@/adapters/inputs/linein/sendspinLineInService';
import type { ConfigPort } from '@/ports/ConfigPort';

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
type LineInState = {
  activeLineInByZone: Map<number, { inputId: string; stop: () => void }>;
  lineInWatchByZone: Map<number, { inputId: string; stop: () => void }>;
};

type LineInDeps = {
  registry: LineInIngestRegistry;
  sendspinLineIn: SendspinLineInService;
  notifier: LoxoneWsNotifier;
};

export function createInputHandlers(
  zoneManager: ZoneManagerFacade,
  configPort: ConfigPort,
  deps: LineInDeps,
) {
  const state: LineInState = {
    activeLineInByZone: new Map(),
    lineInWatchByZone: new Map(),
  };
  return {
    audioCfgGetInputs: (command: string) => audioCfgGetInputs(configPort, command),
    audioCfgInputRename: (command: string) => audioCfgInputRename(configPort, deps, command),
    audioCfgInputType: (command: string) => audioCfgInputType(configPort, deps, command),
    audioLineIn: (command: string) => audioLineIn(zoneManager, configPort, deps, state, command),
  };
}

function resolveMacId(configPort: ConfigPort): string {
  const macId = configPort.getConfig()?.system?.audioserver?.macId?.trim().toUpperCase();
  return macId || 'UNKNOWN';
}

function resolveLineInInputs(configPort: ConfigPort): ResolvedLineInInput[] {
  const config = configPort.getConfig();
  const entries = Array.isArray(config.inputs?.lineIn?.inputs) ? config.inputs!.lineIn!.inputs! : [];
  const macId = resolveMacId(configPort);

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

function findLineInIndexById(configPort: ConfigPort, inputId: string): number | null {
  if (!inputId) return null;
  const match = resolveLineInInputs(configPort).find((entry) => entry.id === inputId);
  return match ? match.index : null;
}

function resolveLineInInputConfig(configPort: ConfigPort, inputId: string): LineInInputConfig | null {
  const index = findLineInIndexById(configPort, inputId);
  if (index == null || index < 0) {
    return null;
  }
  const config = configPort.getConfig();
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

export function audioCfgGetInputs(configPort: ConfigPort, command: string) {
  const inputs = resolveLineInInputs(configPort).map((item) => ({
    cmd: 'linein',
    description: '',
    id: item.id,
    name: item.name,
    icontype: item.iconType,
    type: 6,
  }));
  return buildResponse(command, 'getinputs', inputs);
}

export async function audioCfgInputRename(configPort: ConfigPort, deps: LineInDeps, command: string) {
  const parts = splitCommand(command);
  const inputId = decodeInputId(decodeSegment(parts[3] ?? ''));
  const nextName = decodeSegment(parts[5] ?? '').trim();

  if (!inputId) {
    return buildResponse(command, 'input', [{ action: 'ok' }]);
  }

  const index = findLineInIndexById(configPort, inputId);
  if (index === null) {
    return buildResponse(command, 'input', [{ action: 'ok' }]);
  }

  await configPort.updateConfig((cfg) => {
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

  deps.notifier.notifyLineInChanged();
  return buildResponse(command, 'input', [{ action: 'ok' }]);
}

export async function audioCfgInputType(configPort: ConfigPort, deps: LineInDeps, command: string) {
  const parts = splitCommand(command);
  const inputId = decodeInputId(decodeSegment(parts[3] ?? ''));
  const iconRaw = decodeSegment(parts[5] ?? '');
  const iconType = Number(iconRaw);

  if (!inputId) {
    return buildResponse(command, 'input', [{ action: 'ok' }]);
  }

  const index = findLineInIndexById(configPort, inputId);
  if (index === null) {
    return buildResponse(command, 'input', [{ action: 'ok' }]);
  }

  if (Number.isFinite(iconType)) {
    await configPort.updateConfig((cfg) => {
      const inputs = getMutableLineInInputs(cfg);
      const current = (inputs[index] ?? {}) as LineInInputConfig;
      inputs[index] = { ...current, iconType };
    });
    deps.notifier.notifyLineInChanged();
  }

  return buildResponse(command, 'input', [{ action: 'ok' }]);
}

function audioLineIn(
  zoneManager: ZoneManagerFacade,
  configPort: ConfigPort,
  deps: LineInDeps,
  state: LineInState,
  command: string,
) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[1], 0);
  const rawId = parts[3] ?? parts[2] ?? '';
  const rawValue = extractLineInValue(rawId);
  const inputId = decodeInputId(rawValue);

  if (!zoneId) {
    return buildEmptyResponse(command);
  }

  const resolvedId = inputId || rawValue || '1';
  const resolvedInputs = resolveLineInInputs(configPort);
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
  ensureLineInWatch(zoneManager, configPort, deps, state, zoneId, audiopath);
  startLineInPlayback(zoneManager, configPort, deps, state, zoneId, audiopath, title, iconType);
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

function startLineInPlayback(
  zoneManager: ZoneManagerFacade,
  configPort: ConfigPort,
  deps: LineInDeps,
  state: LineInState,
  zoneId: number,
  inputId: string,
  title: string,
  iconType: number,
): void {
  clearActiveLineIn(deps, state, zoneId);
  deps.sendspinLineIn.requestStart(inputId);
  const session = deps.registry.getSession(inputId);
  const stream = session?.stream ?? null;
  if (!stream) {
    log.info('line-in ingest pending; waiting for stream', { zoneId, inputId });
    overwriteLineInState(zoneManager, configPort, deps, zoneId, inputId, NO_SIGNAL_TITLE, iconType, 'pause');
    return;
  }

  const inputConfig = resolveLineInInputConfig(configPort, inputId);
  const sessionFormat = session?.format ?? null;
  const sampleRate = sessionFormat?.sampleRate ?? resolveLineInSampleRate(inputConfig);
  const channels = sessionFormat?.channels ?? PCM_CHANNELS;
  const pcmFormat = sessionFormat?.pcmFormat ?? 's16le';

  overwriteLineInState(zoneManager, configPort, deps, zoneId, inputId, title, iconType, 'play');
  const stop = deps.registry.onStop(inputId, () => {
    const active = state.activeLineInByZone.get(zoneId);
    if (!active || active.inputId !== inputId) {
      return;
    }
    handleLineInStopped(zoneManager, deps, state, zoneId, inputId);
  });
  state.activeLineInByZone.set(zoneId, { inputId, stop });
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

function clearActiveLineIn(deps: LineInDeps, state: LineInState, zoneId: number): void {
  const active = state.activeLineInByZone.get(zoneId);
  if (active) {
    deps.sendspinLineIn.requestStop(active.inputId);
    active.stop();
    state.activeLineInByZone.delete(zoneId);
  }
}

function handleLineInStopped(
  zoneManager: ZoneManagerFacade,
  deps: LineInDeps,
  state: LineInState,
  zoneId: number,
  inputId: string,
): void {
  const zoneState = zoneManager.getZoneState(zoneId);
  if (!zoneState) {
    return;
  }
  const currentPath = zoneState.audiopath ?? '';
  const matches =
    currentPath === `linein:${inputId}` || currentPath === `linein://${inputId}`;
  if (!matches) {
    return;
  }
  zoneManager.applyPatch(
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
      ...resolveLineInLoxoneTypes(deps, inputId),
    },
    true,
  );
  clearActiveLineIn(deps, state, zoneId);
}

function resolveLineInMeta(configPort: ConfigPort, inputId: string): { title: string; iconType: number } {
  const resolvedInputs = resolveLineInInputs(configPort);
  const match = resolvedInputs.find((entry) => entry.id === inputId);
  return {
    title: match?.name ?? NO_SIGNAL_TITLE,
    iconType: match?.iconType ?? DEFAULT_ICON_TYPE,
  };
}

function resolveLineInLoxoneTypes(
  deps: LineInDeps,
  inputId: string,
): { audiotype: number; type: number } {
  const controls = deps.sendspinLineIn.getControlSupport(inputId);
  if (controls && controls.length) {
    return { audiotype: AudioType.File, type: FileType.File };
  }
  return { audiotype: AudioType.LineIn, type: FileType.LineIn };
}

function ensureLineInWatch(
  zoneManager: ZoneManagerFacade,
  configPort: ConfigPort,
  deps: LineInDeps,
  state: LineInState,
  zoneId: number,
  inputId: string,
): void {
  const existing = state.lineInWatchByZone.get(zoneId);
  if (existing) {
    if (existing.inputId === inputId) {
      return;
    }
    deps.sendspinLineIn.requestStop(existing.inputId);
    existing.stop();
    state.lineInWatchByZone.delete(zoneId);
  }
  const stop = deps.registry.onStart(inputId, () => {
    const zoneState = zoneManager.getZoneState(zoneId);
    if (!zoneState) {
      return;
    }
    const currentPath = zoneState.audiopath ?? '';
    const matches =
      currentPath === `linein:${inputId}` || currentPath === `linein://${inputId}`;
    if (!matches) {
      return;
    }
    const { title, iconType } = resolveLineInMeta(configPort, inputId);
    startLineInPlayback(zoneManager, configPort, deps, state, zoneId, inputId, title, iconType);
  });
  state.lineInWatchByZone.set(zoneId, { inputId, stop });
}

function overwriteLineInState(
  zoneManager: ZoneManagerFacade,
  configPort: ConfigPort,
  deps: LineInDeps,
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
  const { audiotype, type } = resolveLineInLoxoneTypes(deps, inputId);
  const sourceName = resolveZoneSourceName(configPort, zoneId) ?? current.sourceName;
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
    audiotype,
    icontype: iconType,
    type,
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
  zoneManager.applyPatch(zoneId, patch, true);
}

function resolveZoneSourceName(configPort: ConfigPort, zoneId: number): string | undefined {
  const config = configPort.getConfig();
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
