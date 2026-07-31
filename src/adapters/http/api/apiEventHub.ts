/**
 * The single fan-out point for public API events.
 *
 * Zone state has exactly one internal source (`NotifierPort.notifyZoneStateChanged`),
 * and this hub is the one place that turns it into the public contract. Every
 * outward transport — SSE today, a WebSocket or MQTT later — subscribes here
 * rather than tapping the notifier itself, so all of them are guaranteed to
 * publish the same payload.
 */
import type { ApiEvent, ApiZoneState } from '@/domain/zones/apiTypes';
import { createLogger } from '@/shared/logging/logger';

export type ApiEventSubscriber = (event: ApiEvent) => void;

export class ApiEventHub {
  private readonly log = createLogger('Api', 'Events');
  private readonly subscribers = new Set<ApiEventSubscriber>();
  /** Last zone published per id, to tell a progress tick from a real change. */
  private readonly lastPublished = new Map<number, ApiZoneState>();

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
   * moved and as the whole zone otherwise.
   *
   * The comparison is against the last zone we published, so a subscriber that joined
   * mid-track still got its full snapshot from `server.ready` first and can apply
   * every tick after it.
   */
  public publishZoneChanged(zone: ApiZoneState): void {
    const previous = this.lastPublished.get(zone.id);
    this.lastPublished.set(zone.id, zone);
    if (previous && onlyPositionMoved(previous, zone)) {
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
 * True when two snapshots of a zone differ in nothing but `position` and the live timing readings.
 *
 * Compared by serialising the rest: cheaper to keep correct than a field-by-field check that
 * silently stops covering a field somebody adds later.
 *
 * `output.sync`'s measurements — the achieved lead, its floor, the drift — are *readings*, not
 * state. They change on every frame, so counting them as a difference would turn every one-second
 * position tick into a full `zone.changed`, which is the exact traffic `zone.progress` exists to
 * avoid. What stays compared is the part that is genuinely state: whether the device is locked to
 * the clock, the delay configured for it, and the band the lead is held in. A change in any of those is
 * a zone change and clients hear about it immediately.
 */
function onlyPositionMoved(a: ApiZoneState, b: ApiZoneState): boolean {
  if (a.position === b.position) {
    return false;
  }
  const strip = (z: ApiZoneState): string =>
    JSON.stringify({
      ...z,
      position: 0,
      ...(z.output?.sync
        ? {
            output: {
              ...z.output,
              sync: { ...z.output.sync, leadMs: 0, leadMinMs: 0, driftMs: 0 },
            },
          }
        : {}),
    });
  return strip(a) === strip(b);
}
