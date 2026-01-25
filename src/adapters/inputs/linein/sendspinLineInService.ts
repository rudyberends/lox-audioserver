import { PassThrough } from 'node:stream';
import { createLogger } from '@/shared/logging/logger';
import type { LineInInputConfig } from '@/domain/config/types';
import type { LineInIngestFormat, LineInIngestRegistry } from '@/adapters/inputs/linein/lineInIngestRegistry';
import { pcmFormatFromBitDepth } from '@/ports/types/audioFormat';
import { sendspinCore, SourceCommand, SourceControl } from '@lox-audioserver/node-sendspin';
import type { SendspinHookRegistryPort } from '@/adapters/outputs/sendspin/sendspinHookRegistry';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { LineInControlCommand } from '@/ports/InputsPort';

type SendspinLineInMapping = {
  inputId: string;
  clientId: string;
};

type ActiveSource = {
  inputId: string;
  stream: PassThrough;
  format?: LineInIngestFormat;
};

const SOURCE_CONTROL_MAP: Record<LineInControlCommand, SourceControl> = {
  play: SourceControl.PLAY,
  pause: SourceControl.PAUSE,
  next: SourceControl.NEXT,
  previous: SourceControl.PREVIOUS,
  activate: SourceControl.ACTIVATE,
  deactivate: SourceControl.DEACTIVATE,
};
const SOURCE_CONTROL_REVERSE: Record<SourceControl, LineInControlCommand> = {
  [SourceControl.PLAY]: 'play',
  [SourceControl.PAUSE]: 'pause',
  [SourceControl.NEXT]: 'next',
  [SourceControl.PREVIOUS]: 'previous',
  [SourceControl.ACTIVATE]: 'activate',
  [SourceControl.DEACTIVATE]: 'deactivate',
};

const LINEIN_ID_START = 1000001;
const DEFAULT_LINEIN_NAME = 'LineIn';

export class SendspinLineInService {
  private readonly log = createLogger('Audio', 'SendspinLineIn');
  private readonly registry: LineInIngestRegistry;
  private readonly hookRegistry: SendspinHookRegistryPort;
  private readonly mappings = new Map<string, SendspinLineInMapping>();
  private readonly activeSources = new Map<string, ActiveSource>();
  private readonly lastAudioLog = new Map<string, number>();
  private readonly hookStops = new Map<string, () => void>();
  private started = false;
  private readonly configPort: ConfigPort;

  constructor(
    registry: LineInIngestRegistry,
    hookRegistry: SendspinHookRegistryPort,
    configPort: ConfigPort,
  ) {
    this.registry = registry;
    this.hookRegistry = hookRegistry;
    this.configPort = configPort;
  }

  private getConfigPort(): ConfigPort {
    return this.configPort;
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.refresh();
  }

  public stop(): void {
    this.started = false;
    for (const stop of this.hookStops.values()) {
      stop();
    }
    this.hookStops.clear();
    this.mappings.clear();
    for (const [clientId, active] of this.activeSources.entries()) {
      this.registry.stop(active.inputId, 'sendspin-disconnected');
      try {
        active.stream.end();
      } catch {
        /* ignore */
      }
      this.activeSources.delete(clientId);
    }
  }

  public refresh(): void {
    if (!this.started) return;
    const nextMappings = this.resolveMappings();
    const seen = new Set<string>();

    for (const mapping of nextMappings) {
      seen.add(mapping.clientId);
      const existing = this.mappings.get(mapping.clientId);
      if (!existing || existing.inputId !== mapping.inputId) {
        if (existing && existing.inputId !== mapping.inputId) {
          this.stopActiveSource(mapping.clientId, 'sendspin-remap');
        }
        this.mappings.set(mapping.clientId, mapping);
        this.registerHooks(mapping.clientId);
      }
      if (this.activeSources.has(mapping.clientId)) {
        this.sendSourceSettings(mapping.clientId, mapping.inputId, SourceCommand.START);
      }
    }

    for (const clientId of this.mappings.keys()) {
      if (!seen.has(clientId)) {
        this.mappings.delete(clientId);
        this.unregisterHooks(clientId);
        this.stopActiveSource(clientId, 'sendspin-unmapped');
      }
    }
  }

