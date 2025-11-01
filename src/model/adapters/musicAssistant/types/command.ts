export type MusicAssistantCommand =
  | 'play'
  | 'pause'
  | 'stop'
  | 'resume'
  | 'next'
  | 'previous'
  | 'queueplus'
  | 'queueminus'
  | 'volume'
  | 'repeat'
  | 'shuffle'
  | 'serviceplay'
  | 'playlistplay'
  | 'announce'
  | 'groupjoin'
  | 'groupleave';

export interface MusicAssistantCommandParams {
  delta?: number;
  currentVolume?: number;
}