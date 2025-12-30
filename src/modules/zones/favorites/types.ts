export interface FavoriteItem {
  id: number;
  slot: number;
  name: string;
  plus: boolean;
  audiopath: string;
  type: number | string;
  coverurl?: string;
  title?: string;
  artist?: string;
  album?: string;
  [key: string]: unknown;
}

export interface FavoriteResponse {
  id: number;
  type: number;
  start: number;
  totalitems: number;
  items: FavoriteItem[];
  ts?: number;
}
