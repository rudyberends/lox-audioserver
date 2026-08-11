/**
 * The single fan-out point for public API events.
 *
 * Zone state has exactly one internal source (`NotifierPort.notifyZoneStateChanged`),
 * and this hub is the one place that turns it into the public contract. Every
 * outward transport — SSE today, a WebSocket or MQTT later — subscribes here
 * rather than tapping the notifier itself, so all of them are guaranteed to
 * publish the same payload.
 */
import type { ApiAudioFormat, ApiEvent, ApiZoneState } from '@/domain/zones/apiTypes';
import { createLogger } from '@/shared/logging/logger';

export type ApiEventSubscriber = (event: ApiEvent) => void;

/** What was last published for a zone, reduced to what it takes to classify the next one. */
type LastPublished = {
  position: number;
  /** The zone with its live readings neutralised — see `stateSignature`. */
  signature: string;
};

export class ApiEventHub {
  private readonly log = createLogger('Api', 'Events');
  private readonly subscribers = new Set<ApiEventSubscriber>();
  /** Last zone published per id, to tell a progress tick from a real change. */
  private readonly lastPublished = new Map<number, LastPublished>();

  /** Returns an unsubscribe function; callers must invoke it on disconnect. */
  public subscribe(subscriber: ApiEventSubscriber): () => void {
    this.subscribers.add(subscriber);
    this.log.debug('subscriber attached', { total: this.subscribers.size });
    return () => {
      if (this.subscribers.delete(subscriber)) {
        this.log.debug('subscriber detached', { total: this.subscribers.size });
      }
    };
  }

  public get subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Publishes a zone change, as a progress tick when the clock is the only thing that
   * moved and as the whole zone otherwise. A snapshot that says nothing new is not
   * published at all.
   *
   * The comparison is against the last zone we published, so a subscriber that joined
   * mid-track still got its full snapshot from `server.ready` first and can apply
   * every tick after it.
   */
  public publishZoneChanged(zone: ApiZoneState): void {
    const previous = this.lastPublished.get(zone.id);
    const signature = stateSignature(zone);
    this.lastPublished.set(zone.id, { position: zone.position, signature });
    if (previous?.signature === signature) {
      if (previous.position === zone.position) {
        // Nothing a subscriber can act on moved. The internal notifier is re-entered for
        // reasons that do not always change the projection — a 60 s heartbeat re-broadcast,
        // a field that only exists in the Loxone payload — and each of those used to cost a
        // full zone on every transport, MQTT republishing all ~27 of a zone's topics to say
        // the same thing twice.
        return;
      }
      this.publish({ type: 'zone.progress', id: zone.id, position: zone.position });
      return;
    }
    this.publish({ type: 'zone.changed', zone });
  }

  /**
   * Publishes a collection change — the queue, favourites or recents.
   *
   * Deliberately not deduplicated the way `publishZoneChanged` is. A zone's state is a value
   * that can be compared against the last one published; "the queue changed" is an event, and
   * two identical ones mean it changed twice.
   */
  public publishCollectionChanged(event: ApiEvent): void {
    this.publish(event);
  }

  private publish(event: ApiEvent): void {
    // Iterate a copy: a subscriber that fails and unsubscribes itself must not
    // mutate the set we are walking.
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(event);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn('subscriber threw, dropping it', { message });
        this.subscribers.delete(subscriber);
      }
    }
  }
}

/**
 * A zone reduced to the part of it that is *state*, serialised so two snapshots can be compared.
 *
 * Compared by serialising rather than field by field: cheaper to keep correct than a check that
 * silently stops covering a field somebody adds later. `position` is excluded because it is what
 * a progress tick carries; two snapshots with the same signature differ in nothing else.
 *
 * Everything neutralised here is a *reading* — a number this server measured about a stream in
 * flight, not something anybody set:
 *
 * - `output.sync`'s achieved lead, its floor and the drift change on every frame. What stays
 *   compared is the agreement: whether the device is locked to the clock, the delay configured for
 *   it, and the band the lead is held in. A change in any of those is a zone change and clients
 *   hear about it immediately.
 * - `format`'s bitrates are a throughput counter, re-averaged about once a second for every codec
 *   that is not PCM (PCM's is derived from its sample format and does not move). Leaving them in
 *   made a FLAC or MP3 output differ from itself on every tick, so the whole zone went out once a
 *   second and `zone.progress` never fired at all — sonn-audio/core#325. A genuine format change
 *   still shows up in the codec, rate, depth or channel count beside it.
 */
function stateSignature(zone: ApiZoneState): string {
  return JSON.stringify({
    ...zone,
    position: 0,
    ...(zone.output?.sync
      ? {
          output: {
            ...zone.output,
            sync: { ...zone.output.sync, leadMs: 0, leadMinMs: 0, driftMs: 0 },
          },
        }
      : {}),
    ...(zone.format ? { format: withoutMeasuredBitrate(zone.format) } : {}),
  });
}

function withoutMeasuredBitrate(format: ApiAudioFormat): ApiAudioFormat {
  return {
    ...format,
    source: format.source ? { ...format.source, bitrate: 0 } : null,
    output: format.output ? { ...format.output, bitrate: 0 } : null,
  };
}
