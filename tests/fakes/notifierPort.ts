import type { NotifierPort } from '../../src/ports/NotifierPort';

export function makeNotifierFake(): NotifierPort {
  return {
    notifyZoneStateChanged: () => {
      /* noop */
    },
    notifyQueueUpdated: () => {
      /* noop */
    },
    notifyRoomFavoritesChanged: () => {
      /* noop */
    },
    notifyRecentlyPlayedChanged: () => {
      /* noop */
    },
    notifyRescan: () => {
      /* noop */
    },
    notifyReloadMusicApp: () => {
      /* noop */
    },
    notifyAudioSyncEvent: () => {
      /* noop */
    },
  };
}
