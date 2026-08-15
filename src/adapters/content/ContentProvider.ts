import type {
  ContentFolder,
  ContentFolderItem,
  ContentServiceAccount,
  PlaylistEntry,
} from '@/ports/ContentTypes';

/**
 * What a search returns, whichever service answered it.
 *
 * Keyed by category (`tracks`, `albums`, …) because that is what the categories a provider
 * declares in {@link '@/adapters/content/providerCapabilities'} name. `_totals` carries the
 * catalogue-wide counts when the service reports them, so a consumer can say "10 of 4213".
 */
export type ProviderSearchCategories = Record<string, ContentFolderItem[]>;

export type ProviderSearchResult = {
  result: ProviderSearchCategories & { _totals?: Record<string, number> };
  providerId: string;
  user: string;
};

/**
 * One configured account of one content service.
 *
 * This contract was implicit for a long time: eight classes had grown the same ten methods,
 * and the registry reached them through a union type written out by hand and an `instanceof`
 * cascade with a branch per service. That shape came from the days when this server was only
 * ever a Loxone Audio Server — Loxone speaks Spotify and nothing else, so every other service
 * was introduced as a Spotify look-alike and the code was named accordingly. It still is on
 * the Loxone wire, and that disguise stays; what ends here is it reaching inward.
 *
 * Declaring the contract is what lets the registry hold providers rather than provider *types*:
 * a new service implements this and appears in one table, instead of in a branch in each of the
 * places that used to list them all.
 */
export interface ContentProvider {
  /** Key this provider is registered under. */
  readonly providerId: string;
  /** The account within the service, as the service itself names it. */
  readonly accountId: string;
  /** Name for a person to read — the configured label, else whatever the account offers. */
  readonly displayLabel: string;

  getServiceAccount(): ContentServiceAccount;
  /** Null when the service needs no token, or when this account has none right now. */
  fetchAccessToken(forceRefresh?: boolean): Promise<string | null>;

  getFolder(folderId: string, offset: number, limit: number): Promise<ContentFolder | null>;
  getTrack(trackId: string): Promise<ContentFolderItem | null>;
  getPlaylists(offset: number, limit: number): Promise<PlaylistEntry[]>;
  search(
    query: string,
    limits: Record<string, number>,
    maxLimit: number,
  ): Promise<ProviderSearchResult>;

  /**
   * The artists this service puts beside one of its own — optional on purpose.
   *
   * Editorial data only a catalogue owner has. A provider without the notion simply does not
   * implement it and the caller falls back to what it can derive, which is how a feature can be
   * per-service without every service having to grow it.
   */
  getRelatedArtists?(folderId: string, limit: number): Promise<ContentFolderItem[]>;

  dispose(): void;
}
