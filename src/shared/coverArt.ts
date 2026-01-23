import type { PlaybackMetadata, PlaybackSession } from '@/application/playback/audioManager';
import { decodeAudiopath } from '@/domain/loxone/audiopath';

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
