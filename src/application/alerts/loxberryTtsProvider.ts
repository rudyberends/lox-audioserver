import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseFile } from 'music-metadata';
import { connectAsync, type IClientOptions, type MqttClient } from 'mqtt';
import type { AlertMediaResource } from '@/application/alerts/types';
import type { TtsProvider } from '@/application/alerts/ttsProvider';
import type { LoxBerryTtsProviderConfig } from '@/domain/config/types';
import { createLogger } from '@/shared/logging/logger';

const CACHE_DIR = path.resolve(process.cwd(), 'public', 'alerts', 'cache');
const DEFAULT_MQTT_PORT = 1883;
const DEFAULT_MQTTS_PORT = 8883;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_CLIENT_ID = 'lox-audioserver';

type LoxBerryTtsResponse = {
  status?: string;
  message?: string;
  file?: string;
  corr?: string;
  httpinterface?: string;
  httpmp3interface?: string;
  interfaces?: {
    httpinterface?: string;
    httpmp3interface?: string;
  };
  original?: {
    corr?: string;
  };
};

export class LoxBerryTtsProvider implements TtsProvider {
  private readonly log = createLogger('Alerts', 'LoxBerryTts');
  private readonly durationCache = new Map<string, number>();

  constructor(private readonly config: LoxBerryTtsProviderConfig) {}

