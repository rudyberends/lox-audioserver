/**
 * Building a page of a folder, once, instead of six times.
 *
 * There was no shared helper, so every provider assembled `{start, totalitems, items}`
 * itself — and they disagreed. Two providers had same-named `estimateTotal` functions with
 * different formulas (`start + cap + 1` versus `start + got + cap`), one added a phantom
 * item so a client would keep asking, and one reported a real upstream total for an
 * endpoint it never paged. Downstream, DLNA substitutes `offset + count` and Subsonic pages
 * until it sees a short page, both because the figure could not be trusted.
 *
 * The fix is not a better guess. It is saying which of the two situations you are in:
 * either upstream told you the count, or it did not.
 */
import type { ContentFolder, ContentFolderItem } from '@/ports/ContentTypes';

type PageBase = {
  id: string;
  name: string;
  service?: string;
  start: number;
  items: ContentFolderItem[];
};

/**
 * A page whose total came from upstream.
 *
 * `total` is passed through untouched — it describes the whole collection, not this slice,
 * so it must not be derived from `items.length`.
 */
export function knownPage(base: PageBase, total: number): ContentFolder {
  return {
    id: base.id,
    name: base.name,
    ...(base.service ? { service: base.service } : {}),
    start: base.start,
    items: base.items,
    totalitems: Math.max(0, Math.round(total)),
    totalKnown: true,
  };
}

/**
 * A page whose total nobody knows.
 *
 * The number still has to be *something*, because the field is not optional and the Loxone
 * app reads it to decide whether to ask again. So: a short page means this was the end and
 * the count is exact after all; a full page means there may be more, and the figure sits
 * one page ahead to keep a client paging. `totalKnown: false` is what stops anyone treating
 * that as a fact.
 */
export function estimatedPage(base: PageBase, requestedLimit: number): ContentFolder {
  const got = base.items.length;
  const exhausted = requestedLimit <= 0 || got < requestedLimit;
  return {
    id: base.id,
    name: base.name,
    ...(base.service ? { service: base.service } : {}),
    start: base.start,
    items: base.items,
    totalitems: exhausted ? base.start + got : base.start + got + requestedLimit,
    totalKnown: exhausted,
  };
}

/**
 * A page cut from a list already held in full.
 *
 * The total is exact by construction, so this is `knownPage` with the slicing done for you
 * — the shape that used to be written out longhand as `items.slice(offset, offset + limit)`
 * with `totalitems: all.length` beside it.
 */
export function slicedPage(
  base: Omit<PageBase, 'items'>,
  all: ContentFolderItem[],
  limit: number,
): ContentFolder {
  const start = Math.max(0, base.start);
  return knownPage({ ...base, start, items: all.slice(start, start + Math.max(0, limit)) }, all.length);
}
