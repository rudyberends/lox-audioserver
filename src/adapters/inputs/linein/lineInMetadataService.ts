import { randomUUID } from 'node:crypto';
import { recognizeBytes, type DecodedSignature } from 'shazamio-core';
import { createLogger } from '@/shared/logging/logger';
import { safeReadText } from '@/shared/bestEffort';
import type { LineInIngestRegistry } from '@/adapters/inputs/linein/lineInIngestRegistry';
import { resolveLineInSampleRate } from '@/adapters/inputs/linein/lineInConstants';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import { buildWavHeader } from '@/ports/types/audioFormat';
import type { LineInInputConfig } from '@/domain/config/types';
import type { ConfigPort } from '@/ports/ConfigPort';

type LineInMetadata = {
  title?: string;
  artist?: string;
  album?: string;
  coverurl?: string;
};

type CaptureState = {
  stop: () => void;
};

type CaptureFormat = {
  sampleRate: number;
  channels: number;
  bitDepth: number;
};

const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const SHAZAM_SAMPLE_RATE = 16000;
const SHAZAM_CHANNELS = 1;
const SHAZAM_BIT_DEPTH = 16;
const SHAZAM_BASE_URL = 'https://amp.shazam.com/discovery/v5';
const LINEIN_ID_START = 1000001;
const DEFAULT_CAPTURE_SECONDS = 5;
const DEFAULT_COOLDOWN_MS = 25000;
const DEFAULT_POLL_INTERVAL_MS = 25000;
const DEFAULT_SHAZAM_LOCALE = 'en-US';
const DEFAULT_LOOKUP_TIMEOUT_MS = 15000;
export class LineInMetadataService {
  private readonly log = createLogger('Audio', 'LineInMetadata');
  private readonly registry: LineInIngestRegistry;
  private readonly activeCaptures = new Map<string, CaptureState>();
  private readonly lastLookup = new Map<string, number>();
  private readonly pollTimers = new Map<string, NodeJS.Timeout>();
  private stopListeners: Array<() => void> = [];
  private zoneManager: ZoneManagerFacade | null = null;
  private configPort: ConfigPort | null = null;

  constructor(registry: LineInIngestRegistry) {
    this.registry = registry;
  }

  public initOnce(deps: { zoneManager: ZoneManagerFacade; configPort: ConfigPort }): void {
    if (this.zoneManager || this.configPort) {
      throw new Error('line-in metadata service already initialized');
    }
    if (!deps.zoneManager || !deps.configPort) {
      throw new Error('line-in metadata service missing dependencies');
    }
    this.zoneManager = deps.zoneManager;
    this.configPort = deps.configPort;
  }

  private get zones(): ZoneManagerFacade {
    if (!this.zoneManager) {
      throw new Error('zone manager not configured');
    }
    return this.zoneManager;
  }

  private get config(): ConfigPort {
    if (!this.configPort) {
      throw new Error('config port not configured');
    }
    return this.configPort;
  }

  public start(): void {
    if (this.stopListeners.length) {
      return;
    }
    const config = this.config.getConfig();
    const inputs = Array.isArray(config.inputs?.lineIn?.inputs)
      ? config.inputs!.lineIn!.inputs!
      : [];
    const enabledInputs = inputs.filter((entry) => entry?.metadataEnabled !== false);
    const enabled = this.isEnabled();
    this.log.info('line-in metadata init', {
      enabled,
      inputs: inputs.length,
      enabledInputs: enabledInputs.length,
    });
    if (!enabled) {
      return;
    }
    const stop = this.registry.onAnyStart((session) => {
      void this.handleStart(session.id, session.stream);
    });
    this.stopListeners.push(stop);
    for (const session of this.registry.getActiveSessions()) {
      void this.handleStart(session.id, session.stream);
    }
    this.log.info('line-in metadata enabled');
  }

  public stop(): void {
    this.stopListeners.forEach((stop) => stop());
    this.stopListeners = [];
    this.activeCaptures.clear();
    this.lastLookup.clear();
    for (const timer of this.pollTimers.values()) {
      clearTimeout(timer);
    }
    this.pollTimers.clear();
  }

  private isEnabled(): boolean {
    const config = this.config.getConfig();
    const inputs = Array.isArray(config.inputs?.lineIn?.inputs)
      ? config.inputs!.lineIn!.inputs!
      : [];
    if (!inputs.length) {
      return true;
    }
    return inputs.some((entry) => entry?.metadataEnabled !== false);
  }

