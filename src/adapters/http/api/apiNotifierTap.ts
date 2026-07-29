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
import type { ApiEvent } from '@/domain/zones/apiTypes';
import type { ApiEventHub } from '@/adapters/http/api/apiEventHub';
import type { ApiVolumeLimits } from '@/domain/zones/apiTypes';
import {
  toApiZoneState,
  type OutputDeviceLookup,
  type OutputProtocolLookup,
  type ServiceLabelLookup,
  type InputLabelLookup,
  type ZoneProjectionLookups,
} from '@/adapters/http/api/zoneProjection';

export function withApiEvents(
  inner: NotifierPort,
  hub: ApiEventHub,
  // Same lookup the request path uses, so an event carries the identical zone shape
  // a GET would — a client must not see `output.device` appear and disappear.
  lookups: {
    device?: OutputDeviceLookup;
    outputProtocol?: OutputProtocolLookup;
    serviceLabel?: ServiceLabelLookup;
    inputLabel?: InputLabelLookup;
    streamFormat?: ZoneProjectionLookups['streamFormat'];
    volumeLimits?: (zoneId: number) => ApiVolumeLimits | undefined;
  } = {},
): NotifierPort {
  /**
   * Publishes to the hub without letting a failure reach the caller: the public API must
   * never be able to break Loxone delivery, which is why every publish here is guarded.
   */
  const publish = (event: ApiEvent): void => {
    if (hub.subscriberCount === 0) {
      return;
    }
    try {
      hub.publishCollectionChanged(event);
    } catch {
      /* a subscriber's failure is its own problem; the hub already drops it */
    }
  };

  return {
    notifyZoneStateChanged: (state) => {
      inner.notifyZoneStateChanged(state);
      // The public API must never be able to break Loxone delivery, so failures
      // here are contained rather than propagated to the caller.
      if (hub.subscriberCount > 0) {
        hub.publishZoneChanged(
          toApiZoneState(state, {
            device: lookups.device,
            outputProtocol: lookups.outputProtocol,
            serviceLabel: lookups.serviceLabel,
            inputLabel: lookups.inputLabel,
            streamFormat: lookups.streamFormat,
            volumeLimits: lookups.volumeLimits?.(state.id),
          }),
        );
      }
    },
    // These three were forwarded to Loxone and dropped here, so a client on our own API
    // could not tell that a queue, favourite or recents list had changed — including when
    // another client changed it. The Loxone protocol has carried them all along; the tap
    // simply passed them through without publishing.
    notifyQueueUpdated: (zoneId, queueSize) => {
      inner.notifyQueueUpdated(zoneId, queueSize);
      publish({ type: 'queue.changed', id: zoneId, size: queueSize });
    },
    notifyRoomFavoritesChanged: (zoneId, count) => {
      inner.notifyRoomFavoritesChanged(zoneId, count);
      publish({ type: 'favorites.changed', id: zoneId, count });
    },
    notifyRecentlyPlayedChanged: (zoneId, timestamp) => {
      inner.notifyRecentlyPlayedChanged(zoneId, timestamp);
      // The timestamp is Loxone's own change marker and says nothing a caller can use, so
      // only the zone travels: re-read the list.
      publish({ type: 'recents.changed', id: zoneId });
    },
    notifyRescan: (status, folders, files) => inner.notifyRescan(status, folders, files),
    notifyReloadMusicApp: (action, provider, userId) =>
      inner.notifyReloadMusicApp(action, provider, userId),
    notifyAudioSyncEvent: (payload) => inner.notifyAudioSyncEvent(payload),
  };
}
