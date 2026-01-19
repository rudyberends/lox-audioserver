import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { recognizeBytes, type DecodedSignature } from 'shazamio-core';
import ffmpegPath from 'ffmpeg-static';
import { createLogger } from '@/core/logging/logger';
import { lineInIngestRegistry } from '@/modules/audio/inputs/linein/lineInIngestRegistry';
import { resolveLineInSampleRate } from '@/modules/audio/inputs/linein/lineInConstants';
import { zoneManager } from '@/modules/zones/zoneManager';
import { buildWavHeader } from '@/modules/audio/utils/audioFormat';
import { getConfig } from '@/domain/config/configStore';
import type { LineInInputConfig } from '@/domain/config/types';

type LineInMetadata = {
  title?: string;
  artist?: string;
  album?: string;
  coverurl?: string;
};

type CaptureState = {
  stop: () => void;
};

const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const ACOUSTID_ENDPOINT = 'https://api.acoustid.org/v2/lookup';
const SHAZAM_BASE_URL = 'https://amp.shazam.com/discovery/v5';
const LINEIN_ID_START = 1000001;
const execFileAsync = promisify(execFile);

class LineInMetadataService {
  private readonly log = createLogger('Audio', 'LineInMetadata');
  private readonly activeCaptures = new Map<string, CaptureState>();
  private readonly lastLookup = new Map<string, number>();
  private readonly pollTimers = new Map<string, NodeJS.Timeout>();
  private stopListeners: Array<() => void> = [];
  private readonly apiKey = '4Ed6WmQ8oG';
  private fpcalcAvailable: boolean | null = null;