  public requestStart(inputId: string): void {
    const mapping = this.findMappingByInput(inputId);
    if (!mapping) {
      this.log.debug('sendspin line-in start skipped; no mapping', { inputId });
      return;
    }
    this.log.debug('sendspin line-in start requested', { inputId, clientId: mapping.clientId });
    this.sendSourceControl(mapping.clientId, 'activate');
    const sent = this.sendSourceSettings(mapping.clientId, inputId, SourceCommand.START);
    if (!sent) {
      this.sendSourceCommand(mapping.clientId, SourceCommand.START);
    }
  }

  public requestStop(inputId: string): void {
    const mapping = this.findMappingByInput(inputId);
    if (!mapping) {
      this.log.debug('sendspin line-in stop skipped; no mapping', { inputId });
      return;
    }
    this.log.debug('sendspin line-in stop requested', { inputId, clientId: mapping.clientId });
    this.sendSourceCommand(mapping.clientId, SourceCommand.STOP);
    this.sendSourceControl(mapping.clientId, 'deactivate');
  }

  public requestControl(inputId: string, command: LineInControlCommand): void {
    const mapping = this.findMappingByInput(inputId);
    if (!mapping) {
      this.log.debug('sendspin line-in control skipped; no mapping', { inputId, command });
      return;
    }
    this.log.debug('sendspin line-in control requested', {
      inputId,
      clientId: mapping.clientId,
      command,
    });
    this.sendSourceControl(mapping.clientId, command);
  }

  public getControlSupport(inputId: string): LineInControlCommand[] | null {
    const mapping = this.findMappingByInput(inputId);
    if (!mapping) {
      return null;
    }
    const session = sendspinCore.getSessionByClientId(mapping.clientId);
    const supported = session?.getSourceSupport()?.controls ?? null;
    if (!supported || !supported.length) {
      return null;
    }
    return supported.map((control) => SOURCE_CONTROL_REVERSE[control]);
  }

  private registerHooks(clientId: string): void {
    this.unregisterHooks(clientId);
    const stop = this.hookRegistry.register(clientId, {
      onSourceAudio: (_session, chunk) => {
        this.handleSourceAudio(clientId, chunk.data);
      },
      onSourceState: (_session, state) => {
        this.log.debug('sendspin line-in source state', {
          clientId,
          state: state.state,
          signal: state.signal,
        });
        if (state.state && state.state !== 'streaming') {
          this.stopActiveSource(clientId, `sendspin-${state.state}`);
        }
      },
      onDisconnected: () => {
        this.stopActiveSource(clientId, 'sendspin-disconnected');
      },
    });
    this.hookStops.set(clientId, stop);
  }

  private unregisterHooks(clientId: string): void {
    const stop = this.hookStops.get(clientId);
    if (!stop) return;
    stop();
    this.hookStops.delete(clientId);
  }

  private handleSourceAudio(clientId: string, payload: Buffer): void {
    const mapping = this.mappings.get(clientId);
    if (!mapping) return;
    const now = Date.now();
    const lastLog = this.lastAudioLog.get(clientId) ?? 0;
    if (now - lastLog >= 1000) {
      this.lastAudioLog.set(clientId, now);
      this.log.info('sendspin line-in audio chunk received', {
        clientId,
        inputId: mapping.inputId,
        bytes: payload.length,
      });
    }
    const active = this.ensureActiveSource(clientId, mapping.inputId);
    if (!active) return;
    if (!active.stream.write(payload)) {
      this.log.debug('sendspin line-in backpressure drop', { clientId, inputId: mapping.inputId });
    }
  }

