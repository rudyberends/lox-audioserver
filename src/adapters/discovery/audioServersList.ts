import type { ConfigPort } from '@/ports/ConfigPort';
import type { SonnCorePeerRegistry } from '@/adapters/discovery/sonnCorePeerRegistry';
import type { ApiAudioServers } from '@/domain/zones/apiTypes';
import { normalizeMacId } from '@/shared/utils/mac';

export type AudioServerEntry = {
  macId: string;
  name: string | null;
  host: string | null;
  ip: string | null;
  port: number | null;
  uuid: string | null;
  master: string | null;
  isSelf: boolean;
  isSonnCore: boolean;
};

export type AudioServersList = {
  self: string | null;
  servers: AudioServerEntry[];
};

/**
 * Lists every audioserver the Miniserver knows about, parsed from rawAudioConfig.raw (an array of
 * objects keyed by MAC). The Miniserver pushes the whole site's config to each server, so this
 * includes peers, not just self. The `isSonnCore` flag is enriched from the mDNS peer
 * registry (which works independently of the Miniserver). The public and admin routes project
 * this same discovery data into their respective response contracts.
 */
export function buildAudioServersList(
  configPort: ConfigPort,
  sonnCorePeers: SonnCorePeerRegistry,
): AudioServersList {
  const cfg = configPort.getConfig();
  const selfMacId = normalizeMacId(cfg.system?.audioserver?.macId);
  const isSonnCore = (
    macId: string,
    host: string | null,
    ip: string | null,
  ): boolean =>
    (selfMacId != null && macId === selfMacId) || sonnCorePeers.has(macId, host, ip);
  const servers = parseAudioServers(
    cfg.rawAudioConfig?.raw ?? cfg.rawAudioConfig?.rawString,
    selfMacId,
    isSonnCore,
  );
  return { self: selfMacId, servers };
}

/** Parses rawAudioConfig.raw (array of single-key {<MAC>: section} objects) into a flat list. */
function parseAudioServers(
  raw: unknown,
  selfMacId: string | null,
  isSonnCore: (macId: string, host: string | null, ip: string | null) => boolean,
): AudioServerEntry[] {
  let parsed = raw;
  if (typeof parsed === 'string') {
    const trimmed = parsed.trim();
    if (!trimmed) return [];
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];

  const servers: AudioServerEntry[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const macId = normalizeMacId(key);
      if (!macId) continue;
      const section = value as Record<string, unknown>;
      servers.push({
        macId,
        name: normalizeString(section.name) ?? null,
        host: normalizeString(section.host) ?? null,
        ip: normalizeString(section.ip) ?? null,
        port: typeof section.port === 'number' ? section.port : Number(section.port) || null,
        uuid: normalizeString(section.uuid) ?? null,
        master: normalizeMacId(normalizeString(section.master)),
        isSelf: selfMacId != null && macId === selfMacId,
        isSonnCore: isSonnCore(
          macId,
          normalizeString(section.host) ?? null,
          normalizeString(section.ip) ?? null,
        ),
      });
    }
  }
  return servers;
}

/** Projects the installation-shaped discovery data onto the public API contract. */
export function buildPublicAudioServersList(
  configPort: ConfigPort,
  sonnCorePeers: SonnCorePeerRegistry,
): ApiAudioServers {
  const { self, servers } = buildAudioServersList(configPort, sonnCorePeers);
  return {
    selfId: self,
    servers: servers.map((server) => ({
      id: server.macId,
      name: server.name,
      host: server.host,
      self: server.isSelf,
      kind: server.isSonnCore ? 'sonn-core' : 'loxone',
    })),
  };
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
