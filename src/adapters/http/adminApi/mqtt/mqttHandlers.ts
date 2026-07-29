import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ComponentLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { Route } from '@/adapters/http/adminApi/routeTypes';
import type { MqttPublisher } from '@/adapters/mqtt/mqttPublisher';
import { sanitizeTopicPrefix } from '@/domain/server/mqttTopics';

/** Bounds on the port, so a typo is refused rather than producing a dead connection. */
const PORT_MIN = 1;
const PORT_MAX = 65535;

export type MqttHandlerDeps = {
  log: ComponentLogger;
  configPort: ConfigPort;
  /** Absent when the runtime was built without a publisher; the routes then report disabled. */
  publisher?: MqttPublisher;
  readJsonBody: (req: IncomingMessage, res: ServerResponse, maxBytes?: number) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
};

type MqttConfigBody = {
  enabled?: unknown;
  host?: unknown;
  port?: unknown;
  protocol?: unknown;
  username?: unknown;
  password?: unknown;
  topicPrefix?: unknown;
  publishProgress?: unknown;
};

/**
 * Admin API for the MQTT publisher.
 *
 * `GET /mqtt/status` returns the config *plus* whether it is actually connected and what
 * went wrong if not. That matters more here than for most integrations: every other
 * setting in this server either works or is visibly absent, while a broker address can be
 * saved successfully and still never connect. Without the live state, a wrong password
 * looks exactly like a working setup.
 *
 * The password is never returned — only whether one is set. `POST /mqtt/config` therefore
 * treats an omitted password as "leave it alone", so saving the form after changing the
 * host does not silently blank the credentials.
 *
 * Saving applies immediately: the publisher reconnects to match the new config, so there
 * is no restart and no "changes take effect later" caveat to explain in the UI.
 */
export function buildMqttRoutes(deps: MqttHandlerDeps): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/mqtt\/status$/,
      handler: (_req, res) => handleStatus(res, deps),
    },
    {
      method: 'POST',
      pattern: /^\/mqtt\/config$/,
      handler: async (req, res) => handleConfigUpdate(req, res, deps),
    },
  ];
}

function handleStatus(res: ServerResponse, deps: MqttHandlerDeps): void {
  const cfg = deps.configPort.getConfig()?.mqtt ?? {};
  const live = deps.publisher?.status();
  deps.sendJson(res, 200, {
    enabled: cfg.enabled === true,
    host: cfg.host ?? '',
    port: cfg.port ?? null,
    protocol: cfg.protocol ?? 'mqtt',
    username: cfg.username ?? '',
    // Never the password itself; the UI only needs to know whether to show "set".
    hasPassword: Boolean(cfg.password),
    topicPrefix: sanitizeTopicPrefix(cfg.topicPrefix),
    publishProgress: cfg.publishProgress === true,
    // What is actually happening, which saved config alone cannot tell you.
    connected: live?.connected ?? false,
    lastError: live?.lastError ?? null,
    published: live?.published ?? 0,
  });
}

/** Parses a port, returning undefined for absent and null for "not a usable port". */
function parsePort(value: unknown): number | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === '') {
    return undefined;
  }
  const port = Number(value);
  if (!Number.isFinite(port) || port < PORT_MIN || port > PORT_MAX) {
    return null;
  }
  return Math.round(port);
}

async function handleConfigUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MqttHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res)) as MqttConfigBody | null;
  if (res.writableEnded) {
    return;
  }
  if (!body || typeof body !== 'object') {
    deps.sendJson(res, 400, { error: 'invalid-mqtt-payload' });
    return;
  }

  const port = parsePort(body.port);
  if (port === null) {
    deps.sendJson(res, 400, {
      error: 'invalid-port',
      message: `Port must be between ${PORT_MIN} and ${PORT_MAX}.`,
    });
    return;
  }
  if (body.protocol !== undefined && body.protocol !== 'mqtt' && body.protocol !== 'mqtts') {
    deps.sendJson(res, 400, { error: 'invalid-protocol' });
    return;
  }

  const host = body.host === undefined ? undefined : String(body.host).trim();
  const enabled = body.enabled === undefined ? undefined : body.enabled === true;

  // Enabling without a broker produces a publisher that can never connect, which then
  // shows up as a mysterious error rather than the missing field it is.
  const effectiveHost = host ?? deps.configPort.getConfig()?.mqtt?.host ?? '';
  if (enabled === true && !effectiveHost.trim()) {
    deps.sendJson(res, 400, {
      error: 'host-required',
      message: 'Enter the broker address before switching MQTT on.',
    });
    return;
  }

  await deps.configPort.updateConfig((cfg) => {
    const target = (cfg.mqtt ??= {});
    if (enabled !== undefined) target.enabled = enabled;
    if (host !== undefined) {
      if (host) target.host = host;
      else delete target.host;
    }
    if (port !== undefined) target.port = port;
    if (body.protocol !== undefined) target.protocol = body.protocol as 'mqtt' | 'mqtts';
    if (body.username !== undefined) {
      const username = String(body.username).trim();
      if (username) target.username = username;
      else delete target.username;
    }
    // Only touched when present, so saving the form after editing the host keeps the
    // existing password rather than clearing it.
    if (body.password !== undefined) {
      const password = String(body.password);
      if (password) target.password = password;
      else delete target.password;
    }
    if (body.topicPrefix !== undefined) {
      const prefix = sanitizeTopicPrefix(String(body.topicPrefix));
      target.topicPrefix = prefix;
    }
    if (body.publishProgress !== undefined) {
      target.publishProgress = body.publishProgress === true;
    }
  });

  // Reconnect to match what was just saved, before answering: the status this returns
  // then already reflects whether the new settings actually work.
  await deps.publisher?.sync().catch((error) => {
    deps.log.warn('mqtt sync failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  });

  deps.log.info('mqtt config updated', {
    enabled: deps.configPort.getConfig()?.mqtt?.enabled === true,
  });
  handleStatus(res, deps);
}