  private ensureActiveSource(clientId: string, inputId: string): ActiveSource | null {
    const existing = this.activeSources.get(clientId);
    if (existing?.inputId === inputId) {
      return existing;
    }
    if (existing) {
      this.stopActiveSource(clientId, 'sendspin-replaced');
    }

    const session = sendspinCore.getSessionByClientId(clientId);
    if (!session) {
      return null;
    }
    const format = this.resolveFormat(session.getSourceSupport());
    const stream = new PassThrough({ highWaterMark: 1024 * 64 });
    this.registry.start(inputId, stream, { format: format ?? undefined });
    const active: ActiveSource = { inputId, stream, format: format ?? undefined };
    this.activeSources.set(clientId, active);
    this.log.info('sendspin line-in ingest started', { clientId, inputId, format });
    return active;
  }

  private stopActiveSource(clientId: string, reason: string): void {
    const active = this.activeSources.get(clientId);
    if (!active) return;
    this.registry.stop(active.inputId, reason);
    try {
      active.stream.end();
    } catch {
      /* ignore */
    }
    this.activeSources.delete(clientId);
    this.log.info('sendspin line-in ingest stopped', { clientId, inputId: active.inputId, reason });
  }

  private sendSourceCommand(clientId: string, command: SourceCommand): void {
    this.log.debug('sendspin line-in source command', { clientId, command });
    sendspinCore.sendServerCommand(clientId, { source: { command } });
  }

  private sendSourceControl(clientId: string, command: LineInControlCommand): void {
    const session = sendspinCore.getSessionByClientId(clientId);
    const control = SOURCE_CONTROL_MAP[command];
    const supported = session?.getSourceSupport()?.controls ?? null;
    if (supported && supported.length && !supported.includes(control)) {
      this.log.debug('sendspin line-in control skipped; unsupported by client', {
        clientId,
        command,
        supported,
      });
      return;
    }
    this.log.debug('sendspin line-in source control', { clientId, command });
    sendspinCore.sendServerCommand(clientId, { source: { control } });
  }

  private sendSourceSettings(clientId: string, inputId: string, command?: SourceCommand): boolean {
    const settings = this.resolveSourceSettings(inputId);
    if (!settings) {
      this.log.debug('sendspin line-in source settings skipped', { clientId, inputId });
      return false;
    }
    if (!command) {
      this.log.debug('sendspin line-in source settings skipped; command missing', { clientId, inputId });
      return false;
    }
    this.log.debug('sendspin line-in source settings', { clientId, inputId, command, ...settings });
    sendspinCore.sendServerCommand(clientId, { source: { command, ...settings } } as any);
    return true;
  }

  private resolveMappings(): SendspinLineInMapping[] {
    const entries = this.resolveLineInInputs();
    const seen = new Set<string>();
    const mappings: SendspinLineInMapping[] = [];
    for (const entry of entries) {
      const source = entry.record?.source && typeof entry.record.source === 'object'
        ? (entry.record.source as Record<string, unknown>)
        : null;
      if (!source || String(source.type ?? '').toLowerCase() !== 'sendspin') {
        continue;
      }
      const clientId = this.resolveClientId(source);
      if (!clientId) {
        continue;
      }
      if (seen.has(clientId)) {
        this.log.warn('sendspin line-in client used by multiple inputs; ignoring duplicate', { clientId });
        continue;
      }
      mappings.push({ inputId: entry.id, clientId });
      seen.add(clientId);
    }
    return mappings;
  }

  private resolveLineInInputs(): Array<{ id: string; name: string; record: LineInInputConfig }> {
    const config = this.getConfigPort().getConfig();
    const entries = Array.isArray(config.inputs?.lineIn?.inputs)
      ? config.inputs!.lineIn!.inputs!
      : [];
    const macId = (config.system?.audioserver?.macId ?? '').trim().toUpperCase() || 'UNKNOWN';
    return entries.map((entry, index) => {
      const record = entry && typeof entry === 'object' ? (entry as LineInInputConfig) : {};
      const id = typeof record.id === 'string' && record.id.trim()
        ? record.id.trim()
        : `${macId}#${LINEIN_ID_START + index}`;
      const name = typeof record.name === 'string' && record.name.trim()
        ? record.name.trim()
        : `${DEFAULT_LINEIN_NAME}${index + 1}`;
      return { id, name, record };
    });
  }

