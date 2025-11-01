export interface ProviderSearchResult {
  error?: number;
  unique?: string;
  result?: {
    tracks?: any[];
    albums?: any[];
    artists?: any[];
    playlists?: any[];
    shows?: any[];
    episodes?: any[];
    topresults?: any[];
  };
}