/**
 * Parsing inbound MQTT into zone commands.
 *
 * Publishing state was only half the job: a consumer that wanted to *do* something still
 * had to fall back to HTTP, so an MQTT-only integration could watch but not touch. The
 * plugin's own bridge never subscribes to anything, which is exactly that gap.
 *
 * Two accepted shapes, mirroring the state tree for the same reason it has two:
 * - `<prefix>/zones/<id>/set/<field>` with a bare value, for a Miniserver or KNX bridge
 *   that can write a number to a topic and nothing more.
 * - `<prefix>/zones/<id>/cmd` with a JSON object, for anything that needs more than one
 *   value at once — `play` with a uri has nowhere to put the uri otherwise.
 *
 * Deliberately pure: it turns a topic and a payload into commands, or into a reason it
 * refused. Nothing here touches a broker or a zone, so the mapping is testable on its own
 * and MQTT cannot drift from the HTTP verbs it shares.
 */

/** A resolved command, in the vocabulary `ZoneManager.handleCommand` already speaks. */
export interface ZoneCommand {
  zoneId: number;
  command: string;
  payload?: string;
}

/**
 * Starting content is not a `handleCommand` verb — it goes through `playContent`, which
 * resolves the uri and rebuilds the queue — so it is kept separate rather than smuggled in
 * as a command with a magic payload.
 */
export interface ZonePlay {
  zoneId: number;
  uri: string;
}

export type MqttCommandResult =
  | { kind: 'commands'; zoneId: number; commands: ZoneCommand[]; play?: ZonePlay }
  | { kind: 'ignored'; reason: string }
  | { kind: 'error'; reason: string };

/** The topics to subscribe to, given a prefix. */
export function commandTopicFilters(prefix: string): string[] {
  return [`${prefix}/zones/+/set/+`, `${prefix}/zones/+/cmd`];
}

type ParsedTopic =
  | { kind: 'set'; zoneId: number; field: string }
  | { kind: 'cmd'; zoneId: number }
  | null;

function parseTopic(prefix: string, topic: string): ParsedTopic {
  if (!topic.startsWith(`${prefix}/`)) {
    return null;
  }
  const parts = topic.slice(prefix.length + 1).split('/');
  if (parts[0] !== 'zones' || !parts[1] || !/^\d+$/.test(parts[1])) {
    return null;
  }
  const zoneId = Number(parts[1]);
  if (parts.length === 3 && parts[2] === 'cmd') {
    return { kind: 'cmd', zoneId };
  }
  if (parts.length === 4 && parts[2] === 'set' && parts[3]) {
    return { kind: 'set', zoneId, field: parts[3] };
  }
  return null;
}

function clampInt(value: unknown, min: number, max: number): number | null {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(n)) {
    return null;
  }
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** `1`/`true`/`on`/`yes` and their opposites, since a scalar bridge writes whichever. */
function parseBool(raw: string): boolean | null {
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(value)) return true;
  if (['0', 'false', 'off', 'no'].includes(value)) return false;
  return null;
}

/**
 * A single field write, shared by both shapes so `set/volume` and `{"volume":…}` cannot
 * diverge. Returns null when the field is unknown, a string when the value is wrong.
 */
function fieldCommand(
  zoneId: number,
  field: string,
  raw: unknown,
): ZoneCommand[] | string | null {
  const text = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
  switch (field) {
    case 'volume': {
      // A leading sign means relative, matching the HTTP `{delta}` form: every physical
      // remote steps relatively, and read-then-write would race with itself.
      if (/^[+-]\d+$/.test(text)) {
        const delta = clampInt(text, -100, 100);
        return delta === null
          ? 'invalid-volume'
          : [{ zoneId, command: 'volume', payload: delta >= 0 ? `+${delta}` : `${delta}` }];
      }
      const volume = clampInt(text, 0, 100);
      return volume === null
        ? 'invalid-volume'
        : [{ zoneId, command: 'volume', payload: String(volume) }];
    }
    case 'muted': {
      const on = parseBool(text);
      // An empty payload toggles — a wall button wired to a topic has no value to send.
      if (on === null) {
        return text === '' || text.toLowerCase() === 'toggle'
          ? [{ zoneId, command: 'mute', payload: 'toggle' }]
          : 'invalid-muted';
      }
      return [{ zoneId, command: 'mute', payload: on ? '1' : '0' }];
    }
    case 'state': {
      // The values this publishes on `state`, so what you read is what you can write.
      const map: Record<string, string> = {
        playing: 'play',
        play: 'play',
        paused: 'pause',
        pause: 'pause',
        stopped: 'off',
        stop: 'off',
      };
      const command = map[text.toLowerCase()];
      return command ? [{ zoneId, command }] : 'invalid-state';
    }
    case 'power': {
      const on = parseBool(text);
      if (on !== null) return [{ zoneId, command: on ? 'on' : 'off' }];
      return text === 'on' || text === 'off'
        ? [{ zoneId, command: text }]
        : 'invalid-power';
    }
    case 'position': {
      const position = clampInt(text, 0, Number.MAX_SAFE_INTEGER);
      return position === null
        ? 'invalid-position'
        : [{ zoneId, command: 'position', payload: String(position) }];
    }
    case 'repeat': {
      const value = text.toLowerCase();
      return value === 'off' || value === 'all' || value === 'one'
        ? [{ zoneId, command: 'repeat', payload: value }]
        : 'invalid-repeat';
    }
    case 'shuffle': {
      const on = parseBool(text);
      return on === null
        ? 'invalid-shuffle'
        : [{ zoneId, command: 'shuffle', payload: on ? 'on' : 'off' }];
    }
    case 'next':
      return [{ zoneId, command: 'queueplus' }];
    case 'previous':
      return [{ zoneId, command: 'queueminus' }];
    default:
      return null;
  }
}

