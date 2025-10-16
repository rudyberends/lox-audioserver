export interface RadioEntry {
  cmd: string;
  name: string;
  icon: string;
  root: string;
}

export interface RadioFolderResponse {
  id: string;
  name: string;
  service: string;
  totalitems: number;
  start: number;
  items: RadioFolderItem[];
}

export interface RadioFolderItem {
  id: string;
  name: string;
  station: string;
  audiopath: string;
  coverurl: string;
  contentType?: string;
  sort?: string;
  type: number;
  provider?: string;
  album?: string;
  artist?: string;
  tag?: string;
}

export interface PlaylistItem {
  audiopath: string;
  coverurl: string;
  type: number;
  id?: string;
  name?: string;
  items?: number;
  provider?: string;
  providerInstanceId?: string;
  rawId?: string;
  album?: string;
  artist?: string;
  title?: string;
  uniqueId?: string;
  playlistId?: string;
  playlistName?: string;
  playlistCover?: string;
  thumbnail?: string;
  playlistProviderInstanceId?: string;
  playlistStartItem?: string;
  playlistFriendlyPath?: string;
  playlistCommandUri?: string;
}

export interface PlaylistResponse {
  id: number | string;
  name: string;
  totalitems: number;
  start: number;
  items: PlaylistItem[];
  coverurl?: string;
  thumbnail?: string;
}

export interface MediaFolderItem {
  id: string;
  name: string;
  cmd?: string;
  type: number;
  contentType?: string;
  sort?: string;
  coverurl?: string;
  audiopath?: string;
  provider?: string;
  items?: number;
  providerInstanceId?: string;
  rawId?: string;
  album?: string;
  artist?: string;
  duration?: number;
  tag?: string;
  thumbnail?: string;
  owner?: string;
  title?: string;
  followed?: boolean;
  playlistId?: string;
  playlistName?: string;
  playlistCover?: string;
  playlistStartItem?: string;
  playlistProviderInstanceId?: string;
  playlistCommandUri?: string;
  nas?: boolean;
  usb?: boolean;
  external?: boolean;
  origin?: number;
}

export interface MediaFolderResponse {
  id: string;
  totalitems: number;
  start: number;
  items: MediaFolderItem[];
  name?: string;
  tag?: string;
  thumbnail?: string;
  coverurl?: string;
  type?: number;
  artist?: string;
}

export interface FavoriteItem {
  id: number;
  slot: number;
  name: string;
  plus: boolean;
  audiopath: string;
  type: string;
  coverurl?: string;
  title?: string;
  artist?: string;
  album?: string;
  owner?: string;
  station?: string;
  service?: string;
  username?: string;
  duration?: number;
  provider?: string;
  providerInstanceId?: string;
  rawId?: string;
  [key: string]: unknown;
}

export interface FavoriteResponse {
  id: string | number;
  name: string;
  totalitems: number;
  start: number;
  items: FavoriteItem[];
  ts?: number;
}

export interface RecentItem {
  audiopath: string;
  coverurl: string;
  title: string;
  service: string;
  type: number;
  user?: string;
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

export interface RadioProvider {
  getRadios(): Promise<RadioEntry[]> | RadioEntry[];
  getServiceFolder(
    service: string,
    folderId: string,
    user: string,
    offset: number,
    limit: number,
  ): Promise<RadioFolderResponse | MediaFolderResponse> | RadioFolderResponse | MediaFolderResponse;
  resolveStation?(
    service: string,
    stationId: string,
  ): Promise<RadioFolderItem | undefined> | RadioFolderItem | undefined;
}

export interface PlaylistProvider {
  getPlaylists(offset: number, limit: number): Promise<PlaylistResponse> | PlaylistResponse;
  getPlaylistItems?(
    playlistId: string,
    offset: number,
    limit: number,
  ): Promise<PlaylistResponse | undefined> | PlaylistResponse | undefined;
}

export interface MediaProvider extends RadioProvider {
  getPlaylists(offset: number, limit: number): Promise<PlaylistResponse> | PlaylistResponse;
  getPlaylistItems?(
    playlistId: string,
    offset: number,
    limit: number,
  ): Promise<PlaylistResponse | undefined> | PlaylistResponse | undefined;
  resolvePlaylist?(
    service: string,
    playlistId: string,
  ): Promise<PlaylistItem | undefined> | PlaylistItem | undefined;
  getMediaFolder?(
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<MediaFolderResponse> | MediaFolderResponse;
  resolveMediaItem?(
    folderId: string,
    itemId: string,
  ): Promise<MediaFolderItem | undefined> | MediaFolderItem | undefined;
  getFavorites?(
    zoneId: number,
    offset: number,
    limit: number,
  ): Promise<FavoriteResponse> | FavoriteResponse;
  getRecentlyPlayed?(
    zoneId: number,
    limit: number,
  ): Promise<RecentResponse> | RecentResponse;
  clearRecentlyPlayed?(zoneId: number): Promise<void> | void;
  globalSearch?(source: string, query: string): Promise<Record<string, any>> | Record<string, any>;
}
