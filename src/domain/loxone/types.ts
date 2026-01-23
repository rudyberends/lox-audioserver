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
  icontype?: number;
  mode: 'play' | 'pause' | 'stop';
  name: string;
  parent: LoxoneParentMeta | null;
  playerid: number;
  plrepeat: number;
  plshuffle: number;
  power: 'on' | 'off';
  qindex: number;
  queueAuthority?: string;
  sourceName: string;
  station: string;
  time: number;
  title: string;
  qid?: string;
  type: number;
  volume: number;
}

export interface LoxoneParentMeta {
  audiopath: string;
  coverurl: string;
  id: string;
  items: number;
  name: string;
  type: number;
}
