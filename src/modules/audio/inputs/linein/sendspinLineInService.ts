import { PassThrough } from 'node:stream';
import { createLogger } from '@/core/logging/logger';
import { getConfig } from '@/domain/config/configStore';
import type { LineInInputConfig } from '@/domain/config/types';
import { lineInIngestRegistry, type LineInIngestFormat } from '@/modules/audio/inputs/linein/lineInIngestRegistry';
import { pcmFormatFromBitDepth } from '@/modules/audio/utils/audioFormat';
import { sendspinCore, SourceCommand } from '@lox-audioserver/node-sendspin';

type SendspinLineInMapping = {
  inputId: string;
  clientId: string;
};

type ActiveSource = {
  inputId: string;
  stream: PassThrough;
  format?: LineInIngestFormat;
};

const LINEIN_ID_START = 1000001;
const DEFAULT_LINEIN_NAME = 'LineIn';

class SendspinLineInService {
  private readonly log = createLogger('Audio', 'SendspinLineIn');
  private readonly mappings = new Map<string, SendspinLineInMapping>();
  private readonly activeSources = new Map<string, ActiveSource>();
  private readonly lastAudioLog = new Map<string, number>();
  private started = false;

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.refresh();
  }

  public stop(): void {
    this.started = false;
    for (const clientId of this.mappings.keys()) {
      sendspinCore.unregisterHooks(clientId);
    }
    this.mappings.clear();
    for (const [clientId, active] of this.activeSources.entries()) {
      lineInIngestRegistry.stop(active.inputId, 'sendspin-disconnected');
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
    }

    for (const clientId of this.mappings.keys()) {
      if (!seen.has(clientId)) {
        this.mappings.delete(clientId);
        sendspinCore.unregisterHooks(clientId);
        this.stopActiveSource(clientId, 'sendspin-unmapped');
      }
    }
  }

  public requestStart(inputId: string): void {
    const mapping = this.findMappingByInput(inputId);
    if (!mapping) return;
    this.sendSourceCommand(mapping.clientId, SourceCommand.START);
  }

  public requestStop(inputId: string): void {
    const mapping = this.findMappingByInput(inputId);
    if (!mapping) return;
    this.sendSourceCommand(mapping.clientId, SourceCommand.STOP);
  }

  private registerHooks(clientId: string): void {
    sendspinCore.registerHooks(clientId, {
      onSourceAudio: (_session, chunk) => {
        this.handleSourceAudio(clientId, chunk.data);
      },
      onSourceState: (_session, state) => {
        if (state.state && state.state !== 'streaming') {
          this.stopActiveSource(clientId, `sendspin-${state.state}`);
        }
      },
      onDisconnected: () => {
        this.stopActiveSource(clientId, 'sendspin-disconnected');
      },
    });
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
    lineInIngestRegistry.start(inputId, stream, { format: format ?? undefined });
    const active: ActiveSource = { inputId, stream, format: format ?? undefined };
    this.activeSources.set(clientId, active);
    this.log.info('sendspin line-in ingest started', { clientId, inputId, format });
    return active;
  }

  private stopActiveSource(clientId: string, reason: string): void {
    const active = this.activeSources.get(clientId);
    if (!active) return;
    lineInIngestRegistry.stop(active.inputId, reason);
    try {
      active.stream.end();
    } catch {
      /* ignore */
    }
    this.activeSources.delete(clientId);
    this.log.info('sendspin line-in ingest stopped', { clientId, inputId: active.inputId, reason });
  }

  private sendSourceCommand(clientId: string, command: SourceCommand): void {
    sendspinCore.sendServerCommand(clientId, { source: { command } });
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
    const config = getConfig();
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

export const sendspinLineInService = new SendspinLineInService();
