/**
 * What a content provider can actually do.
 *
 * Until now the only capability statement in the codebase was `searchSource: string | null`
 * — one nullable string meaning "searchable at all, or not". Everything finer was asserted
 * rather than known: `globalsearch/describe` reported Spotify's six search categories for
 * *every* provider, which is false for SoundCloud (no albums) and badly false for
 * YouTube/YT Music (tracks only). A consumer that trusted it asked for albums from a
 * provider that has never returned one.
 *
 * The fix, borrowed from Music Assistant's `ProviderFeature`: declare capability per
 * (operation × item kind), not per operation. At that granularity a provider cannot claim a
 * uniform blob — it has to say which kinds it means — and a consumer can render exactly the
 * tabs that will return something.
 */
import type { ContentItemKind } from '@/ports/ContentTypes';

/**
 * The kinds a provider can search for.
 *
 * A subset of {@link ContentItemKind}: `folder` and `category` are navigation, not things
 * you search for, and nothing has ever returned them from a search.
 */
export type SearchableKind = Extract<
  ContentItemKind,
  'track' | 'album' | 'artist' | 'playlist' | 'radio' | 'show' | 'episode'
>;

export interface ProviderCapabilities {
  /** Whether the provider has a browsable hierarchy at all. */
  browse: boolean;
  /**
   * Which kinds a search returns. Empty means the provider cannot search.
   *
   * Declared rather than inferred: a provider that lists a kind here and returns nothing
   * for it is a bug in that provider, and one that omits a kind it could serve is only
   * hiding a feature — both are better than a consumer guessing.
   */
  search: readonly SearchableKind[];
  /**
   * Whether the provider's catalogue is larger than the user's own collection.
   *
   * True for a streaming service: "every album on Tidal" is not an enumerable list, so an
   * ID3-style view has to show the user's collection instead. False for a local library,
   * where the catalogue *is* the collection.
   *
   * This is what the Subsonic adapter currently guesses by matching folder names against
   * English words like `albums` and `artists` — which silently fails for a localised
   * provider. Music Assistant declares the same distinction as `is_streaming_provider`.
   */
  catalogueExceedsLibrary: boolean;
}

/**
 * What a provider that has not declared anything is assumed to do.
 *
 * Browsable, unsearchable, catalogue-is-library. Chosen so an undeclared provider is
 * *under*-advertised: a consumer offers it fewer features than it may have, rather than
 * offering one that fails.
 */
export const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  browse: true,
  search: [],
  catalogueExceedsLibrary: false,
};

/** Whether a provider can search at all — the question `searchSource` used to answer. */
export function canSearch(capabilities: ProviderCapabilities): boolean {
  return capabilities.search.length > 0;
}

/** Whether a provider can search for one particular kind. */
export function canSearchKind(
  capabilities: ProviderCapabilities,
  kind: SearchableKind,
): boolean {
  return capabilities.search.includes(kind);
}
