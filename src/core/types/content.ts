
/* -------------------------------------------------------------------------- */
/*  Generic media model                                                       */
/* -------------------------------------------------------------------------- */

export interface ContentItem {
  id: string;
  title: string;
  subtitle?: string;
  coverUrl?: string;
  type?: 'track' | 'album' | 'playlist' | 'artist' | 'folder' | 'radio' | 'unknown';
}

export interface BrowseOptions {
  path?: string | null;
  limit?: number;
  offset?: number;
}

export interface SearchOptions {
  query: string;
  limit?: number;
  offset?: number;
}

export interface GlobalSearchResult {
  /** Optional provider name (e.g. 'spotify', 'musicassistant') */
  provider?: string;
  /** Optional query string for reference */
  query?: string;
  /** Loxone-compatible categorized results */
  tracks?: any[];
  albums?: any[];
  artists?: any[];
  playlists?: any[];
  episodes?: any[];
  shows?: any[];
  /** If error occurred during search (0 = success, 1 = failure) */
  error?: number;
}

/* -------------------------------------------------------------------------- */
/*  Playlist models                                                           */
/* -------------------------------------------------------------------------- */

export interface PlaylistItem {
  id: string | number;
  name: string;
  title?: string;
  audiopath: string;
  type: number | string;
  coverurl?: string;
  provider?: string;
  album?: string;
  artist?: string;
  cmd?: string;
  rawId?: string;
  items?: number;
  thumbnail?: string;
  playlistCover?: string;
  playlistId?: string;
  providerInstanceId?: string;
  playlistProviderInstanceId?: string;
  playlistCommandUri?: string;
  uniqueId?: string;
}

export interface PlaylistResponse {
  id: string | number;
  name: string;
  totalitems: number;
  start: number;
  items: PlaylistItem[];
  coverurl?: string;
  thumbnail?: string;
}

/* -------------------------------------------------------------------------- */
/*  Recents models                                                            */
/* -------------------------------------------------------------------------- */

export interface RecentItem {
  audiopath: string;
  title: string;
  service: string;
  type: number | string;
  coverurl?: string;
  name?: string;
  artist?: string;
  album?: string;
  duration?: number;
  provider?: string;
  station?: string;
  contentType?: string;
  [key: string]: unknown;
}

export interface RecentResponse {
  id: string;
  name: string;
  totalitems: number;
  start: number;
  items: RecentItem[];
  ts: number;
}

/* -------------------------------------------------------------------------- */
/*  Service folder (Albums, Artists, Playlists, etc.)                         */
/* -------------------------------------------------------------------------- */

export interface ServiceFolderRequest {
  service: string;
  user: string;
  folderId: string;
  offset: number;
  limit: number;
}

export interface ServiceFolderItem {
  name: string;
  type?: number | string;
  cmd?: string;
  audiopath?: string;
  coverurl?: string;
  thumbnail?: string;
  provider?: string;
  album?: string;
  artist?: string;
  duration?: number;
  tag?: string;
  sort?: string;
  items?: number;
  rawId?: string;
  owner?: string;
  contentType?: string;
  [key: string]: unknown;
}

export interface ServiceFolderResponse {
  id: string;
  name?: string;
  service?: string;
  totalitems: number;
  start: number;
  items: ServiceFolderItem[];
  tag?: string;
  type?: number | string;
  coverurl?: string;
  thumbnail?: string;
  artist?: string;
}

/* -------------------------------------------------------------------------- */
/*  Radio models                                                              */
/* -------------------------------------------------------------------------- */

export interface RadioEntry {
  cmd: string;
  name: string;
  icon: string;
  root: string;
}

export interface RadioFolderItem {
  id: string;
  name: string;
  station: string;
  audiopath: string;
  coverurl: string;
  type: number;
  provider?: string;
  album?: string;
  artist?: string;
  tag?: string;
  contentType?: string;
  sort?: string;
}

export interface RadioFolderResponse {
  id: string;
  name: string;
  service: string;
  totalitems: number;
  start: number;
  items: RadioFolderItem[];
}

/**
 * Unified contract for content providers such as Music Assistant or BeoLink.
 */
export interface ContentProvider {
  providerId: string;
  initialize?(): Promise<void>;
  dispose?(): Promise<void>;

  browse?(options?: any): Promise<any[]>;
  search?(options: any): Promise<any[]>;
  getItem?(id: string): Promise<any | null>;

  globalSearch?(source: string, query: string, unique: string): Promise<any>;
  getAvailableServices?(): Promise<any[]>;
  getServices?(): Promise<any[]>;
  getServiceFolder?(...args: any[]): Promise<any>;
  getRadioFolder?(...args: any[]): Promise<any>;
  resolveRadioStation?(...args: any[]): Promise<any>;
  getRecentlyPlayed?(zoneId: number, limit: number): Promise<any>;
  clearRecentlyPlayed?(zoneId: number): Promise<void>;
  getPlaylists?(...args: any[]): Promise<any>;
  resolveTrack(audiopath: string): Promise<any>;
}