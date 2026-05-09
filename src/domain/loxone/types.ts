/**
 * Projection of a zone state as expected by Loxone Audio clients.
 */
export interface LoxoneZoneState {
  album: string;
  artist: string;
  audiopath: string;
  audiotype: number;
  clientState: 'on' | 'off';
  coverurl: string;
  duration: number;
  /** Comma-separated 10-band EQ values for Loxone App AudioZone controls. */
  equalizerSettings: string;
  icontype?: number;
  mode: 'play' | 'pause' | 'stop';
  name: string;
  parent: LoxoneParentMeta | null;
  playerid: number;
  plrepeat: number;
  plshuffle: number;
  power: 'on' | 'off';
  /** Physical/managed amplifier power state from PowerManager (separate from legacy `power`). */
  powerState?: 'on' | 'off';
  qindex: number;
  queueAuthority?: string;
  sourceName: string;
  station: string;
  time: number;
  title: string;
  qid?: string;
  type: number;
  volume: number;
  /**
   * Player IDs of all members in this zone's sync group (leader first).
   * Empty when the zone is not grouped. Enriched at emit time from the
   * shared group tracker — not stored authoritatively per zone.
   */
  syncedzones?: number[];
  /**
   * Master volume of the sync group this zone belongs to (leader's volume).
   * 0 when the zone is not grouped.
   */
  mastervolume?: number;
}

export interface LoxoneParentMeta {
  audiopath: string;
  coverurl: string;
  id: string;
  items: number;
  name: string;
  type: number;
}
