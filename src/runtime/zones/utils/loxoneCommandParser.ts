import { decodeAudiopath } from '@/core/loxone/mediaMapping';
import { convertToAbsoluteVolume } from './volumeUtils';
import { fadeController } from './fadeController';
import { favoritesManager } from '@/runtime/audioServer';

export interface ParsedResult {
  readonly isContent: boolean;
  readonly contentType?: 'contentplay' | 'announce' | 'alert' | 'queue_seek';
  readonly param: any;
}

export async function parseLoxoneCommand(
  command: string,
  param: unknown,
  currentVolume: number,
): Promise<ParsedResult> {

  /* -----------------------------------------------------------------------
   * VOLUME
   * ---------------------------------------------------------------------*/
  if (command === 'volume') {
    return {
      isContent: false,
      param: convertToAbsoluteVolume(param, currentVolume),
    };
  }

  /* -----------------------------------------------------------------------
   * NON-CONTENT COMMANDS
   * ---------------------------------------------------------------------*/
  const isContentCmd = command === 'contentplay' || command === 'announce' || command === 'alert';

  if (!isContentCmd) {
    return { isContent: false, param };
  }

  /* -----------------------------------------------------------------------
   * ANNOUNCE / ALERT with direct URL
   * ---------------------------------------------------------------------*/
  if (param && typeof param === 'object' && 'url' in (param as any)) {
    const type = command === 'alert' ? 'alert' : 'announce';
    return {
      isContent: true,
      contentType: type,
      param: {
        item: String((param as any).url),
        shuffle: false,
        type,
      },
    };
  }

  /* -----------------------------------------------------------------------
   * CONTENTPLAY
   * ---------------------------------------------------------------------*/
  const args = Array.isArray(param) ? param.map(String) : [String(param ?? '')];
  const raw = (args[0] ?? '').trim();

  // shared flags
  const shuffle = !/\/noshuffle(\/|$)/i.test(raw);
  const fade = fadeController.parseFadeOptions(raw);

  // strip fade + noshuffle + trailing slashes
  const cleaned = raw
    .replace(/\/?\??q&ZW5mb3JjZVVzZXI9dHJ1ZQ.*$/i, '')
    .replace(/\?q&[A-Za-z0-9+/=]+$/i, '')
    .replace(/\/noshuffle.*$/i, '')
    .replace(/\/+$/, '');

  // detect type
  let mode: 'contentplay' | 'announce' | 'alert' | 'queue_seek' = 'contentplay';
  let item: string | null = cleaned;
  let start_item: string | undefined;

  // announce/alert with URL
  if (param && typeof param === 'object' && 'url' in (param as any)) {
    mode = command === 'alert' ? 'alert' : 'announce';
    item = String((param as any).url);

    // favorite alias fav/<id>
  } else if (cleaned.startsWith('fav/')) {
    const zoneId = Number(cleaned.split('/')[1] ?? '');
    const favoriteId = Number(cleaned.split('/')[2] ?? '');
    item = await favoritesManager.getAudiopathForFavorite(zoneId, favoriteId);

    // parentpath
  } else if (cleaned.includes('/parentpath/')) {
    const [child, parent] = cleaned.split('/parentpath/');
    start_item = decodeAudiopath(child).split('/').pop();
    item = parent.replace(/\/\d+$/i, '').replace(/\/+$/, '');

    // queue seek
  } else {
    const decoded = decodeAudiopath(cleaned);
    if (typeof decoded === 'string' && decoded.startsWith('queue://')) {
      mode = 'queue_seek';
      item = decoded.slice('queue://'.length);
    } else {
      item = decoded;
    }
  }

  // unified return
  return {
    isContent: true,
    contentType: mode,
    param: {
      type: mode,
      item,
      start_item,
      shuffle,
      ...(fade.fade ? { fade } : {}),
    },
  };
}