import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { probeAlertDurationSeconds } from '@/application/alerts/alertClipDuration';
import type { AlertMediaResource } from '@/application/alerts/types';

const CACHE_DIR = path.resolve(process.cwd(), 'public', 'alerts', 'cache');
const MAX_TITLE_CHARS = 48;

export interface TtsClipRequest {
  /** Filename prefix, which keeps one provider's clips from colliding with another's. */
  prefix: string;
  /** Container extension without the dot, e.g. `mp3`. */
  extension: string;
  /**
   * Everything that makes this clip what it is — voice, model, language, text.
   * Joined with `|` and hashed into the filename, so a changed setting yields a
   * different file instead of silently replaying the previous rendering.
   */
  cacheKey: readonly string[];
  /** Spoken text; only used to label the clip. */
  text: string;
  /** Called only on a cache miss. Must resolve to the encoded audio. */
  produce: () => Promise<Buffer>;
  probeDuration?: (absPath: string) => Promise<number | undefined>;
}

/**
 * Turn synthesized speech into an alert the zones can play: write it to the
 * alert cache under a content-addressed name, then describe it.
 *
 * This is the whole of what a TTS provider shares with its siblings — a
 * provider only has to know how to talk to its backend.
 */
export async function storeTtsClip(request: TtsClipRequest): Promise<AlertMediaResource> {
  const filename = ttsClipFilename(request.prefix, request.extension, request.cacheKey);
  const abs = path.join(CACHE_DIR, filename);
  await fs.mkdir(CACHE_DIR, { recursive: true });
  if (!(await exists(abs))) {
    await fs.writeFile(abs, await request.produce());
  }
  const probeDuration = request.probeDuration ?? probeAlertDurationSeconds;
  return {
    title: buildClipTitle(request.text),
    relativePath: `cache/${filename}`,
    url: `alerts://cache/${encodeURIComponent(filename)}`,
    duration: await probeDuration(abs),
  };
}

export function ttsClipFilename(
  prefix: string,
  extension: string,
  cacheKey: readonly string[],
): string {
  const digest = createHash('sha1').update(cacheKey.join('|')).digest('hex');
  return `${prefix}-${digest}.${extension}`;
}

export function buildClipTitle(text: string): string {
  return text.length > MAX_TITLE_CHARS ? `${text.slice(0, MAX_TITLE_CHARS - 3)}…` : text;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