/** The order commands are applied in when one message carries several. */
const CMD_ORDER = [
  'power',
  'volume',
  // After volume: `{"volume":40,"muted":true}` reads as "set the level, then silence it",
  // and the other order would have the volume write clear the mute it just asked for.
  'muted',
  'repeat',
  'shuffle',
  'position',
  'state',
  'next',
  'previous',
];

/**
 * Interprets one received message.
 *
 * `retained` does *not* mean "the publisher asked for retention". MQTT delivers a live
 * message with the flag clear even when it was published retained, and sets it only when
 * replaying a stored message to a subscriber that just connected. So the flag means exactly
 * "you are being handed an old command because you subscribed", which must never be obeyed:
 * the zone would snap back to it after every reconnect and appear to change by itself.
 * Verified against Mosquitto 2.0.18 — reading the flag the other way is a silent mistake.
 *
 * Refusing is necessary but not sufficient: the message stays on the broker and returns on
 * the next reconnect, so the caller also clears it. See MqttPublisher.applyCommand.
 */
export function parseMqttCommand(
  prefix: string,
  topic: string,
  payload: string,
  retained: boolean,
): MqttCommandResult {
  const parsed = parseTopic(prefix, topic);
  if (!parsed) {
    return { kind: 'ignored', reason: 'not-a-command-topic' };
  }
  if (retained) {
    return { kind: 'ignored', reason: 'retained-command' };
  }

  if (parsed.kind === 'set') {
    // `play` needs a uri, which is the whole payload here rather than a JSON field.
    if (parsed.field === 'play') {
      const uri = payload.trim();
      return uri
        ? { kind: 'commands', zoneId: parsed.zoneId, commands: [], play: { zoneId: parsed.zoneId, uri } }
        : { kind: 'error', reason: 'invalid-uri' };
    }
    const result = fieldCommand(parsed.zoneId, parsed.field, payload);
    if (result === null) {
      return { kind: 'ignored', reason: `unknown-field:${parsed.field}` };
    }
    if (typeof result === 'string') {
      return { kind: 'error', reason: result };
    }
    return { kind: 'commands', zoneId: parsed.zoneId, commands: result };
  }

  let body: Record<string, unknown>;
  try {
    const decoded: unknown = JSON.parse(payload);
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      return { kind: 'error', reason: 'invalid-json' };
    }
    body = decoded as Record<string, unknown>;
  } catch {
    return { kind: 'error', reason: 'invalid-json' };
  }

  const commands: ZoneCommand[] = [];
  let play: ZonePlay | undefined;

  if (body.play !== undefined) {
    const uri = typeof body.play === 'string' ? body.play.trim() : '';
    if (!uri) {
      return { kind: 'error', reason: 'invalid-uri' };
    }
    play = { zoneId: parsed.zoneId, uri };
  }

  // Ordered, not as written: `{"power":"on","volume":40}` has to power on before the
  // volume lands, and object key order is not something a publisher should have to think
  // about. Applying `state` late means `{"play":…,"state":"playing"}` does not fight itself.
  for (const field of CMD_ORDER) {
    if (body[field] === undefined) {
      continue;
    }
    const result = fieldCommand(parsed.zoneId, field, body[field]);
    if (result === null) {
      continue;
    }
    if (typeof result === 'string') {
      return { kind: 'error', reason: result };
    }
    commands.push(...result);
  }

  if (!commands.length && !play) {
    return { kind: 'ignored', reason: 'nothing-to-do' };
  }
  return { kind: 'commands', zoneId: parsed.zoneId, commands, play };
}
