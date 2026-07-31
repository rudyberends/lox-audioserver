import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ComponentLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { SonnClientApiHandler } from '@/adapters/http/sonnClientApi/sonnClientApiHandler';
import type { Route } from '@/adapters/http/adminApi/routeTypes';
import type {
  SonnClientBeoremoteConfig,
  SonnClientDeviceConfig,
  SonnClientPlayerConfig,
  SonnClientSourceConfig,
} from '@/domain/config/types';

/**
 * Auth-gated views and edits for devices running Sonn Client.
 *
 * The device-facing half (register, status, desired state) stays under the ungated
 * `/api/sonnclients` namespace where a speaker — which has no admin session — can reach it. What is
 * here is the other direction: the UI reads what registered and writes what it should be.
 *
 * Zones are deliberately untouched. A Sonn client's player is an ordinary Sendspin output, so
 * assigning a room happens on the Zones screen against a `client_id` this screen created.
 */

export type SonnClientAdminHandlerDeps = {
  log: ComponentLogger;
  configPort: ConfigPort;
  sonnClientApi: SonnClientApiHandler;
  readJsonBody: (req: IncomingMessage, res: ServerResponse, maxBytes?: number) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
};

/** Commands a device will act on itself. Anything else is refused rather than queued forever. */
const DEVICE_COMMANDS = new Set(['pair_remote']);

export function buildSonnClientRoutes(deps: SonnClientAdminHandlerDeps): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/sonnclients$/,
      handler: (_req, res) => {
        try {
          deps.sendJson(res, 200, {
            devices: deps.sonnClientApi.listForAdmin(),
            components: deps.configPort.getConfig().sonnClients?.components ?? [],
            pollIntervalMs: deps.configPort.getConfig().sonnClients?.pollIntervalMs,
          });
        } catch (err) {
          deps.log.warn('sonn client list failed', { err });
          deps.sendJson(res, 500, { error: 'sonnclients-failed' });
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/sonnclients\/([^/]+)$/,
      handler: (_req, res, match) => {
        const deviceId = decodeURIComponent(match[1] ?? '').trim();
        if (!deviceId) {
          deps.sendJson(res, 400, { error: 'missing-device-id' });
          return;
        }
        if (!deps.sonnClientApi.isKnown(deviceId)) {
          deps.sendJson(res, 404, { error: 'device-not-found' });
          return;
        }
        deps.sendJson(res, 200, deps.sonnClientApi.viewForAdmin(deviceId));
      },
    },
    {
      method: 'PUT',
      pattern: /^\/sonnclients\/([^/]+)$/,
      handler: async (req, res, match) => {
        const deviceId = decodeURIComponent(match[1] ?? '').trim();
        if (!deviceId) {
          deps.sendJson(res, 400, { error: 'missing-device-id' });
          return;
        }
        const body = await deps.readJsonBody(req, res);
        if (!body || typeof body !== 'object') {
          deps.sendJson(res, 400, { error: 'invalid-body' });
          return;
        }

        let update: Partial<SonnClientDeviceConfig>;
        try {
          update = sanitizeDevice(body as Record<string, unknown>);
        } catch (err) {
          deps.sendJson(res, 400, { error: err instanceof Error ? err.message : 'invalid-body' });
          return;
        }

        try {
          await deps.configPort.updateConfig((config) => {
            config.sonnClients = config.sonnClients ?? {};
            config.sonnClients.devices = config.sonnClients.devices ?? [];
            const devices = config.sonnClients.devices;
            const index = devices.findIndex((device) => device.deviceId === deviceId);
            const existing = index >= 0 ? devices[index] : { deviceId };
            // A partial update: the identity fields the device itself writes (hostname, ip, model)
            // are never in the body, so they survive an edit that only renames a player.
            const merged: SonnClientDeviceConfig = { ...existing, ...update, deviceId };
            if (index >= 0) {
              devices[index] = merged;
            } else {
              devices.push(merged);
            }
          });
        } catch (err) {
          deps.log.warn('sonn client update failed', { err, deviceId });
          deps.sendJson(res, 500, { error: 'sonnclient-update-failed' });
          return;
        }

        deps.log.info('sonn client configured', {
          deviceId,
          players: update.players?.length ?? 0,
          sources: update.sources?.length ?? 0,
          beoremoteZone: update.beoremote?.zoneId,
        });
        deps.sendJson(res, 200, deps.sonnClientApi.viewForAdmin(deviceId));
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/sonnclients\/([^/]+)$/,
      handler: async (_req, res, match) => {
        const deviceId = decodeURIComponent(match[1] ?? '').trim();
        if (!deviceId) {
          deps.sendJson(res, 400, { error: 'missing-device-id' });
          return;
        }
        // Forgetting a device that a zone still points at would leave that room silent with no
        // indication why, so the zone has to be repointed first.
        const assigned = assignedClientIds(deps);
        const claimed = deps.sonnClientApi
          .clientIdsFor(deviceId)
          .filter((clientId) => assigned.has(clientId));
        if (claimed.length) {
          deps.sendJson(res, 409, { error: 'device-in-use', clientIds: claimed });
          return;
        }
        try {
          await deps.sonnClientApi.forget(deviceId);
        } catch (err) {
          deps.log.warn('sonn client delete failed', { err, deviceId });
          deps.sendJson(res, 500, { error: 'sonnclient-delete-failed' });
          return;
        }
        res.writeHead(204);
        res.end();
      },
    },
    {
      method: 'POST',
      pattern: /^\/sonnclients\/([^/]+)\/commands$/,
      handler: async (req, res, match) => {
        const deviceId = decodeURIComponent(match[1] ?? '').trim();
        if (!deviceId) {
          deps.sendJson(res, 400, { error: 'missing-device-id' });
          return;
        }
        if (!deps.sonnClientApi.isKnown(deviceId)) {
          deps.sendJson(res, 404, { error: 'device-not-found' });
          return;
        }
        const body = (await deps.readJsonBody(req, res)) as
          | { command?: unknown; args?: unknown }
          | null;
        const command = typeof body?.command === 'string' ? body.command.trim() : '';
        if (!DEVICE_COMMANDS.has(command)) {
          deps.sendJson(res, 400, {
            error: 'unsupported-command',
            supported: [...DEVICE_COMMANDS],
          });
          return;
        }
        const args = Array.isArray(body?.args)
          ? body!.args!.filter((arg): arg is string => typeof arg === 'string')
          : [];
        deps.sonnClientApi.queueCommand(deviceId, command, args);
        // Accepted, not done: the device picks it up on its next poll and reports the outcome in
        // its status, which is where the UI should look for the result.
        deps.sendJson(res, 202, { ok: true, command, args });
      },
    },
  ];
}

