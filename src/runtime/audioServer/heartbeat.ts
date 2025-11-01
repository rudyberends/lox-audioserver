import logger from '@/utils/troxorLogger';
import { broadcastMessage } from '@/http/loxoneHttp/websocketManager';
import { audioServerRuntime } from '@/runtime/audioServer';
import { configManager } from '@/runtime/config';
import type { ExtensionDescriptor } from './utils/audioExtensions';

/**
 * Periodically emits `hw_event` messages via WebSocket so Loxone clients
 * detect the AudioServer core and all extensions as online.
 */
const heartbeatIntervalMs = 300_000; // 5 minutes
const resetIntervalMs = 24 * 60 * 60 * 1000; // 24 hours
const channelsPerExtension = 2;

let heartbeatTimer: NodeJS.Timeout | null = null;
let heartbeatStart = Date.now();

/** Represents a single hardware event emitted in a heartbeat. */
interface HeartbeatEvent {
  client_id: string;
  event_id: number;
  value: number;
}

/** Normalizes a MAC address into uppercase hexadecimal without delimiters. */
function normalizeMacId(raw?: string): string | undefined {
  if (!raw || typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed.replace(/[^0-9a-f]/gi, '').toUpperCase() : undefined;
}

/** Generates the core AudioServer heartbeat events. */
function buildBaseEvents(macId: string, uptimeSeconds: number): HeartbeatEvent[] {
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

/** Generates heartbeat events for all detected extensions. */
function buildExtensionEvents(extensions: ExtensionDescriptor[], uptimeSeconds: number) {
  const events: Array<{ client_id: string; event_id: number; value: number }> = [];

  for (const extension of extensions) {
    const mac = normalizeMacId(extension.mac || extension.serial);
    if (!mac) {
      continue;
    }

    for (let channel = 1; channel <= channelsPerExtension; channel++) {
      const client_id = `${mac}#${channel}`;
      events.push(
        { client_id, event_id: 2100, value: 0 },
        { client_id, event_id: 2101, value: 0 },
        { client_id, event_id: 2102, value: 0 },
        { client_id, event_id: 2103, value: 0 },
        { client_id, event_id: 2104, value: 1 },
        { client_id, event_id: 2105, value: uptimeSeconds },
      );
    }
  }

  return events;
}

/** Combines base and extension events into a single payload. */
function computeHeartbeatPayload(macId: string, extensions: ExtensionDescriptor[], uptimeSeconds: number): HeartbeatEvent[] {
  return [...buildBaseEvents(macId, uptimeSeconds), ...buildExtensionEvents(extensions, uptimeSeconds)];
}

/** Sends a single heartbeat broadcast tick. */
function tickHeartbeat(): void {
  const cfg = configManager.getAudioServerConfig();
  if (!cfg?.paired || !cfg.macId) {
    logger.debug('[ServerHeartbeat] Skipped tick (no paired AudioServer)');
    return;
  }

  const macId = normalizeMacId(cfg.macId);
  if (!macId) {
    return;
  }

  const extensions = [...audioServerRuntime.getExtensions()];
  const now = Date.now();
  let delta = now - heartbeatStart;

  if (delta > resetIntervalMs) {
    heartbeatStart = now;
    delta = 0;
  }

  const uptimeSeconds = Math.floor(delta / 1000);
  const events = computeHeartbeatPayload(macId, extensions, uptimeSeconds);
  if (!events.length) {
    return;
  }

  broadcastMessage(JSON.stringify({ hw_event: events }));
  logger.debug(`[ServerHeartbeat] Broadcast hw_event (${events.length} total across ${extensions.length} extensions)`);
}

/** Starts the periodic WebSocket heartbeat broadcast. */
export function startServerHeartbeat(): void {
  if (heartbeatTimer) {
    logger.debug('[ServerHeartbeat] Already running');
    return;
  }

  heartbeatStart = Date.now();
  heartbeatTimer = setInterval(() => {
    try {
      tickHeartbeat();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[ServerHeartbeat] Failed to broadcast heartbeat: ${message}`);
    }
  }, heartbeatIntervalMs);

  // Emit immediately on startup
  tickHeartbeat();
  logger.info('[ServerHeartbeat] Started heartbeat timer');
}

/** Stops the heartbeat broadcast if active. */
export function stopServerHeartbeat(): void {
  if (!heartbeatTimer) {
    return;
  }
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  logger.info('[ServerHeartbeat] Stopped heartbeat timer');
}