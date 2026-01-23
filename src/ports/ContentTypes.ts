import type { SpotifyAccountConfig as ConfigSpotifyAccountConfig } from '@/domain/config/types';

export interface ContentServiceAccount {
  id: string;
  label: string;
  provider: 'spotify' | 'applemusic' | 'musicassistant' | 'deezer' | 'tidal' | string;
  fake?: boolean;
  product?: string;
}

export interface ContentServiceEntry {
  cmd: string;
  name: string;
  icon: string;
  accounts?: ContentServiceAccount[];
}

export interface ContentFolderItem {
  id: string;
  name: string;
  type: number;
  audiopath?: string;
  coverurl?: string;
  items?: number;
  title?: string;
  thumbnail?: string;
  tag?: string;
  nas?: boolean;
  origin?: string;
  owner?: string;
  followed?: boolean;
  artist?: string;
  album?: string;
  provider?: string;
  duration?: number;
  hasCover?: boolean;
  owner_id?: string;
}

export interface ContentFolder {
  id: string;
  name: string;
  items: ContentFolderItem[];
  totalitems: number;
  start: number;
  service?: string;
}

export interface PlaylistEntry {
  id: string;
  name: string;
  tracks: number;
  audiopath: string;
  coverurl?: string;
}

export interface RadioStation {
  id: string;
  name: string;
  stream: string;
  coverurl?: string;
}

export interface RadioMenuEntry {
  cmd: string;
  name: string;
  icon: string;
  root: string;
  description?: string;
  editable?: boolean;
}

export type SpotifyAccountConfig = ConfigSpotifyAccountConfig;
export type SpotifyBridgeConfig = import('@/domain/config/types').SpotifyBridgeConfig;

export type ScanStatus = 0 | 1 | 2;

export interface ContentItemMetadata {
  title: string;
  artist: string;
  album: string;
  coverurl?: string;
  duration?: number;
  station?: string;
}

export interface GlobalSearchResult {
  [key: string]: ContentFolderItem[];
}
