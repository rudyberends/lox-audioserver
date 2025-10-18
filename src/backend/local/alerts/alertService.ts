import fs from 'fs';
import path from 'path';
import { promises as fsp } from 'fs';
import { createHash } from 'crypto';
import * as googleTTS from 'google-tts-api';
import logger from '../../../utils/troxorlogger';
import { config as runtimeConfig } from '../../../config/config';

/**
 * Alert asset resolver shared by the HTTP handlers. It serves three jobs:
 *  1. map well-known alert types (bell/alarm/...) to bundled media files,
 *  2. generate and cache TTS audio on demand,
 *  3. expose URL helpers so other layers can stream the assets back to Loxone.
 *
 * All media lives under `public/alerts`, so bundling (or running from sources) keeps
 * the files available without extra configuration.
 */
const DEFAULT_MEDIA_DIR = path.resolve(process.cwd(), 'public', 'alerts');
const DEFAULT_CACHE_DIR = path.resolve(process.cwd(), 'public', 'alerts', 'cache');
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // one week
const CACHE_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // six hours

export const BUILTIN_ALERT_PREFIX = 'builtin';
export const BUILTIN_ALERT_DIR = path.resolve(process.cwd(), 'public', 'alerts');
const BUILTIN_ALERT_FILES: Record<string, string> = Object.freeze({
  alarm: 'alarm.mp3',
  firealarm: 'firealarm.mp3',
  bell: 'bell.mp3',
  buzzer: 'buzzer.mp3',
});

export interface AlertMediaResource {
  source: 'file' | 'tts';
  title: string;
  absolutePath: string;
  relativePath: string;
  text?: string;
  language?: string;
}

export interface AlertMediaRequest {
  type: string;
  text?: string;
  language?: string;
}

/**
 * Normalised snapshot describing where alert media & TTS cache should live.
 */
export interface AlertsConfigNormalized {
  mediaDirectory: string;
  cacheDirectory: string;
  tts: {
    enabled: boolean;
    provider: 'google';
  };
}

let lastCacheCleanup = 0;

/**
 * Returns the canonical alert media configuration.
 *
 * The structure is intentionally tiny: everything is hardcoded except the runtime host/port
 * used by {@link buildAlertMediaUrl}.
 */
export function getAlertsConfig(): AlertsConfigNormalized {
  const resolvedMediaDir = DEFAULT_MEDIA_DIR;
  const resolvedCacheDir = DEFAULT_CACHE_DIR;
  const provider = 'google';
  return {
    mediaDirectory: resolvedMediaDir,
    cacheDirectory: resolvedCacheDir,
    tts: {
      enabled: true,
      provider,
    },
  };
}

/**
 * Parses Loxone "grouped" target identifiers into concrete zone IDs.
 * Only numeric IDs are supported; named groups are handled upstream in Loxone.
 */
export function resolveAlertTargets(token: string): number[] {
  if (!token) return [];
  const segments = token
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    const numeric = Number(token);
    return Number.isFinite(numeric) ? [numeric] : [];
  }

  const unique = new Set<number>();
  for (const segment of segments) {
    const numeric = Number(segment);
    if (Number.isFinite(numeric)) {
      unique.add(numeric);
    }
  }

  return Array.from(unique.values());
}

/**
 * Resolves the media payload (static file or generated TTS) for a given alert request.
 */
export async function resolveAlertMedia(request: AlertMediaRequest): Promise<AlertMediaResource | undefined> {
  const type = request.type.toLowerCase();
  if (type === 'tts') {
    return request.text ? generateTtsResource(request) : undefined;
  }
  return resolveStaticAlert(type);
}

/**
 * Attempts to locate a static media file for the requested alert type.
 */
async function resolveStaticAlert(type: string): Promise<AlertMediaResource | undefined> {
  const config = getAlertsConfig();
  await ensureDirectoryExists(config.mediaDirectory);

  const configCandidates = buildConfigCandidates(type, config);
  for (const { absolute, relative } of configCandidates) {
    if (!(await fileExists(absolute))) continue;
    return {
      source: 'file',
      title: buildTitleFromType(type),
      absolutePath: absolute,
      relativePath: normalizeRelativePath(relative),
    };
  }

  const builtinCandidate = await resolveBuiltinAlert(type);
  if (builtinCandidate) {
    return builtinCandidate;
  }

  logger.warn(`[AlertService] No media file found for alert type "${type}" (config or built-in).`);
  return undefined;
}

/** Builds the list of candidate filenames under the configurable media directory. */
function buildConfigCandidates(
  type: string,
  config: AlertsConfigNormalized,
): Array<{ absolute: string; relative: string }> {
  const candidates = new Set<string>();
  candidates.add(`${type}.mp3`);
  candidates.add(`${type}.wav`);

  const results: Array<{ absolute: string; relative: string }> = [];
  for (const candidate of candidates) {
    const absolute = path.resolve(config.mediaDirectory, candidate);
    const relative = relativeFromMediaDirectory(absolute, config);
    if (!relative) continue;
    results.push({ absolute, relative });
  }

  return results;
}

