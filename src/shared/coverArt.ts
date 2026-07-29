import type { PlaybackMetadata, PlaybackSession } from '@/ports/types/playback';
import { decodeAudiopath } from '@/domain/zones/audiopath';

/**
 * Canonical cover-art sizing, shared by every provider/input.
 *
 * Two tiers, because the use cases pull in opposite directions:
 * - {@link COVER_ART_NOW_PLAYING_SIZE}: a single cover shown large on the Loxone
 *   display — favour sharpness.
 * - {@link COVER_ART_BROWSE_SIZE}: thumbnails in browse/search/queue lists, which
 *   for streaming services can run to thousands of items — favour small payloads.
 *
 * Each call site passes an explicit `targetSize` (one of the two constants) so it
 * declares which tier it serves. Providers that only expose fixed sizes are
 * quantized to their nearest available variant.
 */
export const COVER_ART_NOW_PLAYING_SIZE = 640;
export const COVER_ART_BROWSE_SIZE = 256;

/** JPEG quality (0-100) used when locally re-encoding cover art. */
export const COVER_ART_JPEG_QUALITY = 85;

/** Maximum accepted byte length when downloading remote cover art. */
export const COVER_ART_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Rewrite a remote cover URL to request a ~`targetSize` variant where the
 * upstream host supports it. Returns the input unchanged otherwise.
 */
export function resizeCoverUrl(url: string, targetSize: number): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.pathname.includes('imageproxy') && !parsed.searchParams.has('size')) {
      parsed.searchParams.set('size', String(targetSize));
      return parsed.toString();
    }
    // Apple Music images: .../<hash>/<filename>/<WxH>bb.jpg → force square target.
    if (parsed.hostname.includes('mzstatic.com')) {
      parsed.pathname = parsed.pathname.replace(
        /\/\d{2,5}x\d{2,5}bb\.jpg/i,
        `/${targetSize}x${targetSize}bb.jpg`,
      );
      return parsed.toString();
    }
  } catch {
    /* not a full URL; return as-is */
  }
  return url;
}

/** Cover Art Archive only serves fixed thumbnail sizes; pick the nearest one. */
const COVER_ART_ARCHIVE_SIZES = [250, 500, 1200];
export function coverArtArchiveSize(target: number): number {
  return COVER_ART_ARCHIVE_SIZES.reduce((best, size) =>
    Math.abs(size - target) < Math.abs(best - target) ? size : best,
  );
}

/**
 * TuneIn logo URLs end in a single-letter variant before the extension
 * (`.../logoq.jpg`). Sizes verified against cdn-profiles.tunein.com: `q` is
 * 145px, `d` 300px and `g` 600px. `g` matters because now-playing asks for 640 —
 * quantizing to `d` there was a soft image on anything larger than a phone.
 */
const TUNEIN_VARIANTS: Array<[letter: string, size: number]> = [
  ['q', 145],
  ['d', 300],
  ['g', 600],
];

/** `.../logo<letter>.<ext>` — the letter is what selects the size. */
const TUNEIN_LOGO_VARIANT = /(\/logo)[a-z](?=\.[^./]*$)/i;

export function resizeTuneInCoverUrl(url: string, targetSize: number): string {
  if (!url) return url;
  const [letter] = TUNEIN_VARIANTS.reduce((best, cur) =>
    Math.abs(cur[1] - targetSize) < Math.abs(best[1] - targetSize) ? cur : best,
  );
  // Matches whichever letter is there rather than only `q`: a URL that already
  // arrived as `logod.jpg` could otherwise never be moved up or down.
  return url.replace(TUNEIN_LOGO_VARIANT, `$1${letter}`);
}

/**
 * Resolves a usable cover-art URI for a playback session.
 * Prefers explicit metadata covers and falls back to hints embedded
 * in the audiopath (when they already reference HTTP resources).
 */
export function resolveSessionCover(session: PlaybackSession): string {
  if (session.cover) {
    return session.stream.coverUrl;
  }
  return resolveCoverFromSource(session.source, session.metadata);
}

export function resolveCoverFromSource(
  source: string,
  metadata?: PlaybackMetadata,
): string {
  if (metadata?.coverurl) {
    return metadata.coverurl;
  }
  return inferCoverFromAudiopath(source);
}

function inferCoverFromAudiopath(source: string): string {
  const decoded = decodeAudiopath(source);
  if (!decoded || !isHttpUrl(decoded)) {
    return '';
  }
  try {
    const url = new URL(decoded);
    const pathname = decodeURIComponent(url.pathname);
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length) {
      segments.pop();
    }
    segments.push('cover.jpg');
    url.pathname = '/' + segments.map((segment) => encodeURIComponent(segment)).join('/');
    return url.toString();
  } catch {
    return '';
  }
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