  private async handleStart(inputId: string, stream: NodeJS.ReadableStream): Promise<void> {
    this.clearPoll(inputId);
    if (!this.isMetadataEnabledForInput(inputId)) {
      this.log.info('line-in metadata disabled for input', { inputId });
      return;
    }
    if (this.activeCaptures.has(inputId)) {
      return;
    }
    const cooldown = this.getCooldownMs();
    const last = this.lastLookup.get(inputId) ?? 0;
    if (Date.now() - last < cooldown) {
      this.scheduleNextCheck(inputId);
      return;
    }
    this.log.info('line-in metadata capture starting', { inputId });
    const capture = this.captureSnippet(inputId, stream);
    this.activeCaptures.set(inputId, capture);
  }

  public handleTrackChange(inputId: string): void {
    if (!this.isMetadataEnabledForInput(inputId)) {
      return;
    }
    if (this.activeCaptures.has(inputId)) {
      return;
    }
    const stream = this.registry.getStream(inputId);
    if (!stream) {
      this.log.info('line-in metadata track change ignored; no stream', { inputId });
      return;
    }
    this.clearPoll(inputId);
    this.log.info('line-in metadata track change capture', { inputId });
    const capture = this.captureSnippet(inputId, stream);
    this.activeCaptures.set(inputId, capture);
  }

