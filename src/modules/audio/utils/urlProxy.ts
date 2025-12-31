import { createLogger } from '@/core/logging/logger';

const log = createLogger('Audio', 'UrlProxy');
const DEFAULT_HTTP_PORT = 7090;

export function buildProxyUrl(
  targetUrl: string,
  headers?: Record<string, string>,
): string | null {
  if (!targetUrl) {
    return null;
  }
  if (process.env.AUDIO_DISABLE_URL_PROXY === '1') {
    return null;
  }
  if (!/^https?:/i.test(targetUrl)) {
    return null;
  }

  const host = resolveProxyHost();
  const port = resolveProxyPort();
  const params = new URLSearchParams();
  params.set('u', targetUrl);
  const headerPayload = encodeHeaders(headers);
  if (headerPayload) {
    params.set('h', headerPayload);
  }
  const proxyUrl = `http://${host}:${port}/streams/proxy?${params.toString()}`;
  log.debug('proxying audio url for ffmpeg', { targetUrl, proxyUrl });
  return proxyUrl;
}

export function resolveProxyHost(): string {
  const host = process.env.HTTP_HOST ?? '0.0.0.0';
  if (!host || host === '0.0.0.0') {
    return '127.0.0.1';
  }
  return host;
}

export function resolveProxyPort(): number {
  const parsed = Number(process.env.HTTP_PORT ?? DEFAULT_HTTP_PORT);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HTTP_PORT;
}

export function encodeHeaders(headers?: Record<string, string>): string | null {
  if (!headers) {
    return null;
  }
  const entries = Object.entries(headers).filter(
    ([, value]) => typeof value === 'string' && value.length > 0,
  );
  if (!entries.length) {
    return null;
  }
  try {
    return Buffer.from(JSON.stringify(Object.fromEntries(entries)), 'utf8').toString('base64');
  } catch {
    return null;
  }
}

export function decodeHeaders(payload: string | null): Record<string, string> | undefined {
  if (!payload) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(payload, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded) as Record<string, string>;
    if (!parsed || typeof parsed !== 'object') {
      return undefined;
    }
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.length > 0) {
        filtered[key] = value;
      }
    }
    return Object.keys(filtered).length ? filtered : undefined;
  } catch {
    return undefined;
  }
}
