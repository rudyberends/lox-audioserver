import { configManager } from '@/runtime';
import type { MediaItemImage } from '../types/musicAssistantTypes';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Default resize size for images (in pixels). Use 0 to skip resizing. */
export const DEFAULT_IMAGE_SIZE = 128;

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Extracts the best-available cover image path or proxied image URL.
 *
 * Accepts either:
 *  - an object with metadata/images/cover fields, OR
 *  - a direct MediaItemImage[] array.
 *
 * Always routes through Music Assistant's /imageproxy endpoint.
 *
 * @param source Object or image array
 * @param resize Pixel size (e.g. 256, 512). Use 0 to skip resizing.
 */
export function extractCover(
  source?:
    | MediaItemImage[]
    | {
        metadata?: { images?: MediaItemImage[] };
        image?: { path?: string };
        cover?: string;
      },
  resize: number = DEFAULT_IMAGE_SIZE,
): string {
  // --- Case 1: direct array of images
  if (Array.isArray(source)) {
    return getFromImages(source, resize);
  }

  // --- Case 2: structured object
  const fromMeta = getFromImages(source?.metadata?.images, resize);
  const fromImage =
    typeof source?.image?.path === 'string' ? source.image.path.trim() : '';
  const fromCover =
    typeof source?.cover === 'string' ? source.cover.trim() : '';

  return fromMeta || fromImage || fromCover || '';
}

/**
 * Convenience helper for quickly getting an image from a Track object.
 */
export function extractImageFromTrack(
  track?: { metadata?: { images?: MediaItemImage[] } },
  resize: number = DEFAULT_IMAGE_SIZE,
): string {
  return extractCover(track?.metadata?.images ?? [], resize);
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Selects the best image from an array and builds its proxied URL.
 */
function getFromImages(images?: MediaItemImage[], resize = DEFAULT_IMAGE_SIZE): string {
  if (!Array.isArray(images) || images.length === 0) {
    return '';
  }

  const img =
    images.find((i) => typeof i?.path === 'string' && /^https?:\/\//i.test(i.path.trim())) ||
    images.find((i) => typeof i?.path === 'string' && i.path.trim());

  const path = img?.path?.trim();
  if (!path) {
    return '';
  }

  const provider = img?.provider ?? 'library';
  return buildImageProxyUrl(path, provider, resize);
}

/**
 * Builds a proxied image URL for Music Assistant's /imageproxy endpoint.
 * Internal use only.
 *
 * Always includes `checksum=` (even if empty).
 * Skips `&size=` entirely when resize is 0.
 */
function buildImageProxyUrl(uri: string, provider: string, size: number): string {
  if (typeof uri !== 'string' || uri.trim() === '') {
    return '';
  }

  const { host, port } = getBaseUrl();
  const encodedPath = doubleEncode(uri.trim());
  const encodedProvider = encodeURIComponent(provider);
  const sizeParam = size > 0 ? `&size=${size}` : '';

  return `http://${host}:${port}/imageproxy?path=${encodedPath}&provider=${encodedProvider}&checksum=${sizeParam}`;
}

/**
 * Resolves the base host and port for the Music Assistant image proxy.
 */
function getBaseUrl(): { host: string; port: number } {
  const cfg = configManager.getMediaProviderConfig();
  const opts = (cfg?.options ?? {}) as { ip?: string; port?: number };
  return {
    host: opts.ip ?? '127.0.0.1',
    port: opts.port ?? 8095,
  };
}

/** Performs double encoding (required by MA's /imageproxy). */
function doubleEncode(str: string): string {
  return encodeURIComponent(encodeURIComponent(str));
}