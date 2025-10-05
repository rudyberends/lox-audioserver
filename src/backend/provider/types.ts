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
  contentType: string;
  sort: string;
  type: number;
  provider?: string;
}

export interface PlaylistItem {
  audiopath: string;
  coverurl: string;
  id: string;
  name: string;
  items: number;
  type: number;
  provider?: string;
}

export interface PlaylistResponse {
  id: number;
  name: string;
  totalitems: number;
  start: number;
  items: PlaylistItem[];
}

export interface MediaFolderItem {
  id: string;
  name: string;
  cmd: string;
  type: number;
  contentType: string;
  sort: string;
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
}

export interface MediaProvider extends RadioProvider {
  getPlaylists(offset: number, limit: number): Promise<PlaylistResponse> | PlaylistResponse;
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
}
