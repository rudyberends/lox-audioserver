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
 * True when two snapshots of a zone differ in nothing but `position`. Compared by
 * serialising the rest: cheaper to keep correct than a field-by-field check that
 * silently stops covering a field somebody adds later.
 */
function onlyPositionMoved(a: ApiZoneState, b: ApiZoneState): boolean {
  if (a.position === b.position) {
    return false;
  }
  const strip = (z: ApiZoneState): string => JSON.stringify({ ...z, position: 0 });
  return strip(a) === strip(b);
}
