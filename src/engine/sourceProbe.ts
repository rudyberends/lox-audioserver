import { execFile } from 'node:child_process';
import fs from 'node:fs';
import ffmpegStatic from 'ffmpeg-static';
import { createLogger } from '@/shared/logging/logger';
import type { PcmBitDepth } from '@/engine/audioFormat';

const log = createLogger('Audio', 'SourceProbe');

/**
 * The ffmpeg-static package ships ffmpeg only — no ffprobe. So we look for an
 * ffprobe next to the static binary (some distributions add one) and otherwise
 * fall back to PATH, which is what the Docker image provides (`apt-get install
 * ffmpeg` pulls ffprobe along). A missing ffprobe is not fatal: probeFileFormat
 * returns null and callers keep the negotiated format.
 */
const FFPROBE_BINARY: string = (() => {
  if (typeof ffmpegStatic === 'string' && ffmpegStatic) {
    const sibling = ffmpegStatic.replace(/ffmpeg(\.exe)?$/, (m) =>
      m.endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe',
    );
    if (sibling !== ffmpegStatic && fs.existsSync(sibling)) {
      return sibling;
    }
  }
  return 'ffprobe';
})();

/** Probing must never stall playback; a slow/absent probe just means "unknown". */
const PROBE_TIMEOUT_MS = 2000;

export interface ProbedSourceFormat {
  sampleRate: number;
  channels: number;
  /**
   * Bit depth of the *source samples*, not of the container. For lossy codecs
   * ffprobe reports nothing meaningful, so this stays null and callers must not
   * infer a lossless path.
   */
  bitDepth: PcmBitDepth | null;
  /** True when the codec carries the original samples intact (flac/alac/wav/aiff/…). */
  lossless: boolean;
  codecName: string;
}

const LOSSLESS_CODECS = new Set([
  'flac',
  'alac',
  'pcm_s16le',
  'pcm_s24le',
  'pcm_s32le',
  'pcm_s16be',
  'pcm_s24be',
  'pcm_s32be',
  'wavpack',
  'tta',
  'ape',
]);

function toBitDepth(raw: unknown): PcmBitDepth | null {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  if (n === 16 || n === 24 || n === 32) {
    return n;
  }
  // FLAC at 20 bits and similar oddities exist. They are lossless but not a PCM
  // container width we can emit, so treat the depth as unknown and let the caller
  // fall back to the negotiated depth rather than silently widening.
  return null;
}

/**
 * Probe results keyed by file path, so the synchronous AudioSession constructor
 * can look up a format that an async caller probed moments earlier.
 *
 * Bounded and insertion-ordered: playback walks a queue, so the oldest entries are
 * the least likely to be needed again. Keyed by path alone — a file whose content
 * changes under the same path is rare enough that a stale format is acceptable
 * (and only costs a resample, never a crash).
 */
const CACHE_LIMIT = 512;
const probeCache = new Map<string, ProbedSourceFormat | null>();

function cacheSet(filePath: string, value: ProbedSourceFormat | null): void {
  if (probeCache.size >= CACHE_LIMIT) {
    const oldest = probeCache.keys().next().value;
    if (oldest !== undefined) {
      probeCache.delete(oldest);
    }
  }
  probeCache.set(filePath, value);
}

/**
 * Synchronous cache lookup for callers that cannot await (the AudioSession
 * constructor). Returns undefined when the path was never probed — distinct from
 * null, which means "probed and unknown".
 */
export function getCachedSourceFormat(filePath: string): ProbedSourceFormat | null | undefined {
  return probeCache.get(filePath);
}

/** Drops all cached probe results. Used by tests and after a library rescan. */
export function clearSourceFormatCache(): void {
  probeCache.clear();
}

/**
 * Reads the native audio format of a local file. Returns null when ffprobe is
 * unavailable, times out, or the file has no audio stream — every caller treats
 * null as "keep the negotiated format", so a failed probe degrades to today's
 * behaviour instead of breaking playback.
 *
 * Local files only, by design. Probing a stream URL would need a second HTTP
 * request with the same headers/DRM key as playback, and for single-use or
 * expiring segment URLs that is unsafe. Stream providers declare their format via
 * the source's `nativeFormat` field instead.
 */
export async function probeFileFormat(filePath: string): Promise<ProbedSourceFormat | null> {
  const cached = probeCache.get(filePath);
  if (cached !== undefined) {
    return cached;
  }
  const args = [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=sample_rate,channels,bits_per_raw_sample,bits_per_sample,codec_name',
    '-of', 'json',
    filePath,
  ];

  const stdout = await new Promise<string | null>((resolve) => {
    execFile(
      FFPROBE_BINARY,
      args,
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 64 },
      (error, out) => {
        if (error) {
          log.debug('ffprobe failed; source format unknown', { filePath, error: error.message });
          resolve(null);
          return;
        }
        resolve(out);
      },
    );
  });

  if (!stdout) {
    cacheSet(filePath, null);
    return null;
  }

  try {
    const parsed = JSON.parse(stdout) as { streams?: Array<Record<string, unknown>> };
    const stream = parsed.streams?.[0];
    if (!stream) {
      cacheSet(filePath, null);
      return null;
    }
    const sampleRate = Number.parseInt(String(stream.sample_rate ?? ''), 10);
    const channels = Number(stream.channels);
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(channels) || channels <= 0) {
      cacheSet(filePath, null);
      return null;
    }
    const codecName = String(stream.codec_name ?? '').toLowerCase();
    // bits_per_raw_sample is the honest value for FLAC/ALAC; bits_per_sample is
    // the container width and is 0 for many codecs. Prefer the former.
    const bitDepth = toBitDepth(stream.bits_per_raw_sample) ?? toBitDepth(stream.bits_per_sample);
    const result: ProbedSourceFormat = {
      sampleRate,
      channels,
      bitDepth,
      lossless: LOSSLESS_CODECS.has(codecName),
      codecName,
    };
    cacheSet(filePath, result);
    return result;
  } catch (error) {
    log.debug('ffprobe output unparseable', { filePath, error: (error as Error).message });
    cacheSet(filePath, null);
    return null;
  }
}
