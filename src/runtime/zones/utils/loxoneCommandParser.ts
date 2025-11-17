import { decodeAudiopath } from '@/core/loxone/mediaMapping';

export interface ParsedContentPayload {
  readonly item: string;
  readonly startItem?: string;
  readonly shuffle: boolean;
}

/**
 * Decode Loxone/MusicAssistant audiopaths containing base64 payloads.
 * Examples:
 *  - tunein:station:bGlicmFyeTovL3JhZGlvLzEw   → library://radio/10
 *  - spotify@nouser:track:YXBwbGVfbXVzaWM6Ly90cmFjay8xMzQzOTY0MjY4 → apple_music://track/1343964268
 */
export function parseLoxoneCommand(param: unknown) {
  const args = Array.isArray(param) ? param.map(String) : [String(param ?? '')];
  const raw = (args[0] ?? '').trim();

  // verwijder bekende suffixen en trailing noise
  const cleaned = raw
    .replace(/\/?\??q&ZW5mb3JjZVVzZXI9dHJ1ZQ.*$/i, '') // enforceUser=true noise
    .replace(/\/noshuffle.*$/i, '')                    // noshuffle
    .replace(/\/+$/, '');                              // trailing slashes

  const shuffle = args.some(a => /^(true|1|shuffle)$/i.test(a ?? ''));

  // parentpath → album/playlist
  if (cleaned.includes('/parentpath/')) {
    const [child, parent] = cleaned.split('/parentpath/');
    const startItem = decodeAudiopath(child).split('/').pop();
    const item = parent.replace(/\/\d+(?:\/noshuffle.*)?$/i, '').replace(/\/+$/, '');
    return { item, startItem, shuffle };
  }

  // altijd decode base64 → audiopath
  const base64 = cleaned.split(':').pop()?.split('/')[0] ?? '';
  const item = decodeAudiopath(base64);
  return { item, shuffle };
}