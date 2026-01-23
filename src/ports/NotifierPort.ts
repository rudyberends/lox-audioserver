import type { AudioSyncGroupPayload } from '@/application/groups/types/AudioSyncGroupPayload';
import type { LoxoneZoneState } from '@/domain/loxone/types';

export interface NotifierPort {
  notifyZoneStateChanged: (state: LoxoneZoneState) => void;
  notifyQueueUpdated: (zoneId: number, queueSize: number) => void;
  notifyRoomFavoritesChanged: (zoneId: number, count: number) => void;
  notifyRecentlyPlayedChanged: (zoneId: number, timestamp: number) => void;
  notifyRescan: (status: 0 | 1 | 2, folders?: number, files?: number) => void;
  notifyReloadMusicApp: (action: 'useradd' | 'userdel', provider: string, userId: string) => void;
  notifyAudioSyncEvent: (payload: AudioSyncGroupPayload[]) => void;
}
