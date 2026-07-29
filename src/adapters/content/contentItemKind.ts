import type { ContentFolderItem, ContentItemKind } from '@/ports/ContentTypes';

/**
 * Resolves what a listing item actually is.
 *
 * Providers already knew — they have always set a `tag` string — but nothing read
 * it, so every consumer fell back to the Loxone `type` number, which cannot tell an
 * album from an artist from a playlist. This is the single place that decides, so
 * providers can migrate to an explicit `kind` one at a time.
 *
 * The legacy `tag` vocabulary mixes two things: what an item *is* ('album') and
 * where it *lives* ('nas', 'sd'). Locations are not kinds — they collapse to
 * 'folder', and `ContentFolderItem.nas` already carries that distinction.
 */

/** Loxone FileType for a directly playable file. */
const FILE_TYPE_TRACK = 2;

const TAG_TO_KIND: Record<string, ContentItemKind> = {
  track: 'track',
  album: 'album',
  artist: 'artist',
  playlist: 'playlist',
  radio: 'radio',
  station: 'radio',
  show: 'show',
  episode: 'episode',
  category: 'category',
  // Storage locations, not kinds.
  nas: 'folder',
  sd: 'folder',
  folder: 'folder',
};

export function resolveItemKind(item: ContentFolderItem): ContentItemKind {
  if (item.kind) {
    return item.kind;
  }
  const tag = item.tag?.trim().toLowerCase();
  const mapped = tag ? TAG_TO_KIND[tag] : undefined;
  // A playable file is a track when its tag says nothing about what it is: the local
  // library tags tracks by storage ('sd'/'nas'), so that must not decide the kind.
  //
  // It must not override a tag that *does* name a kind, though. Radio stations are
  // playable files tagged 'radio', and letting the file check win made every station
  // indistinguishable from a track at every consumer — which also left `kind: 'radio'`
  // unreachable in practice, since no provider sets it explicitly.
  if (item.type === FILE_TYPE_TRACK && item.audiopath && (!mapped || mapped === 'folder')) {
    return 'track';
  }
  if (mapped) {
    return mapped;
  }
  return 'folder';
}

/** Whether a kind is a container others can browse into. */
export function isContainerKind(kind: ContentItemKind): boolean {
  return kind !== 'track' && kind !== 'radio' && kind !== 'episode';
}
