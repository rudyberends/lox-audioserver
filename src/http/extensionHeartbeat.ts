import { broadcastEvent } from './broadcastEvent';
import { config } from '../config/config';
import logger from '../utils/troxorlogger';
import { extractExtensions, ExtensionDescriptor } from './utils/extensions';

/**
 * Periodically pushes `hw_event` messages so the MiniServer sees the AudioServer core
 * and every configured extension as online.
 */
const HEARTBEAT_INTERVAL_MS = 60_000;
const RESET_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHANNELS_PER_EXTENSION = 2;

let heartbeatTimer: NodeJS.Timeout | null = null;
let heartbeatStart = Date.now();

function normaliseMacId(raw?: string): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/[^0-9a-f]/gi, '').toUpperCase();
}

/**
 * Emit the hardware status set the core AudioServer advertises in the legacy implementation.
 */
function buildBaseEvents(macId: string, uptimeSeconds: number) {
  return [
    { client_id: `${macId}#1`, event_id: 2005, value: 0 },
    { client_id: `${macId}#1`, event_id: 2101, value: 67 },
    { client_id: `${macId}#1`, event_id: 2100, value: 0 },
    { client_id: `${macId}#1`, event_id: 2102, value: 0 },
    { client_id: `${macId}#1`, event_id: 2103, value: 0 },
    { client_id: `${macId}#1`, event_id: 2105, value: uptimeSeconds },
    { client_id: `${macId}#1`, event_id: 2106, value: 56 },
  ];
}

/**
 * Craft the online/offline markers the MiniServer expects for each extension channel.
 */
function buildExtensionEvents(extensions: ExtensionDescriptor[], uptimeSeconds: number) {
  const events: Array<{ client_id: string; event_id: number; value: number }> = [];

  extensions.forEach((extension) => {
    const mac = normaliseMacId(extension.mac || extension.serial);
    if (!mac) return;
    for (let channel = 1; channel <= CHANNELS_PER_EXTENSION; channel += 1) {
      const clientId = `${mac}#${channel}`;
      events.push({ client_id: clientId, event_id: 2100, value: 0 });
      events.push({ client_id: clientId, event_id: 2101, value: 0 });
      events.push({ client_id: clientId, event_id: 2102, value: 0 });
      events.push({ client_id: clientId, event_id: 2103, value: 0 });
      events.push({ client_id: clientId, event_id: 2104, value: 1 });
      events.push({ client_id: clientId, event_id: 2105, value: uptimeSeconds });
    }
  });

  return events;
}

/**
 * Combine core and extension events into a single payload for broadcast.
 */
function computeHeartbeatPayload(uptimeSeconds: number) {
  const macId = normaliseMacId(config.audioserver?.macID || config.audioserver?.mac);
  const extensions = extractExtensions(config.audioserver?.musicCFG, config.audioserver?.macID);

  const events = [
    ...(macId ? buildBaseEvents(macId, uptimeSeconds) : []),
    ...buildExtensionEvents(extensions, uptimeSeconds),
  ];

  if (!events.length) {
    return null;
  }

  return {
    events,
    extensionCount: extensions.length,
  };
}

/**
 * Internal timer callback. Resets uptime every 24h to match the legacy strategy.
 */
function tickHeartbeat() {
  const now = Date.now();
  let delta = now - heartbeatStart;

  if (delta > RESET_INTERVAL_MS) {
    heartbeatStart = now;
    delta = 0;
  }

  const uptimeSeconds = Math.floor(delta / 1000);
  const payload = computeHeartbeatPayload(uptimeSeconds);
  if (!payload) return;

  const message = JSON.stringify({ hw_event: payload.events });
  broadcastEvent(message);
  logger.debug(
    `[ExtensionHeartbeat] Broadcast hw_event with ${payload.events.length} entries (${payload.extensionCount} extensions)`,
  );
}

/**
 * Start the periodic hardware heartbeat broadcast if it is not already running.
 */
export function startExtensionHeartbeat(): void {
  if (heartbeatTimer) return;

  heartbeatStart = Date.now();
  heartbeatTimer = setInterval(() => {
    try {
      tickHeartbeat();
    } catch (error) {
      logger.error(
        `[ExtensionHeartbeat] Failed to broadcast heartbeat: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Emit immediately to get the UI in sync as soon as the server boots.
  tickHeartbeat();
}

/**
 * Stop the heartbeat if one was previously created.
 */
export function stopExtensionHeartbeat(): void {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}
