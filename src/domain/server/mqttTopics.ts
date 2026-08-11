/**
 * The MQTT topic tree, derived from the public API model.
 *
 * Two shapes are published for every zone, because two kinds of consumer exist and
 * serving only one of them is what made integrators write their own bridge:
 *
 * - `<prefix>/zones/<id>` — the whole `ApiZoneState` as JSON, byte-identical to what an
 *   SSE client receives. One topic, one message per change, the full contract.
 * - `<prefix>/zones/<id>/<field>` — the same data flattened to scalars. A Loxone
 *   Miniserver, a KNX gateway or an MQTT-to-analog bridge subscribes to a topic and
 *   reads a number; asking it to parse JSON is asking it to do something it cannot.
 *
 * The flattened names are the API's own (`state`, `volume`, `track/title`), not
 * Loxone's (`mode`, `plrepeat`, `audiopath`). Mirroring Loxone here would freeze the
 * vocabulary we just removed from the internal state into a brand-new surface.
 *
 * Everything is published retained: a consumer that connects later must see current
 * state without waiting for the next change, which is exactly the gap that forced
 * polling in the first place.
 */
import type { ApiZoneState } from '@/domain/zones/apiTypes';

/** Fallback prefix, so two servers on one broker do not collide by default. */
export const DEFAULT_TOPIC_PREFIX = 'sonn';

/** One message to publish: a topic and its payload. */
export interface MqttMessage {
  topic: string;
  payload: string;
  retain: boolean;
}

/**
 * Strips characters MQTT reserves, so a configured prefix cannot break the tree.
 *
 * `#` and `+` are wildcards and `/` would silently add a level, which would put this
 * server's topics somewhere the admin UI does not claim they are.
 */
export function sanitizeTopicPrefix(prefix: string | undefined): string {
  const cleaned = (prefix ?? '').trim().replace(/[#+]/g, '').replace(/^\/+|\/+$/g, '');
  return cleaned || DEFAULT_TOPIC_PREFIX;
}

/**
 * The scalar view of a zone.
 *
 * Null and undefined become an empty string rather than the text "null": a consumer
 * reading this into a display field wants a blank, and one reading it into a number
 * wants something that parses as falsy. Booleans become `1`/`0` for the same reason —
 * an MQTT-to-digital bridge cannot do anything with the word "true".
 */
function flatten(zone: ApiZoneState): Record<string, string> {
  const flat: Record<string, string> = {
    state: zone.state,
    'power/state': zone.powerState.power,
    'power/target': zone.powerState.target,
    'power/managed': zone.powerState.managed ? '1' : '0',
    'power/idleTimeoutMs':
      zone.powerState.idleTimeoutMs == null ? '' : String(zone.powerState.idleTimeoutMs),
    position: String(zone.position),
    duration: String(zone.duration),
    volume: String(zone.volume),
    muted: zone.muted ? '1' : '0',
    repeat: zone.repeat,
    shuffle: zone.shuffle ? '1' : '0',
    name: zone.name,
    // Present even when there is no track, so a consumer's display clears on stop
    // instead of keeping whatever played last.
    'track/title': zone.track?.title ?? '',
    'track/artist': zone.track?.artist ?? '',
    'track/album': zone.track?.album ?? '',
    'track/coverUrl': zone.track?.coverUrl ?? '',
    'source/kind': zone.source?.kind ?? '',
    'source/name': zone.source?.name ?? '',
    'source/id': zone.source?.id ?? '',
    // Grouping as a scalar: the leader's id, and whether this zone is the leader.
    'group/leader': zone.group ? String(zone.group.leader) : '',
    'group/isLeader': zone.group?.leader === zone.id ? '1' : '0',
    'output/protocol': zone.output?.protocol ?? '',
    'output/device': zone.output?.device?.name ?? '',
  };
  return flat;
}

/** Every message describing one zone: the JSON document plus its scalar fields. */
export function zoneMessages(prefix: string, zone: ApiZoneState): MqttMessage[] {
  const base = `${prefix}/zones/${zone.id}`;
  const messages: MqttMessage[] = [
    { topic: base, payload: JSON.stringify(zone), retain: true },
  ];
  for (const [field, value] of Object.entries(flatten(zone))) {
    messages.push({ topic: `${base}/${field}`, payload: value, retain: true });
  }
  return messages;
}

/**
 * The position-only update, for when `publishProgress` is on.
 *
 * Only the scalar moves. The JSON document is deliberately left alone: rewriting a
 * ~550-byte retained payload every second per zone to advance a clock is the cost this
 * whole feature exists to avoid, and a consumer that wants the clock can read the
 * scalar. Not retained, for the same reason — a stale position is worse than none.
 */
export function progressMessages(prefix: string, zoneId: number, position: number): MqttMessage[] {
  return [
    { topic: `${prefix}/zones/${zoneId}/position`, payload: String(position), retain: false },
  ];
}

/**
 * The server's own liveness topic.
 *
 * Published as `1` on connect and registered as the MQTT will, so the broker publishes
 * `0` if this server dies without saying goodbye. The plugin's bridge already had such
 * a dead-man's switch for itself while the server it watched had none — the only way
 * anyone learned we had died was a five-minute cron grepping `docker ps`.
 */
export function availabilityTopic(prefix: string): string {
  return `${prefix}/server/online`;
}
