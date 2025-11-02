import { decodeAudiopath } from '@/core/loxone/mediaMapping';

export const CONTENT_COMMANDS = [
  'libraryplay',
  'serviceplay',
  'playlistplay',
  'urlplay',
  'favoriteplay',
  'alertplay',
] as const;

export type ContentCommandType = typeof CONTENT_COMMANDS[number];

export interface ParsedContentPayload {
  readonly item: string;
  readonly startItem?: string;
  readonly shuffle: boolean;
}

/**
 * Parses a Loxone command parameter into its base components:
 *  - item: main target URI (e.g. "library://album/634")
 *  - startItem: optional nested track ID (e.g. "1436541295")
 *  - shuffle: playback shuffle flag
 */
export function parseLoxoneCommand(param: unknown): ParsedContentPayload {
  const args = Array.isArray(param) ? param.map(String) : [String(param ?? '')];
  const raw = decodeURIComponent(args[0] ?? '').trim();

  // Remove query string early — nothing after "?" is part of the encoded URI
  const cleanedRaw = raw.split('?')[0];

  // Determine shuffle flag from any arg
  const shuffle =
    args.some(a => a?.toLowerCase?.() === 'true' || a === '1' || a === 'shuffle');

  let item = cleanedRaw;
  let startItem: string | undefined;

  if (cleanedRaw.includes('/parentpath/')) {
    const [childRaw, parentRaw] = cleanedRaw.split('/parentpath/');

    // Decode the child audiopath and extract only the final ID
    const decoded = decodeAudiopath(childRaw);
    startItem = decoded.split('/').pop();

    // Strip numeric tail and optional /noshuffle from parent path
    item = parentRaw
      .replace(/\/\d+(?:\/noshuffle.*)?$/i, '')
      .replace(/\/+$/, '');
  } else {
    // Direct decode path (no parent reference)
    const decoded = decodeAudiopath(cleanedRaw);
    item = decoded.replace(/\/noshuffle.*$/i, '').replace(/\/+$/, '');
  }

  return { item, startItem, shuffle };
}