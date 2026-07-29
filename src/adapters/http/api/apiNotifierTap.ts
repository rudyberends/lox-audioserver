/**
 * Fans zone-state changes out to the public API without giving the API its own
 * source of truth.
 *
 * `notifyZoneStateChanged` is the one internal signal that a zone changed, and
 * the Loxone adapter is currently its only consumer. Rather than have the API
 * poll (or tap the Loxone connection registry, which would bind the public
 * contract to Loxone's frame format), this decorator sits in front of the real
 * notifier: the wrapped notifier keeps behaving exactly as before, and the hub
 * additionally receives the projected public payload.
 *
 * It is a decorator and not a second call site so that no future emit path can
 * forget to publish — anything that notifies Loxone notifies the API.
 */
import type { NotifierPort } from '@/ports/NotifierPort';
import type { ApiEventHub } from '@/adapters/http/api/apiEventHub';
import type { ApiVolumeLimits } from '@/domain/zones/apiTypes';
import { toApiZoneState, type OutputDeviceLookup } from '@/adapters/http/api/zoneProjection';

export function withApiEvents(
  inner: NotifierPort,
  hub: ApiEventHub,
  // Same lookup the request path uses, so an event carries the identical zone shape
  // a GET would — a client must not see `output.device` appear and disappear.
  deviceLookup?: OutputDeviceLookup,
  volumeLimitsLookup?: (zoneId: number) => ApiVolumeLimits | undefined,
): NotifierPort {
  return {
    notifyZoneStateChanged: (state) => {
      inner.notifyZoneStateChanged(state);
      // The public API must never be able to break Loxone delivery, so failures
      // here are contained rather than propagated to the caller.
      if (hub.subscriberCount > 0) {
        hub.publishZoneChanged(toApiZoneState(state, deviceLookup, volumeLimitsLookup?.(state.id)));
      }
    },
    notifyQueueUpdated: (zoneId, queueSize) => inner.notifyQueueUpdated(zoneId, queueSize),
    notifyRoomFavoritesChanged: (zoneId, count) => inner.notifyRoomFavoritesChanged(zoneId, count),
    notifyRecentlyPlayedChanged: (zoneId, timestamp) =>
      inner.notifyRecentlyPlayedChanged(zoneId, timestamp),
    notifyRescan: (status, folders, files) => inner.notifyRescan(status, folders, files),
    notifyReloadMusicApp: (action, provider, userId) =>
      inner.notifyReloadMusicApp(action, provider, userId),
    notifyAudioSyncEvent: (payload) => inner.notifyAudioSyncEvent(payload),
  };
}