/**
 * Sendspin client ids something in the config currently points at.
 *
 * A zone's output, the satellites listening alongside it, and any line-in input fed by a Sendspin
 * source. All three would break silently if the device behind the id were forgotten, and a room that
 * has gone quiet for no visible reason is the failure this check exists to prevent.
 */
function assignedClientIds(deps: SonnClientAdminHandlerDeps): Set<string> {
  const assigned = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) {
      assigned.add(value.trim());
    }
  };

  for (const zone of deps.configPort.getConfig().zones ?? []) {
    for (const output of [zone.output, ...(zone.transports ?? [])]) {
      if (!output) {
        continue;
      }
      const record = output as Record<string, unknown>;
      add(record.clientId);
      for (const satellite of asArray(record.satellites)) {
        // Satellites are either bare client ids or objects carrying one.
        add(typeof satellite === 'string' ? satellite : asRecord(satellite).clientId);
      }
    }
  }

  for (const input of deps.configPort.getConfig().inputs?.lineIn?.inputs ?? []) {
    const source = asRecord((input as Record<string, unknown>).source);
    if (String(source.type ?? '').toLowerCase() !== 'sendspin') {
      continue;
    }
    add(source.clientId);
    add(source.client_id);
  }
  return assigned;
}

function sanitizeDevice(body: Record<string, unknown>): Partial<SonnClientDeviceConfig> {
  const update: Partial<SonnClientDeviceConfig> = {};
  if ('name' in body) {
    update.name = optionalString(body.name);
  }
  if ('enabled' in body) {
    update.enabled = body.enabled !== false;
  }
  if ('players' in body) {
    update.players = sanitizePlayers(body.players);
  }
  if ('sources' in body) {
    update.sources = sanitizeSources(body.sources);
  }
  if ('beoremote' in body) {
    update.beoremote = sanitizeBeoremote(body.beoremote);
  }
  if ('requiredComponents' in body) {
    update.requiredComponents = asArray(body.requiredComponents)
      .map((entry) => optionalString(entry))
      .filter((entry): entry is string => !!entry);
  }
  return update;
}

