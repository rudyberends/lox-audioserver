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
 * Parse a Loxone playback command parameter.
 * Handles `/parentpath/...` pattern and `noshuffle` suffixes.
 */
export function parseLoxoneCommand(param: unknown): ParsedContentPayload {
  const args = Array.isArray(param) ? param.map(String) : [String(param ?? '')];
  const raw = decodeURIComponent(args[0] ?? '').trim();

  // Shuffle = true unless /noshuffle is explicitly present
  const shuffle = !raw.toLowerCase().includes('/noshuffle');

  let item = raw;
  let startItem: string | undefined;

  if (raw.includes('/parentpath/')) {
    // Split between encoded child and parent folder
    const [childRaw, parentRaw] = raw.split('/parentpath/');

    // Remove /noshuffle and query parts before decoding
    const cleanChild = childRaw.split('/noshuffle')[0].split('?')[0].trim();

    // Decode the Base64 section (e.g. YXBwbGVfbXVzaWM6Ly90cmFjay8xNzMyNTc1MjY4)
    const decoded = decodeAudiopath(cleanChild);
    startItem = decoded.split('/').pop();

    // Strip trailing numeric segment (e.g. /3) from album path
    item = parentRaw.replace(/\/\d+$/i, '').replace(/\/+$/, '');
  } else {
    // No parentpath, just decode the base64 section cleanly
    const cleanItem = raw.split('/noshuffle')[0].split('?')[0].trim();
    item = decodeAudiopath(cleanItem);
  }

  return { item, startItem, shuffle };
}