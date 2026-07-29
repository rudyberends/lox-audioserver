/**
 * Projects the content layer's listings onto the public browse shape.
 *
 * Two things happen here that make this API better than the Loxone one it sits beside:
 *
 * - **The kind survives.** Internally an item carries a Loxone `type` number that collapses
 *   album, artist, playlist and show onto a single value, plus a `tag` string that recovers
 *   the distinction for providers that set it. `resolveItemKind` already decides between
 *   them; this turns the answer into a field a caller can branch on.
 * - **The provider keeps its own name.** `applemusic` is `applemusic` here, not the
 *   `spotify@bridge-…` disguise the Loxone clients require. That disguise is a translation
 *   for a client that knows one streaming service, and it stops at that adapter.
 */
import { isContainerKind, resolveItemKind } from '@/adapters/content/contentItemKind';
import { encodeContainerRef, encodePlayableRef } from '@/domain/media/browseRef';
import type { ApiBrowseItem, ApiItemKind } from '@/domain/zones/apiTypes';
import type { ContentFolderItem, ContentItemKind } from '@/ports/ContentTypes';

/**
 * Every internal kind is a public kind of the same name, so this is a widening cast rather
 * than a mapping — but it is written out so that adding an internal kind without deciding
 * what it is called publicly fails to compile.
 */
const KINDS: Record<ContentItemKind, ApiItemKind> = {
  track: 'track',
  album: 'album',
  artist: 'artist',
  playlist: 'playlist',
  radio: 'radio',
  show: 'show',
  episode: 'episode',
  category: 'category',
  folder: 'folder',
};

function toApiKind(kind: ContentItemKind): ApiItemKind {
  return KINDS[kind] ?? 'unknown';
}

/**
 * One listing row.
 *
 * `service` has to be passed in: an item does not reliably carry which provider produced it
 * — `item.provider` is set by some and not others — and the caller browsing a service always
 * knows.
 */
export function toApiBrowseItem(item: ContentFolderItem, service: string): ApiBrowseItem {
  const kind = resolveItemKind(item);
  const audiopath = (item.audiopath ?? '').trim();
  const container = isContainerKind(kind);
  const folderId = (item.id ?? '').trim() || audiopath;
  // A container is addressed by its folder id, a playable thing by its audiopath — which is
  // what lets browse → play work without a second lookup.
  const id = container
    ? encodeContainerRef({ kind, service, folderId })
    : encodePlayableRef({ kind, audiopath: audiopath || folderId });

  const name = (item.name ?? '').trim() || (item.title ?? '').trim();
  const artist = (item.artist ?? '').trim();
  const album = (item.album ?? '').trim();
  const cover = (item.coverurl ?? '').trim() || (item.thumbnail ?? '').trim();
  const duration = Number(item.duration);

  return {
    id,
    name,
    kind: toApiKind(kind),
    browsable: container,
    // A container can carry an audiopath too — "play the whole album" — so both are true
    // for one, and a caller picks by what the user did rather than by guessing from kind.
    playable: Boolean(audiopath),
    service,
    ...(artist ? { artist } : {}),
    ...(album ? { album } : {}),
    ...(Number.isFinite(duration) && duration > 0 ? { duration: Math.round(duration) } : {}),
    ...(cover ? { coverUrl: cover } : {}),
  };
}

/**
 * The container a listing describes, when we know what it is.
 *
 * Folders are the weak spot of the whole content layer: a folder never names itself when
 * browsed, because every provider hardcodes the literal `'Album'` or `'Playlist'` as the
 * listing name — the Loxone app takes the title from the parent listing and never asks.
 * Music Assistant has the same gap and answers with the raw id as the name.
 *
 * So `name` here is whatever the provider gave, and a caller that browsed in from a parent
 * already has the real name from that row. Better a plain name than a fabricated one.
 */
export function toApiContainer(
  folder: { id: string; name?: string },
  service: string,
  kind: ContentItemKind = 'folder',
): ApiBrowseItem {
  return {
    id: encodeContainerRef({ kind, service, folderId: folder.id }),
    name: (folder.name ?? '').trim(),
    kind: toApiKind(kind),
    browsable: true,
    playable: false,
    service,
  };
}
