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
  parentpath?: string;
  shuffle?: boolean;
  kind?: string;
  command?: string;
  [key: string]: unknown;
}

export interface FavoriteResponse {
  id: string | number;
  totalitems: number;
  start: number;
  items: FavoriteItem[];
  type: number;
  ts?: number;
}