/** Returns the bundled fallback asset for the given alert type (if available). */
async function resolveBuiltinAlert(type: string): Promise<AlertMediaResource | undefined> {
  const fileName = BUILTIN_ALERT_FILES[type];
  if (!fileName) {
    return undefined;
  }

  const absolute = path.resolve(BUILTIN_ALERT_DIR, fileName);
  if (!(await fileExists(absolute))) {
    logger.warn(
      `[AlertService] Built-in alert file missing for type "${type}" at ${absolute}.`,
    );
    return undefined;
  }

  const relativePath = normalizeRelativePath(`${BUILTIN_ALERT_PREFIX}/${fileName}`);
  return {
    source: 'file',
    title: buildTitleFromType(type),
    absolutePath: absolute,
    relativePath,
  };
}

/**
 * Generates (or reuses) a cached TTS audio file for the supplied text.
 */
async function generateTtsResource(request: AlertMediaRequest): Promise<AlertMediaResource | undefined> {
  const config = getAlertsConfig();
  if (!config.tts.enabled) {
    logger.warn('[AlertService] TTS request ignored because provider is disabled.');
    return undefined;
  }

  const text = (request.text ?? '').trim();
  if (!text) {
    return undefined;
  }

  const language = (request.language ?? 'en').trim() || 'en';
  await ensureDirectoryExists(config.cacheDirectory);
  await runCacheCleanupIfNeeded(config.cacheDirectory);

  const hashInput = `${language}|${text}`;
  const digest = createHash('sha1').update(hashInput).digest('hex');
  const fileName = `tts-${digest}.mp3`;
  const absolute = path.join(config.cacheDirectory, fileName);

  if (!(await fileExists(absolute))) {
    try {
      const segments = await googleTTS.getAllAudioBase64(text, {
        lang: language,
        slow: false,
        host: 'https://translate.google.com',
        splitPunct: ',.?!',
      });
      const buffers = segments.map((segment) => Buffer.from(segment.base64, 'base64'));
      const combined = Buffer.concat(buffers);
      await fsp.writeFile(absolute, combined);
      logger.info(`[AlertService] Generated TTS audio (${language}) at ${absolute}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[AlertService] Failed to generate TTS audio: ${message}`);
      return undefined;
    }
  }

  const relative = relativeFromMediaDirectory(absolute, config);
  if (!relative) {
    logger.error('[AlertService] TTS cache directory is not within the media directory; cannot serve audio.');
    return undefined;
  }

  return {
    source: 'tts',
    title: text.length > 48 ? `${text.slice(0, 45)}…` : text,
    absolutePath: absolute,
    relativePath: normalizeRelativePath(relative),
    text,
    language,
  };
}

/** Idempotent helper creating the desired media / cache directory. */
async function ensureDirectoryExists(dir: string): Promise<void> {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[AlertService] Failed to ensure directory ${dir}: ${message}`);
    throw error;
  }
}

/** Thin wrapper around `fs.access` returning a boolean. */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Performs periodic cleanup of stale cache files to cap disk usage. */
async function runCacheCleanupIfNeeded(dir: string): Promise<void> {
  const now = Date.now();
  if (now - lastCacheCleanup < CACHE_CLEANUP_INTERVAL_MS) {
    return;
  }
  lastCacheCleanup = now;

  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    logger.warn(
      `[AlertService] Unable to enumerate cache directory ${dir}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const absolute = path.join(dir, entry.name);
        try {
          const stats = await fsp.stat(absolute);
          if (now - stats.mtimeMs > CACHE_MAX_AGE_MS) {
            await fsp.unlink(absolute);
          }
        } catch (error) {
          logger.debug(
            `[AlertService] Cache cleanup skipped for ${absolute}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }),
  );
}

/** Ensures the path is inside the configured media directory, returning a portable relative form. */
function relativeFromMediaDirectory(filePath: string, config: AlertsConfigNormalized): string | undefined {
  const relative = path.relative(config.mediaDirectory, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative;
}

/** Converts platform-dependent separators to URL-friendly `/`. */
function normalizeRelativePath(relative: string): string {
  return relative.split(path.sep).join('/');
}

/** Generates a friendly, human-readable title from an alert key. */
function buildTitleFromType(type: string): string {
  if (!type) return 'Alert';
  return type
    .split(/[-_]/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

/** Builds an HTTP URL pointing at the `/alerts` endpoint served by the proxy. */
export function buildAlertMediaUrl(relativePath: string): string {
  const baseUrl = getAlertBaseUrl();
  const segments = relativePath.split('/').map((segment) => encodeURIComponent(segment));
  return `${baseUrl}/${segments.join('/')}`;
}

/** Determines the host used when streaming alert media back to Loxone. */
function getAlertBaseUrl(): string {
  const host =
    process.env.ALERTS_HOST ||
    runtimeConfig.audioserver?.ip ||
    process.env.AUDIOSERVER_IP ||
    '127.0.0.1';
  const port = Number(process.env.ALERTS_PORT) || 7091;
  return `http://${host}:${port}/alerts`;
}