  public async generate(text: string, language?: string): Promise<AlertMediaResource | undefined> {
    const normalizedText = (text ?? '').trim();
    if (!normalizedText) {
      this.log.warn('missing text for LoxBerry TTS generation');
      return undefined;
    }
    if (this.config.enabled === false || !this.config.host?.trim()) {
      this.log.warn('LoxBerry TTS provider is not configured');
      return undefined;
    }

    try {
      const response = await this.requestTts(normalizedText);
      const downloadUrl = resolveLoxBerryDownloadUrl(response, this.config);
      if (!downloadUrl) {
        throw new Error('LoxBerry TTS response did not contain a downloadable MP3 URL');
      }
      const cached = await this.cacheRemoteAudio(downloadUrl, normalizedText, language);
      return (
        cached ?? {
          title: buildTitle(normalizedText),
          relativePath: downloadUrl,
          url: downloadUrl,
        }
      );
    } catch (err) {
      this.log.error('failed to generate LoxBerry TTS clip', {
        provider: this.config.type,
        message: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  private async requestTts(text: string): Promise<LoxBerryTtsResponse> {
    const clientName = this.config.clientId?.trim() || DEFAULT_CLIENT_ID;
    const corr = randomUUID();
    const requestPrefix = trimTopicPrefix(this.config.requestTopicPrefix) || 'tts-publish';
    const responsePrefix = trimTopicPrefix(this.config.responseTopicPrefix) || 'tts-subscribe';
    const requestTopic = `${requestPrefix}/${clientName}/${corr}`;
    const responseTopic = `${responsePrefix}/${clientName}/${corr}`;
    const timeoutMs = resolveTimeoutMs(this.config.timeoutMs);
    const client = await connectAsync(resolveBrokerUrl(this.config), this.buildMqttOptions(timeoutMs));
    try {
      const responsePromise = waitForResponse(client, responseTopic, corr, timeoutMs);
      await client.subscribeAsync(responseTopic, { qos: 0 });
      await client.publishAsync(
        requestTopic,
        JSON.stringify({
          text,
          function: this.config.function ?? '',
          nocache: this.config.nocache === true ? 1 : 0,
          logging: this.config.logging === false ? 0 : 1,
          mp3files: this.config.mp3files === true ? 1 : 0,
          client: clientName,
          corr,
          reply_to: responseTopic,
        }),
        { qos: 0 },
      );
      return await responsePromise;
    } finally {
      await client.endAsync().catch(() => undefined);
    }
  }

  private buildMqttOptions(timeoutMs: number): IClientOptions {
    const username = this.config.username?.trim();
    const password = this.config.password;
    return {
      username: username || undefined,
      password: password || undefined,
      reconnectPeriod: 0,
      connectTimeout: timeoutMs,
      clientId: `${DEFAULT_CLIENT_ID}-loxberry-tts`.replace(/[^a-zA-Z0-9_-]/g, '-'),
    };
  }

  private async cacheRemoteAudio(
    downloadUrl: string,
    text: string,
    language?: string,
  ): Promise<AlertMediaResource | undefined> {
    const digest = createHash('sha1')
      .update(`${this.config.type}|${language ?? ''}|${downloadUrl}|${text}`)
      .digest('hex');
    const filename = `tts-loxberry-${digest}.mp3`;
    const abs = path.join(CACHE_DIR, filename);
    await fs.mkdir(CACHE_DIR, { recursive: true });
    if (!(await exists(abs))) {
      const res = await fetch(downloadUrl, {
        headers: { Accept: 'audio/*,*/*' },
        signal: AbortSignal.timeout(resolveTimeoutMs(this.config.timeoutMs)),
      });
      const contentType = res.headers.get('content-type') ?? '';
      if (!res.ok || (contentType && !contentType.includes('audio') && !contentType.includes('octet-stream'))) {
        throw new Error(`HTTP ${res.status} ${res.statusText} (ct=${contentType || 'none'})`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(abs, buffer);
      this.log.info('cached LoxBerry TTS clip', {
        filename,
        bytes: buffer.length,
      });
    }
    const relativePath = `cache/${filename}`;
    return {
      title: buildTitle(text),
      relativePath,
      url: `alerts://cache/${encodeURIComponent(filename)}`,
      duration: await this.resolveDuration(filename),
    };
  }

  private async resolveDuration(filename: string): Promise<number | undefined> {
    const cacheKey = `cache/${filename}`;
    if (this.durationCache.has(cacheKey)) {
      return this.durationCache.get(cacheKey);
    }
    const abs = path.join(CACHE_DIR, filename);
    try {
      const meta = await parseFile(abs);
      const duration = meta.format.duration;
      if (typeof duration === 'number' && duration > 0) {
        const rounded = Math.round(duration);
        this.durationCache.set(cacheKey, rounded);
        return rounded;
      }
    } catch (err) {
      this.log.debug('LoxBerry TTS duration probe failed', {
        path: abs,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return undefined;
  }
}

export function parseLoxBerryTtsResponse(message: string): LoxBerryTtsResponse | null {
  try {
    const data = JSON.parse(message);
    const response = data.response ?? data;
    if (!response || typeof response !== 'object') {
      return null;
    }
    return response as LoxBerryTtsResponse;
  } catch {
    return null;
  }
}

export function resolveLoxBerryDownloadUrl(
  response: LoxBerryTtsResponse,
  provider: Pick<LoxBerryTtsProviderConfig, 'host' | 'httpBaseUrl'>,
): string | null {
  if (response.status && response.status !== 'done') {
    return null;
  }
  const file = response.file?.trim();
  if (!file) {
    return null;
  }
  const rawInterface =
    response.interfaces?.httpinterface ??
    response.httpinterface ??
    response.interfaces?.httpmp3interface ??
    response.httpmp3interface;
  const base = normalizeLoxBerryInterfaceUrl(rawInterface, provider);
  if (!base) {
    return null;
  }
  return `${base.replace(/\/+$/, '')}/${encodeURIComponent(file)}`;
}

function normalizeLoxBerryInterfaceUrl(
  rawInterface: string | undefined,
  provider: Pick<LoxBerryTtsProviderConfig, 'host' | 'httpBaseUrl'>,
): string | null {
  const fallbackBase = provider.httpBaseUrl?.trim() || (provider.host?.trim() ? `http://${provider.host.trim()}` : '');
  if (!fallbackBase) {
    return null;
  }
  const raw = rawInterface?.trim();
  if (!raw) {
    return null;
  }
  if (/^https?:\/\/[^/]/i.test(raw)) {
    return raw;
  }
  const pathOnly = raw.replace(/^https?:\/\/\/?/i, '/');
  try {
    return new URL(pathOnly.startsWith('/') ? pathOnly : `/${pathOnly}`, fallbackBase).toString();
  } catch {
    return null;
  }
}

function waitForResponse(
  client: MqttClient,
  responseTopic: string,
  corr: string,
  timeoutMs: number,
): Promise<LoxBerryTtsResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${responseTopic}`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      client.off('message', onMessage);
    };
    const onMessage = (topic: string, payload: Buffer): void => {
      if (topic !== responseTopic) {
        return;
      }
      const parsed = parseLoxBerryTtsResponse(payload.toString());
      if (!parsed) {
        return;
      }
      const responseCorr = parsed.corr ?? parsed.original?.corr;
      if (responseCorr && responseCorr !== corr) {
        return;
      }
      cleanup();
      if (parsed.status && parsed.status !== 'done') {
        reject(new Error(parsed.message || `LoxBerry TTS returned ${parsed.status}`));
        return;
      }
      resolve(parsed);
    };
    client.on('message', onMessage);
  });
}

function resolveBrokerUrl(config: LoxBerryTtsProviderConfig): string {
  const protocol = config.protocol === 'mqtts' ? 'mqtts' : 'mqtt';
  const host = config.host?.trim();
  const port = config.mqttPort ?? (protocol === 'mqtts' ? DEFAULT_MQTTS_PORT : DEFAULT_MQTT_PORT);
  return `${protocol}://${host}:${port}`;
}

function resolveTimeoutMs(timeoutMs?: number): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.round(timeoutMs)
    : DEFAULT_TIMEOUT_MS;
}

function trimTopicPrefix(value?: string): string {
  return value?.trim().replace(/^\/+|\/+$/g, '') ?? '';
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildTitle(text: string): string {
  return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}
