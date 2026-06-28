import type { ConfigPort } from '@/ports/ConfigPort';
import type { LoxAudioPeerRegistry } from '@/adapters/discovery/loxAudioPeerRegistry';

export type AudioServerEntry = {
  macId: string;
  name: string | null;
  host: string | null;
  ip: string | null;
  port: number | null;
  uuid: string | null;
  master: string | null;
  isSelf: boolean;
  // True when this server advertises itself as lox-audioserver over mDNS (i.e. runs our admin).
  // Real Loxone audioservers share the protocol but lack the service, so they come through false —
  // the player still lists them, the admin UI uses this to offer only switchable servers.
  isLoxAudioserver: boolean;
};

export type AudioServersList = {
  self: string | null;
  servers: AudioServerEntry[];
};

/**
 * Lists every audioserver the Miniserver knows about, parsed from rawAudioConfig.raw (an array of
 * objects keyed by MAC). The Miniserver pushes the whole site's config to each server, so this
 * includes peers, not just self. The `isLoxAudioserver` flag is enriched from the mDNS peer
 * registry (which works independently of the Miniserver). Shared by the admin HTTP route and the
 * `sonn/audioservers` command surface so both expose an identical list.
 */
export function buildAudioServersList(
  configPort: ConfigPort,
  loxAudioPeers: LoxAudioPeerRegistry,
): AudioServersList {
  const cfg = configPort.getConfig();
  const selfMacId = cfg.system?.audioserver?.macId?.trim().toUpperCase() ?? null;
  const isLoxAudioserver = (macId: string): boolean =>
    (selfMacId != null && macId === selfMacId) || loxAudioPeers.has(macId);
  const servers = parseAudioServers(
    cfg.rawAudioConfig?.raw ?? cfg.rawAudioConfig?.rawString,
    selfMacId,
    isLoxAudioserver,
  );
  return { self: selfMacId, servers };
}

/** Parses rawAudioConfig.raw (array of single-key {<MAC>: section} objects) into a flat list. */
function parseAudioServers(
  raw: unknown,
  selfMacId: string | null,
  isLoxAudioserver: (macId: string) => boolean,
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
      const macId = key.trim().toUpperCase();
      if (!macId) continue;
      const section = value as Record<string, unknown>;
      servers.push({
        macId,
        name: normalizeString(section.name) ?? null,
        host: normalizeString(section.host) ?? null,
        ip: normalizeString(section.ip) ?? null,
        port: typeof section.port === 'number' ? section.port : Number(section.port) || null,
        uuid: normalizeString(section.uuid) ?? null,
        master: normalizeString(section.master)?.toUpperCase() ?? null,
        isSelf: selfMacId != null && macId === selfMacId,
        isLoxAudioserver: isLoxAudioserver(macId),
      });
    }
  }
  return servers;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
