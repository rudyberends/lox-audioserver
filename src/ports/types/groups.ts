export interface AudioSyncEventPlayer {
  id: string;
  playerid: number;
  name: string;
}

export interface AudioSyncGroupPayload {
  group: string;
  mastervolume: number;
  players: AudioSyncEventPlayer[];
  type: 'dynamic';
}
