import type { AudioSyncEventPlayer } from './audioSyncEventPlayer';

export interface AudioSyncGroupPayload {
  group: string;
  mastervolume: number;
  players: AudioSyncEventPlayer[];
  type: 'dynamic';
}
