import type { AudioType } from '@/domain/zones/enums';

export interface QueueItem {
  album: string;
  artist: string;
  audiopath: string;
  /** Which kind of source this item is. Same categories as `ZoneState.audiotype`. */
  audiotype: AudioType;
  coverurl: string;
  animatedCoverUrl?: string;
  duration: number;
  originalIndex?: number;
  qindex: number;
  station: string;
  title: string;
  unique_id: string;
  user: string;
  /**
   * First-class service identity for neutral consumers (own player, DLNA):
   * the real streaming service (`applemusic`, `tidal`, …) and the content kind
   * (`track`/`album`/`artist`/`playlist`/`radio`). Additive — not serialized in
   * the Loxone getqueue payload, so the native wire shape is unchanged.
   */
  provider?: string;
  kind?: string;
}
