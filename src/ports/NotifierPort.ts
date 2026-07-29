import type { AudioSyncGroupPayload } from '@/ports/types/groups';
import type { ZoneState } from '@/domain/zones/zoneState';

export interface NotifierPort {
  notifyZoneStateChanged: (state: ZoneState) => void;
  notifyQueueUpdated: (zoneId: number, queueSize: number) => void;
  notifyRoomFavoritesChanged: (zoneId: number, count: number) => void;
  notifyRecentlyPlayedChanged: (zoneId: number, timestamp: number) => void;
  notifyRescan: (status: 0 | 1 | 2, folders?: number, files?: number) => void;
  notifyReloadMusicApp: (action: 'useradd' | 'userdel', provider: string, userId: string) => void;
  notifyAudioSyncEvent: (payload: AudioSyncGroupPayload[]) => void;
}
