export type BeoLinkCommand =
  | 'play'
  | 'pause'
  | 'stop'
  | 'resume'
  | 'queueplus'
  | 'queueminus'
  | 'repeat'
  | 'shuffle'
  | 'volume'
  | 'groupjoin'
  | 'groupleave';

export interface BeoLinkCommandParams {
  delta?: number;
  currentVolume?: number;
}