  private resolveLineInInputConfig(inputId: string): LineInInputConfig | null {
    const match = this.resolveLineInInputs().find((entry) => entry.id === inputId);
    return match?.record ?? null;
  }

  private resolveSourceSettings(
    inputId: string,
  ): {
    vad?: { threshold_db?: number; hold_ms?: number };
    format?: { codec?: string; channels?: number; sample_rate?: number; bit_depth?: number };
  } | null {
    const entry = this.resolveLineInInputConfig(inputId);
    if (!entry) return null;
    const source = entry.source && typeof entry.source === 'object' ? (entry.source as Record<string, unknown>) : {};

    const parseNumeric = (value: unknown): number | null => {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value.trim());
        return Number.isFinite(parsed) ? parsed : null;
      }
      return null;
    };

    const threshold = parseNumeric(source.vad_threshold_db);
    const hold = parseNumeric(source.vad_hold_ms);
    const vad =
      threshold != null || hold != null
        ? { ...(threshold != null ? { threshold_db: threshold } : {}), ...(hold != null ? { hold_ms: hold } : {}) }
        : null;

    const sampleRate = parseNumeric(source.sample_rate ?? source.ingest_sample_rate ?? source.rate ?? source.sampleRate);
    const channels = parseNumeric(source.channels ?? source.ingest_channels);
    const bitDepth = parseNumeric(source.bit_depth ?? source.ingest_bit_depth);
    const codec =
      typeof source.codec === 'string' && source.codec.trim()
        ? source.codec.trim()
        : typeof source.ingest_codec === 'string' && source.ingest_codec.trim()
          ? source.ingest_codec.trim()
          : null;
    const format =
      sampleRate != null || channels != null || bitDepth != null || codec
        ? {
          ...(codec ? { codec } : {}),
          ...(channels != null && channels > 0 ? { channels: Math.round(channels) } : {}),
          ...(sampleRate != null && sampleRate > 0 ? { sample_rate: Math.round(sampleRate) } : {}),
          ...(bitDepth != null && bitDepth > 0 ? { bit_depth: Math.round(bitDepth) } : {}),
        }
        : null;

    if (!vad && !format) return null;
    return { ...(vad ? { vad } : {}), ...(format ? { format } : {}) };
  }

  private resolveClientId(source: Record<string, unknown>): string | null {
    const raw =
      (typeof source.clientId === 'string' && source.clientId.trim())
        || (typeof source.client_id === 'string' && source.client_id.trim())
        || '';
    return raw ? raw.trim() : null;
  }

  private findMappingByInput(inputId: string): SendspinLineInMapping | null {
    for (const mapping of this.mappings.values()) {
      if (mapping.inputId === inputId) {
        return mapping;
      }
    }
    return null;
  }

  private resolveFormat(
    support: {
      format: { codec?: string; sample_rate: number; channels: number; bit_depth: number };
    } | null,
  ):
    | LineInIngestFormat
    | null {
    if (!support?.format) return null;
    if (String(support.format.codec ?? '').toLowerCase() && String(support.format.codec).toLowerCase() !== 'pcm') {
      this.log.warn('sendspin line-in codec not supported; expected pcm', {
        codec: support.format.codec,
      });
      return null;
    }
    const sampleRate = Number(support.format.sample_rate);
    const channels = Number(support.format.channels);
    const bitDepth = Number(support.format.bit_depth);
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) return null;
    if (!Number.isFinite(channels) || channels <= 0) return null;
    if (!Number.isFinite(bitDepth) || bitDepth <= 0) return null;
    if (![16, 24, 32].includes(bitDepth)) return null;
    const pcmFormat = pcmFormatFromBitDepth(bitDepth as 16 | 24 | 32) as LineInIngestFormat['pcmFormat'];
    return { sampleRate, channels, bitDepth, pcmFormat };
  }
}
