const HTTP_URL_REGEX = /^https?:\/\//i;

export type BaseUrlOptions = {
  host?: string | null;
  port?: number;
  fallbackHost?: string;
};

export type StreamUrlOptions = {
  baseUrl: string;
  zoneId: number;
  streamPath?: string | null;
  defaultExt?: string;
  prime?: string | number | boolean | null;
  primeMode?: 'ensure' | 'upsert';
};

export function buildBaseUrl(options: BaseUrlOptions): string {
  const host = options.host?.trim() || options.fallbackHost || '127.0.0.1';
  const port = options.port ?? 7090;
  return `http://${host}:${port}`;
}

export function resolveAbsoluteUrl(baseUrl: string, pathOrUrl?: string | null): string | null {
  if (!pathOrUrl) {
    return null;
  }
  if (HTTP_URL_REGEX.test(pathOrUrl)) {
    return pathOrUrl;
  }
  if (!pathOrUrl.startsWith('/')) {
    return null;
  }
  return `${baseUrl}${pathOrUrl}`;
}

export function ensureQueryParam(url: string, key: string, value: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has(key)) {
      parsed.searchParams.set(key, value);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function upsertQueryParam(url: string, key: string, value: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set(key, value);
    return parsed.toString();
  } catch {
    return url;
  }
}

export function resolveStreamUrl(options: StreamUrlOptions): string {
  const ext = options.defaultExt ?? 'mp3';
  const stablePath = `/streams/${options.zoneId}/current.${ext}`;
  const baseCandidate = resolveAbsoluteUrl(options.baseUrl, options.streamPath);
  const url = baseCandidate ?? `${options.baseUrl}${stablePath}`;
  if (options.prime === null || options.prime === undefined) {
    return url;
  }
  const primeValue = String(options.prime);
  return options.primeMode === 'upsert'
    ? upsertQueryParam(url, 'prime', primeValue)
    : ensureQueryParam(url, 'prime', primeValue);
}

export function normalizeStreamUrl(
  url: string,
  baseUrl: string,
  exts: string[] = ['mp3'],
): string {
  if (!url || !exts.length) {
    return url;
  }
  const pattern = exts.map((ext) => ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const match = url.match(new RegExp(`/streams/(\\d+)/[^/?#]+\\.(${pattern})`, 'i'));
  if (!match) {
    return url;
  }
  const zoneId = Number(match[1]);
  if (!Number.isFinite(zoneId)) {
    return url;
  }
  const ext = match[2]?.toLowerCase() || exts[0];
  const stablePath = `/streams/${zoneId}/current.${ext}`;
  return resolveAbsoluteUrl(baseUrl, stablePath) ?? url;
}
