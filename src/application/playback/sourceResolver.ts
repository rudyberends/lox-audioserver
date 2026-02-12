import path from 'node:path';
import { decodeAudiopath } from '@/domain/loxone/audiopath';
import { resolveDataDir } from '@/shared/utils/file';
import type { PlaybackSource } from '@/ports/EngineTypes';
import { createLogger } from '@/shared/logging/logger';
import { buildProxyUrl } from '@/shared/urlProxy';

const musicRoot = path.resolve(resolveDataDir('music'));
const alertsRoot = path.resolve(process.cwd(), 'public', 'alerts');
const log = createLogger('Audio', 'SourceResolver');
const MAX_ALERT_PRE_DELAY_MS = 10_000;

export function resolvePlaybackSource(audiopath: string): PlaybackSource | null {
  const decoded = decodeAudiopath(audiopath);
  if (!decoded) {
    log.debug('decodeAudiopath failed; no playback source resolved', { audiopath });
    return null;
  }

  if (decoded.startsWith('library://')) {
    const relative = decoded.slice('library://'.length);
    const normalized = normalizeLibraryPath(relative);
    if (!normalized) {
      log.warn('failed to normalize library path', { audiopath: decoded });
      return null;
    }
    return { kind: 'file', path: normalized };
  }

  if (decoded.startsWith('alerts://')) {
    const parsed = parseAlertSource(decoded, 'alerts://');
    const normalized = normalizeAlertsPath(parsed.relativePath);
    if (!normalized) {
      log.warn('failed to normalize alerts path', { audiopath: decoded });
      return null;
    }
    return { kind: 'file', path: normalized, preDelayMs: parsed.preDelayMs, padTailSec: 0 };
  }

  if (decoded.startsWith('alerts-loop://')) {
    const parsed = parseAlertSource(decoded, 'alerts-loop://');
    const normalized = normalizeAlertsPath(parsed.relativePath);
    if (!normalized) {
      log.warn('failed to normalize alerts loop path', { audiopath: decoded });
      return null;
    }
    return { kind: 'file', path: normalized, loop: true, preDelayMs: parsed.preDelayMs, padTailSec: 0 };
  }

  if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
    const proxied = buildProxyUrl(decoded);
    return { kind: 'url', url: proxied ?? decoded };
  }

  // Anything else (e.g. provider-specific URIs such as spotify:track:abc) is output-only.
  log.debug('no direct playback source resolved (output-only)', { audiopath: decoded });
  return null;
}

function normalizeLibraryPath(input: string): string | null {
  if (!input) {
    return null;
  }

  const safeSegments = input
    .split('/')
    .filter(Boolean)
    .map((segment) => safeDecode(segment))
    .filter((segment) => segment && segment !== '.' && segment !== '..');

  if (!safeSegments.length) {
    return null;
  }

  const candidate = path.resolve(musicRoot, ...safeSegments);
  if (!candidate.startsWith(musicRoot)) {
    return null;
  }
  return candidate;
}

function normalizeAlertsPath(input: string): string | null {
  if (!input) {
    return null;
  }
  const safeSegments = input
    .split('/')
    .filter(Boolean)
    .map((segment) => safeDecode(segment))
    .filter((segment) => segment && segment !== '.' && segment !== '..');

  if (!safeSegments.length) {
    return null;
  }

  const candidate = path.resolve(alertsRoot, ...safeSegments);
  if (!candidate.startsWith(alertsRoot)) {
    return null;
  }
  return candidate;
}

function parseAlertSource(
  input: string,
  prefix: 'alerts://' | 'alerts-loop://',
): { relativePath: string; preDelayMs: number } {
  const raw = input.slice(prefix.length);
  const queryIndex = raw.indexOf('?');
  if (queryIndex === -1) {
    return { relativePath: raw, preDelayMs: 0 };
  }
  const relativePath = raw.slice(0, queryIndex);
  const query = raw.slice(queryIndex + 1);
  return {
    relativePath,
    preDelayMs: parseAlertPreDelayMs(query),
  };
}

function parseAlertPreDelayMs(query: string): number {
  if (!query) {
    return 0;
  }
  const params = new URLSearchParams(query);
  const raw =
    params.get('predelay') ??
    params.get('predelayms') ??
    params.get('preDelayMs') ??
    params.get('pre_delay_ms');
  if (!raw?.trim()) {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.min(MAX_ALERT_PRE_DELAY_MS, Math.max(0, Math.round(parsed)));
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