function sanitizePlayers(value: unknown): SonnClientPlayerConfig[] {
  const seen = new Set<string>();
  return asArray(value).map((raw) => {
    const entry = asRecord(raw);
    const clientId = optionalString(entry.clientId);
    if (!clientId) {
      throw new Error('player-missing-client-id');
    }
    // Two players on one id would have the device open two connections claiming to be the same
    // client, and the server would treat the second as a reconnect of the first.
    if (seen.has(clientId)) {
      throw new Error('duplicate-client-id');
    }
    seen.add(clientId);
    return {
      clientId,
      name: optionalString(entry.name),
      output: optionalString(entry.output),
      enabled: entry.enabled === undefined ? undefined : entry.enabled !== false,
      delayMs: optionalNumber(entry.delayMs, 0, 5_000),
      volume: optionalNumber(entry.volume, 0, 100),
      muted: entry.muted === undefined ? undefined : entry.muted === true,
      volumeHook: optionalString(entry.volumeHook),
      codecs: asArray(entry.codecs)
        .map((codec) => optionalString(codec))
        .filter((codec): codec is string => !!codec),
      sampleRate: optionalNumber(entry.sampleRate, 8_000, 384_000),
      bitDepth: optionalNumber(entry.bitDepth, 8, 32),
      channels: optionalNumber(entry.channels, 1, 8),
      bufferMs: optionalNumber(entry.bufferMs, 0, 30_000),
      requiredLeadTimeMs: optionalNumber(entry.requiredLeadTimeMs, 0, 30_000),
    } satisfies SonnClientPlayerConfig;
  });
}

function sanitizeSources(value: unknown): SonnClientSourceConfig[] {
  const seen = new Set<string>();
  return asArray(value).map((raw) => {
    const entry = asRecord(raw);
    const clientId = optionalString(entry.clientId);
    if (!clientId) {
      throw new Error('source-missing-client-id');
    }
    if (seen.has(clientId)) {
      throw new Error('duplicate-client-id');
    }
    seen.add(clientId);
    return {
      clientId,
      name: optionalString(entry.name),
      input: optionalString(entry.input),
      enabled: entry.enabled === undefined ? undefined : entry.enabled !== false,
      sampleRate: optionalNumber(entry.sampleRate, 8_000, 384_000),
      bitDepth: optionalNumber(entry.bitDepth, 8, 32),
      channels: optionalNumber(entry.channels, 1, 8),
      frameMs: optionalNumber(entry.frameMs, 5, 200),
      thresholdDb: optionalNumber(entry.thresholdDb, -120, 0),
      holdMs: optionalNumber(entry.holdMs, 0, 60_000),
      controls: asArray(entry.controls)
        .map((control) => optionalString(control))
        .filter((control): control is string => !!control),
      controlHook: optionalString(entry.controlHook),
      alwaysOn: entry.alwaysOn === undefined ? undefined : entry.alwaysOn === true,
    } satisfies SonnClientSourceConfig;
  });
}

function sanitizeBeoremote(value: unknown): SonnClientBeoremoteConfig | null {
  if (value === null) {
    return null;
  }
  const entry = asRecord(value);
  const enabled = entry.enabled === true;
  const zoneId = optionalNumber(entry.zoneId, 1, Number.MAX_SAFE_INTEGER);
  if (enabled && zoneId === undefined) {
    // Without a zone there is nothing to render on the remote and nothing for its keys to act on.
    throw new Error('beoremote-missing-zone');
  }
  return {
    enabled,
    zoneId,
    menuPollMs: optionalNumber(entry.menuPollMs, 2_000, 300_000),
    volumePlayer: optionalString(entry.volumePlayer),
    volumeStep: optionalNumber(entry.volumeStep, 1, 50),
  };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function optionalNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(max, Math.max(min, value));
}
