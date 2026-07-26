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

/**
 * What a browsable item actually is, independent of any protocol.
 *
 * `ContentFolderItem.type` is a Loxone FileType: it says "file" or "folder" and
 * collapses album/artist/playlist onto the same number, so a consumer cannot tell
 * them apart. This is the neutral vocabulary every consumer can rely on — DLNA maps
 * it onto UPnP classes, the Loxone adapter keeps projecting `type`.
 *
 * Providers should set `kind` directly; {@link resolveItemKind} derives it from the
 * legacy `tag` string for those that don't yet.
 */
export type ContentItemKind =
  | 'track'
  | 'album'
  | 'artist'
  | 'playlist'
  /** A live stream (internet radio); playable, but not a fixed-length track. */
  | 'radio'
  /** A podcast/show container and its episodes. */
  | 'show'
  | 'episode'
  /** A browse-only grouping (genres, moods, "browse" roots). */
  | 'category'
  /** Anything else browsable: storage folders, service roots, unknown containers. */
  | 'folder';

export interface ContentFolderItem {
  id: string;
  name: string;
  type: number;
  audiopath?: string;
  coverurl?: string;
  items?: number;
  title?: string;
  thumbnail?: string;
  /** Neutral item kind. Preferred over {@link tag}; see {@link ContentItemKind}. */
  kind?: ContentItemKind;
  /**
   * Loxone-facing hint string ('track', 'album', 'nas', …). Kept because the Loxone
   * clients receive it verbatim; new code should read {@link kind} instead.
   */
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
export type StreamingServiceConfig = import('@/domain/config/types').StreamingServiceConfig;

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