  private captureSnippet(
    inputId: string,
    stream: NodeJS.ReadableStream,
    targetSeconds = this.getCaptureSeconds(),
    allowRetry = true,
  ): CaptureState {
    const format = this.resolveIngestFormat(inputId);
    const bytesPerSample = Math.max(1, Math.floor(format.bitDepth / 8));
    const targetBytes = format.sampleRate * format.channels * bytesPerSample * targetSeconds;
    const buffers: Buffer[] = [];
    let bytes = 0;
    let finished = false;
    const timeoutMs = targetSeconds * 1000 + 2000;
    const timeout = setTimeout(() => {
      void finish('timeout');
    }, timeoutMs);

    const finish = async (reason?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      stream.off('data', onData);
      this.activeCaptures.delete(inputId);
      if (bytes <= 0) {
        this.log.info('line-in metadata capture empty', { inputId, reason: reason ?? 'empty' });
        this.scheduleNextCheck(inputId);
        return;
      }
      if (bytes < targetBytes) {
        this.log.info('line-in metadata capture incomplete', {
          inputId,
          bytes,
          targetBytes,
          reason: reason ?? 'short',
        });
        this.scheduleNextCheck(inputId);
        return;
      }
      const pcm = Buffer.concat(buffers, bytes);
      this.log.info('line-in metadata capture complete', {
        inputId,
        bytes,
        targetBytes,
      });
      try {
        this.log.info('line-in metadata lookup started', {
          inputId,
          seconds: targetSeconds,
          bytes,
        });
        const meta = await this.lookupMetadata(pcm, targetSeconds, format);
        if (meta) {
          this.applyMetadata(inputId, meta);
        } else {
          this.log.info('line-in metadata lookup returned no match', { inputId });
          if (allowRetry && targetSeconds <= 5) {
            this.log.info('line-in metadata retrying with longer capture', {
              inputId,
              seconds: 10,
            });
            const retry = this.captureSnippet(inputId, stream, 10, false);
            this.activeCaptures.set(inputId, retry);
            return;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn('line-in metadata lookup failed', { inputId, message });
      } finally {
        this.scheduleNextCheck(inputId);
      }
    };

    const onData = (chunk: Buffer) => {
      if (!chunk?.length || finished) return;
      const remaining = targetBytes - bytes;
      const slice = remaining > 0 ? chunk.slice(0, remaining) : Buffer.alloc(0);
      if (slice.length) {
        buffers.push(slice);
        bytes += slice.length;
      }
      if (bytes >= targetBytes) {
        void finish('complete');
      }
    };

    stream.on('data', onData);

    return { stop: () => void finish() };
  }

  private async lookupMetadata(
    pcm: Buffer,
    durationSeconds: number,
    format: CaptureFormat,
  ): Promise<LineInMetadata | null> {
    const wavBytes = this.buildShazamWavBytes(pcm, format);
    if (!wavBytes) {
      return null;
    }
    if (this.isShazamEnabled()) {
      this.log.info('line-in shazam lookup started', { seconds: durationSeconds });
      const shazam = await this.lookupShazam(wavBytes);
      if (shazam) {
        return shazam;
      }
    }
    return null;
  }


  private async lookupShazam(wavBytes: Buffer): Promise<LineInMetadata | null> {
    let signatures: DecodedSignature[] = [];
    try {
      signatures = recognizeBytes(wavBytes, 0, Number.MAX_SAFE_INTEGER);
      if (!signatures.length) {
        this.log.info('line-in shazam signature empty', { count: 0 });
        return null;
      }
      const locale = this.getShazamLocale();
      const language = this.getShazamUrlLanguage(locale);
      const country = this.getShazamCountry(locale);
      const timezone = this.getTimezone();
      let lastMatches = 0;
      for (let i = Math.floor(signatures.length / 2); i < signatures.length; i += 4) {
        const signature = signatures[i];
        if (!signature) {
          continue;
        }
        const payload = {
          timezone,
          signature: { uri: signature.uri, samplems: signature.samplems },
          timestamp: Date.now(),
          context: {},
          geolocation: {},
        };
        const response = await this.fetchWithTimeout(
          this.buildShazamUrl(language, country, this.pickShazamDevice()),
          {
            method: 'POST',
            headers: this.buildShazamHeaders(locale),
            body: JSON.stringify(payload),
          },
          this.getLookupTimeoutMs(),
        );
        if (!response.ok) {
          const text = await safeReadText(response, '', {
            onError: 'debug',
            log: this.log,
            label: 'line-in metadata track read failed',
            context: { status: response.status },
          });
          throw new Error(`shazam lookup failed (${response.status}): ${text}`);
        }
        const json = (await response.json()) as any;
        lastMatches = Array.isArray(json?.matches) ? json.matches.length : 0;
        if (!lastMatches) {
          continue;
        }
        const track = json?.track;
        if (!track) {
          continue;
        }
        this.log.info('line-in shazam lookup matched', {
          title: track.title ?? '',
          artist: track.subtitle ?? '',
        });
        return {
          title: track.title ?? undefined,
          artist: track.subtitle ?? undefined,
          album: this.extractShazamAlbum(track),
          coverurl: this.extractShazamCover(track),
        };
      }
      this.log.info('line-in shazam lookup returned no match', {
        matches: lastMatches,
        signatures: signatures.length,
      });
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('line-in shazam lookup failed', { message });
      return null;
    } finally {
      for (const sig of signatures) {
        try {
          sig.free();
        } catch {
          /* ignore */
        }
      }
    }
  }

  private buildShazamUrl(language: string, country: string, device: string): string {
    const url = new URL(
      `${SHAZAM_BASE_URL}/${language}/${country}/${device}/-/tag/${randomUUID().toUpperCase()}/${randomUUID().toUpperCase()}`,
    );
    url.searchParams.set('sync', 'true');
    url.searchParams.set('webv3', 'true');
    url.searchParams.set('sampling', 'true');
    url.searchParams.set('connected', '');
    url.searchParams.set('shazamapiversion', 'v3');
    url.searchParams.set('sharehub', 'true');
    url.searchParams.set('hubv5minorversion', 'v5.1');
    url.searchParams.set('hidelb', 'true');
    url.searchParams.set('video', 'v3');
    return url.toString();
  }

  private buildShazamHeaders(language: string): Record<string, string> {
    return {
      'X-Shazam-Platform': 'IPHONE',
      'X-Shazam-AppVersion': '14.1.0',
      Accept: '*/*',
      'Accept-Language': language,
      'Accept-Encoding': 'gzip, deflate',
      'User-Agent': this.pickShazamUserAgent(),
      'Content-Type': 'application/json',
    };
  }

  private getTimezone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }

  private pickShazamDevice(): string {
    const devices = ['iphone', 'android', 'web'];
    return devices[Math.floor(Math.random() * devices.length)] ?? 'iphone';
  }

  private pickShazamUserAgent(): string {
    const agents = [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      'Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ];
    return agents[Math.floor(Math.random() * agents.length)] ?? agents[0]!;
  }

  private extractShazamAlbum(track: any): string | undefined {
    const sections = Array.isArray(track?.sections) ? track.sections : [];
    for (const section of sections) {
      if (section?.type !== 'SONG') {
        continue;
      }
      const metadata = Array.isArray(section?.metadata) ? section.metadata : [];
      const album = metadata.find((entry: { title?: string; text?: string }) => entry?.title === 'Album')?.text;
      if (album) {
        return album;
      }
    }
    return undefined;
  }

  private extractShazamCover(track: any): string | undefined {
    const images = track?.images;
    if (images?.coverarthq) {
      return images.coverarthq;
    }
    if (images?.coverart) {
      return images.coverart;
    }
    return undefined;
  }

  private buildShazamWavBytes(pcm: Buffer, format: CaptureFormat): Buffer | null {
    if (!pcm?.length) {
      return null;
    }
    const samples = this.decodePcmToFloat32(pcm, format.bitDepth);
    if (!samples) {
      return null;
    }
    const mono = this.downmixToMono(samples, format.channels);
    const resampled = this.resampleLinear(mono, format.sampleRate, SHAZAM_SAMPLE_RATE);
    if (!resampled.length) {
      return null;
    }
    const encoded = this.encodeFloat32ToInt16(resampled);
    return this.buildWavBytes(encoded, SHAZAM_SAMPLE_RATE, SHAZAM_CHANNELS, SHAZAM_BIT_DEPTH);
  }

  private decodePcmToFloat32(pcm: Buffer, bitDepth: number): Float32Array | null {
    const bytesPerSample = Math.max(1, Math.floor(bitDepth / 8));
    const sampleCount = Math.floor(pcm.length / bytesPerSample);
    if (sampleCount <= 0) {
      return null;
    }
    const output = new Float32Array(sampleCount);
    switch (bitDepth) {
      case 16: {
        for (let i = 0; i < sampleCount; i += 1) {
          const offset = i * 2;
          output[i] = pcm.readInt16LE(offset) / 32768;
        }
        return output;
      }
      case 24: {
        for (let i = 0; i < sampleCount; i += 1) {
          const offset = i * 3;
          output[i] = pcm.readIntLE(offset, 3) / 8388608;
        }
        return output;
      }
      case 32: {
        for (let i = 0; i < sampleCount; i += 1) {
          const offset = i * 4;
          output[i] = pcm.readInt32LE(offset) / 2147483648;
        }
        return output;
      }
      default: {
        this.log.warn('line-in metadata unsupported bit depth', { bitDepth });
        return null;
      }
    }
  }

  private downmixToMono(samples: Float32Array, channels: number): Float32Array {
    if (channels <= 1) {
      return samples;
    }
    const frameCount = Math.floor(samples.length / channels);
    const mono = new Float32Array(frameCount);
    let offset = 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      let sum = 0;
      for (let ch = 0; ch < channels; ch += 1) {
        sum += samples[offset] ?? 0;
        offset += 1;
      }
      mono[frame] = sum / channels;
    }
    return mono;
  }

  // Linear resample is enough for fingerprinting and avoids spawning ffmpeg.
  private resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
    if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) {
      return samples;
    }
    if (fromRate === toRate) {
      return samples;
    }
    const ratio = fromRate / toRate;
    const outLength = Math.max(1, Math.floor(samples.length / ratio));
    const output = new Float32Array(outLength);
    for (let i = 0; i < outLength; i += 1) {
      const position = i * ratio;
      const left = Math.floor(position);
      const right = Math.min(left + 1, samples.length - 1);
      const fraction = position - left;
      const leftSample = samples[left] ?? 0;
      const rightSample = samples[right] ?? leftSample;
      output[i] = leftSample + (rightSample - leftSample) * fraction;
    }
    return output;
  }

  private encodeFloat32ToInt16(samples: Float32Array): Buffer {
    const buffer = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i += 1) {
      const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
      buffer.writeInt16LE(Math.round(clamped * 32767), i * 2);
    }
    return buffer;
  }

  private buildWavBytes(pcm: Buffer, sampleRate: number, channels: number, bitDepth: number): Buffer {
    const header = buildWavHeader({ sampleRate, channels, bitDepth });
    const dataSize = pcm.length;
    header.writeUInt32LE(dataSize, 40);
    header.writeUInt32LE(36 + dataSize, 4);
    return Buffer.concat([header, pcm]);
  }

  private applyMetadata(inputId: string, metadata: LineInMetadata): void {
    if (!metadata.title && !metadata.artist && !metadata.album && !metadata.coverurl) {
      return;
    }
    const configZones = this.config.getConfig().zones ?? [];
    for (const zone of configZones) {
      const state = this.zones.getZoneState(zone.id);
      if (!state) continue;
      const currentPath = state.audiopath ?? '';
      const matches =
        currentPath === `linein:${inputId}` || currentPath === `linein://${inputId}`;
      if (!matches) {
        continue;
      }
      this.zones.updateInputMetadata(zone.id, {
        title: metadata.title ?? undefined,
        artist: metadata.artist ?? undefined,
        album: metadata.album ?? undefined,
        coverurl: metadata.coverurl ?? undefined,
      });
    }
    this.lastLookup.set(inputId, Date.now());
    this.log.info('line-in metadata updated', {
      inputId,
      title: metadata.title ?? '',
      artist: metadata.artist ?? '',
      album: metadata.album ?? '',
      coverurl: metadata.coverurl ?? '',
    });
  }

  private isMetadataEnabledForInput(inputId: string): boolean {
    const config = this.config.getConfig();
    const inputs = Array.isArray(config.inputs?.lineIn?.inputs)
      ? config.inputs!.lineIn!.inputs!
      : [];
    const macId = config.system?.audioserver?.macId?.trim().toUpperCase() || 'UNKNOWN';
    if (!inputs.length) {
      return true;
    }
    const match = resolveLineInInputConfig(inputId, inputs, macId);
    if (!match) {
      return true;
    }
    if (typeof match.metadataEnabled === 'boolean') {
      return match.metadataEnabled;
    }
    return true;
  }

  private resolveSampleRate(inputId: string): number {
    const config = this.config.getConfig();
    const inputs = Array.isArray(config.inputs?.lineIn?.inputs)
      ? config.inputs!.lineIn!.inputs!
      : [];
    const macId = config.system?.audioserver?.macId?.trim().toUpperCase() || 'UNKNOWN';
    const entry = resolveLineInInputConfig(inputId, inputs, macId);
    return resolveLineInSampleRate(entry);
  }

  private resolveIngestFormat(inputId: string): CaptureFormat {
    const session = this.registry.getSession(inputId);
    const sampleRate =
      session?.format?.sampleRate && session.format.sampleRate > 0
        ? session.format.sampleRate
        : this.resolveSampleRate(inputId);
    const channels =
      session?.format?.channels && session.format.channels > 0 ? session.format.channels : CHANNELS;
    const bitDepth =
      session?.format?.bitDepth && session.format.bitDepth > 0
        ? session.format.bitDepth
        : BYTES_PER_SAMPLE * 8;
    return { sampleRate, channels, bitDepth };
  }

  private getCaptureSeconds(): number {
    return DEFAULT_CAPTURE_SECONDS;
  }

  private getCooldownMs(): number {
    return DEFAULT_COOLDOWN_MS;
  }

  private scheduleNextCheck(inputId: string): void {
    if (this.pollTimers.has(inputId)) {
      return;
    }
    const delayMs = this.getPollIntervalMs();
    const timer = setTimeout(() => {
      this.pollTimers.delete(inputId);
      const stream = this.registry.getStream(inputId);
      if (!stream) {
        return;
      }
      void this.handleStart(inputId, stream);
    }, delayMs);
    this.pollTimers.set(inputId, timer);
    this.log.info('line-in metadata next check scheduled', { inputId, delayMs });
  }

  private clearPoll(inputId: string): void {
    const timer = this.pollTimers.get(inputId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.pollTimers.delete(inputId);
  }

  private getPollIntervalMs(): number {
    return DEFAULT_POLL_INTERVAL_MS;
  }

  private getShazamLocale(): string {
    return DEFAULT_SHAZAM_LOCALE;
  }

  private getShazamUrlLanguage(locale: string): string {
    const language = locale.split('-')[0]?.trim().toLowerCase();
    return language || 'en';
  }

  private getShazamCountry(locale: string): string {
    const region = locale.split('-')[1]?.trim().toUpperCase();
    return region || 'US';
  }

  private getLookupTimeoutMs(): number {
    return DEFAULT_LOOKUP_TIMEOUT_MS;
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private isShazamEnabled(): boolean {
    return true;
  }
}


function resolveLineInInputConfig(
  inputId: string,
  inputs: LineInInputConfig[],
  macId: string,
): LineInInputConfig | null {
  const normalized = inputId.trim();
  if (!normalized) {
    return null;
  }
  const normalizedMacId = macId?.trim().toUpperCase() || 'UNKNOWN';
  for (let index = 0; index < inputs.length; index += 1) {
    const entry = (inputs[index] ?? {}) as LineInInputConfig;
    const resolvedId =
      typeof entry.id === 'string' && entry.id.trim()
        ? entry.id.trim()
        : `${normalizedMacId}#${LINEIN_ID_START + index}`;
    if (resolvedId === normalized) {
      return entry;
    }
  }
  return null;
}