  public start(): void {
    if (this.stopListeners.length) {
      return;
    }
    const config = getConfig();
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
    const stop = lineInIngestRegistry.onAnyStart((session) => {
      void this.handleStart(session.id, session.stream);
    });
    this.stopListeners.push(stop);
    for (const session of lineInIngestRegistry.getActiveSessions()) {
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
    const override = (process.env.LINEIN_METADATA_ENABLED ?? '').trim().toLowerCase();
    if (override === '1' || override === 'true' || override === 'yes') {
      return true;
    }
    const disable = (process.env.LINEIN_METADATA_DISABLED ?? '').trim().toLowerCase();
    if (disable === '1' || disable === 'true' || disable === 'yes') {
      return false;
    }
    const config = getConfig();
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
    const stream = lineInIngestRegistry.getStream(inputId);
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
    const sampleRate = this.resolveSampleRate(inputId);
    const targetBytes = sampleRate * CHANNELS * BYTES_PER_SAMPLE * targetSeconds;
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
        const meta = await this.lookupMetadata(inputId, pcm, targetSeconds);
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
    inputId: string,
    pcm: Buffer,
    durationSeconds: number,
  ): Promise<LineInMetadata | null> {
    if (!this.ensureFpcalcAvailable()) {
      return null;
    }
    const key = (process.env.LINEIN_ACOUSTID_API_KEY ?? this.apiKey).trim();
    if (!key) {
      return null;
    }
    const filePath = await this.writeWav(inputId, pcm);
    const keepWav = this.shouldKeepWav();
    try {
      const fingerprint = await this.runFpcalc(filePath, durationSeconds);
      if (!fingerprint) {
        return null;
      }
      if (this.isShazamEnabled()) {
        this.log.info('line-in shazam lookup started', { seconds: durationSeconds });
        const shazam = await this.lookupShazam(filePath);
        if (shazam) {
          return shazam;
        }
      }
      if (!this.isAcoustidEnabled()) {
        return null;
      }
      this.log.info('line-in acoustid lookup started', { seconds: durationSeconds });
      const results = await this.queryAcoustid(key, fingerprint);
      const best = results[0]?.recordings?.[0];
      if (!best) {
        this.log.info('line-in acoustid lookup returned no match');
        return null;
      }
      const meta = {
        title: best.title,
        artist: best.artists?.[0]?.name,
        album: best.releasegroups?.[0]?.title ?? best.releases?.[0]?.title,
      };
      return meta;
    } finally {
      if (keepWav) {
        this.log.info('line-in metadata wav preserved', { filePath });
      } else {
        await fs.unlink(filePath).catch(() => undefined);
      }
    }
  }

  private async writeWav(inputId: string, pcm: Buffer): Promise<string> {
    const filePath = path.join(os.tmpdir(), `linein-${randomUUID()}.wav`);
    const header = buildWavHeader({
      sampleRate: this.resolveSampleRate(inputId),
      channels: CHANNELS,
      bitDepth: BYTES_PER_SAMPLE * 8,
    });
    await fs.writeFile(filePath, Buffer.concat([header, pcm]));
    return filePath;
  }

  private async runFpcalc(
    filePath: string,
    durationSeconds: number,
  ): Promise<{ duration: number; fingerprint: string } | null> {
    try {
      const { stdout } = await execFileAsync('fpcalc', [
        '-length',
        String(durationSeconds),
        filePath,
      ]);
      let duration = 0;
      let fingerprint = '';
      for (const line of stdout.split('\n')) {
        if (line.startsWith('DURATION=')) {
          duration = Number(line.slice('DURATION='.length).trim());
        } else if (line.startsWith('FINGERPRINT=')) {
          fingerprint = line.slice('FINGERPRINT='.length).trim();
        }
      }
      if (!Number.isFinite(duration) || duration <= 0 || !fingerprint) {
        this.log.warn('line-in metadata fpcalc output invalid', { duration, fingerprint });
        return null;
      }
      return { duration, fingerprint };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('line-in metadata fpcalc failed', { message });
      return null;
    }
  }

  private async queryAcoustid(
    key: string,
    fingerprint: { duration: number; fingerprint: string },
  ): Promise<any[]> {
    const params = new URLSearchParams({
      client: key,
      meta: 'recordings releases releasegroups tracks usermeta sources',
      duration: String(fingerprint.duration),
      fingerprint: fingerprint.fingerprint,
    });
    const response = await this.fetchWithTimeout(
      ACOUSTID_ENDPOINT,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      },
      this.getLookupTimeoutMs(),
    );
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`acoustid lookup failed (${response.status}): ${text}`);
    }
    const json = (await response.json()) as { status?: string; results?: any[] };
    if (json.status !== 'ok') {
      return [];
    }
    return Array.isArray(json.results) ? json.results : [];
  }

  private async lookupShazam(filePath: string): Promise<LineInMetadata | null> {
    const shazamPath = await this.buildShazamWav(filePath);
    if (!shazamPath) {
      return null;
    }
    let signatures: DecodedSignature[] = [];
    try {
      const bytes = await fs.readFile(shazamPath);
      signatures = recognizeBytes(bytes, 0, Number.MAX_SAFE_INTEGER);
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
          const text = await response.text().catch(() => '');
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
      await fs.unlink(shazamPath).catch(() => undefined);
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

  private async buildShazamWav(filePath: string): Promise<string | null> {
    const outPath = path.join(os.tmpdir(), `linein-shazam-${randomUUID()}.wav`);
    if (!ffmpegPath) {
      this.log.warn('line-in shazam resample failed; ffmpeg not available');
      return null;
    }
    try {
      await execFileAsync(ffmpegPath, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        filePath,
        '-ac',
        '1',
        '-ar',
        '16000',
        '-f',
        'wav',
        outPath,
      ]);
      return outPath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('line-in shazam resample failed', { message });
      await fs.unlink(outPath).catch(() => undefined);
      return null;
    }
  }

  private applyMetadata(inputId: string, metadata: LineInMetadata): void {
    if (!metadata.title && !metadata.artist && !metadata.album && !metadata.coverurl) {
      return;
    }
    const configZones = getConfig()?.zones ?? [];
    for (const zone of configZones) {
      const state = zoneManager.getZoneState(zone.id);
      if (!state) continue;
      const currentPath = state.audiopath ?? '';
      const matches =
        currentPath === `linein:${inputId}` || currentPath === `linein://${inputId}`;
      if (!matches) {
        continue;
      }
      zoneManager.updateInputMetadata(zone.id, {
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
    const config = getConfig();
    const inputs = Array.isArray(config.inputs?.lineIn?.inputs)
      ? config.inputs!.lineIn!.inputs!
      : [];
    if (!inputs.length) {
      return true;
    }
    const match = resolveLineInInputConfig(inputId, inputs);
    if (!match) {
      return true;
    }
    if (typeof match.metadataEnabled === 'boolean') {
      return match.metadataEnabled;
    }
    return true;
  }

  private resolveSampleRate(inputId: string): number {
    const config = getConfig();
    const inputs = Array.isArray(config.inputs?.lineIn?.inputs)
      ? config.inputs!.lineIn!.inputs!
      : [];
    const entry = resolveLineInInputConfig(inputId, inputs);
    return resolveLineInSampleRate(entry);
  }

  private getCaptureSeconds(): number {
    const raw = Number(process.env.LINEIN_ACOUSTID_SECONDS ?? '5');
    if (!Number.isFinite(raw) || raw <= 0) {
      return 5;
    }
    return Math.min(60, Math.max(5, Math.round(raw)));
  }

  private getCooldownMs(): number {
    const raw =
      Number(process.env.LINEIN_METADATA_INTERVAL_MS) ||
      Number(process.env.LINEIN_ACOUSTID_COOLDOWN_MS ?? '25000');
    if (!Number.isFinite(raw) || raw <= 0) {
      return 25000;
    }
    return Math.max(10_000, Math.round(raw));
  }

  private scheduleNextCheck(inputId: string): void {
    if (this.pollTimers.has(inputId)) {
      return;
    }
    const delayMs = this.getPollIntervalMs();
    const timer = setTimeout(() => {
      this.pollTimers.delete(inputId);
      const stream = lineInIngestRegistry.getStream(inputId);
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
    const raw =
      Number(process.env.LINEIN_METADATA_INTERVAL_MS) ||
      Number(process.env.LINEIN_ACOUSTID_RETRY_MS ?? '25000');
    if (!Number.isFinite(raw) || raw <= 0) {
      return 25000;
    }
    return Math.min(300_000, Math.max(10_000, Math.round(raw)));
  }

  private getShazamLocale(): string {
    const raw = (process.env.LINEIN_SHAZAM_LANGUAGE ?? 'en-US').trim();
    return raw || 'en-US';
  }

  private getShazamUrlLanguage(locale: string): string {
    const language = locale.split('-')[0]?.trim().toLowerCase();
    return language || 'en';
  }

  private getShazamCountry(locale: string): string {
    const raw = (process.env.LINEIN_SHAZAM_COUNTRY ?? '').trim().toUpperCase();
    if (raw) {
      return raw;
    }
    const region = locale.split('-')[1]?.trim().toUpperCase();
    return region || 'US';
  }

  private getLookupTimeoutMs(): number {
    const raw = Number(process.env.LINEIN_METADATA_TIMEOUT_MS ?? '15000');
    if (!Number.isFinite(raw) || raw <= 0) {
      return 15000;
    }
    return Math.min(60000, Math.max(5000, Math.round(raw)));
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
    const raw = (process.env.LINEIN_SHAZAM_ENABLED ?? 'true').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes';
  }

  private isAcoustidEnabled(): boolean {
    const raw = (process.env.LINEIN_ACOUSTID_ENABLED ?? 'false').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes';
  }

  private shouldKeepWav(): boolean {
    const raw = (process.env.LINEIN_ACOUSTID_KEEP_WAV ?? '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes';
  }

  private ensureFpcalcAvailable(): boolean {
    if (this.fpcalcAvailable != null) {
      return this.fpcalcAvailable;
    }
    const result = spawnSync('fpcalc', ['-h'], { stdio: 'ignore' });
    const available = !result.error && result.status === 0;
    this.fpcalcAvailable = available;
    if (!available) {
      this.log.warn('fpcalc not found; line-in metadata disabled');
    }
    return available;
  }
}

export const lineInMetadataService = new LineInMetadataService();

function resolveLineInInputConfig(
  inputId: string,
  inputs: LineInInputConfig[],
): LineInInputConfig | null {
  const normalized = inputId.trim();
  if (!normalized) {
    return null;
  }
  const config = getConfig();
  const macId = config.system?.audioserver?.macId?.trim().toUpperCase() || 'UNKNOWN';
  for (let index = 0; index < inputs.length; index += 1) {
    const entry = (inputs[index] ?? {}) as LineInInputConfig;
    const resolvedId =
      typeof entry.id === 'string' && entry.id.trim()
        ? entry.id.trim()
        : `${macId}#${LINEIN_ID_START + index}`;
    if (resolvedId === normalized) {
      return entry;
    }
  }
  return null;
}
