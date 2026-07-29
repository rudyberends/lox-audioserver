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

  public publishZoneChanged(zone: ApiZoneState): void {
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
