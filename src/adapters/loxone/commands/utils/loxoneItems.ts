import type { ContentFolderItem } from '@/ports/ContentTypes';

/**
 * Keeps the Loxone wire exactly as the clients expect it.
 *
 * The content layer carries a neutral `kind` ('album', 'artist', …) so consumers
 * that are not Loxone — DLNA, Subsonic, our own player — can tell what an item is.
 * The Loxone apps decide how to render a row from `type` and `tag`, both of which
 * stay untouched; `kind` is ours alone and is dropped here rather than shipped as
 * an unknown field.
 */
export function stripNeutralItemFields(items: ContentFolderItem[]): ContentFolderItem[] {
  return items.map(({ kind: _kind, ...item }) => item);
}

/** {@link stripNeutralItemFields} for a folder payload. */
export function forLoxoneFolder<T extends { items?: ContentFolderItem[] }>(folder: T): T {
  return Array.isArray(folder.items)
    ? { ...folder, items: stripNeutralItemFields(folder.items) }
    : folder;
}

/** {@link stripNeutralItemFields} for a global-search result, keyed by category. */
export function forLoxoneSearchResult<T extends Record<string, unknown>>(result: T): T {
  const out: Record<string, unknown> = { ...result };
  for (const [key, value] of Object.entries(result)) {
    if (Array.isArray(value)) {
      out[key] = stripNeutralItemFields(value as ContentFolderItem[]);
    }
  }
  return out as T;
}
