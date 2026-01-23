import dgram from 'node:dgram';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';
import { createLogger } from '@/shared/logging/logger';

export interface DlnaEndpointInfo {
  controlUrl?: string;
  renderingControlUrl?: string;
  friendlyName?: string;
  descriptionUrl?: string;
}

export interface DlnaDiscoveredDevice {
  id: string;
  name?: string;
  host: string;
  address?: string;
  location: string;
  controlUrl?: string;
  renderingControlUrl?: string;
}

interface DiscoveryOptions {
  host?: string;
  timeoutMs?: number;
  mx?: number;
}

interface SsdpResponse {
  location: string;
  responder: string;
  usn?: string;
  st?: string;
}

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:MediaRenderer:1',
  'urn:schemas-upnp-org:service:AVTransport:1',
  'ssdp:all',
];
const log = createLogger('Transport', 'DLNADiscovery');

const endpointCache = new Map<string, Promise<DlnaEndpointInfo | null>>();
export function resolveDlnaEndpoints(options: DiscoveryOptions = {}): Promise<DlnaEndpointInfo | null> {
  const key = options.host?.toLowerCase() ?? '*';
  const cached = endpointCache.get(key);
  if (cached) {
    return cached;
  }
  const promise = discover(options).finally(() => {
    endpointCache.delete(key);
  });
  endpointCache.set(key, promise);
  return promise;
}

export async function discoverDlnaDevices(
  options: DiscoveryOptions = {},
): Promise<DlnaDiscoveredDevice[]> {
  const responses = await searchSsdp(options);
  const hostFilter = options.host?.toLowerCase();
  const devices: DlnaDiscoveredDevice[] = [];
  const seen = new Set<string>();
  for (const { location, responder, usn, st } of responses) {
    const stLower = (st ?? '').toLowerCase();
    if (
      stLower &&
      !stLower.includes('mediarenderer') &&
      !stLower.includes('avtransport') &&
      !stLower.startsWith('uuid:')
    ) {
      continue;
    }
    try {
      const description = await fetchWithTimeout(location, options.timeoutMs ?? 1500);
      const parsed = parseDeviceDescription(description, location);
      if (hostFilter && !matchesHost(hostFilter, location, responder, parsed.friendlyName)) {
        continue;
      }
      const id = (usn?.split('::')[0] ?? '').trim() || `${responder}|${location}`;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      const host =
        normalizeHost(responder) ||
        normalizeHost(new URL(location).hostname) ||
        normalizeHost(parsed.friendlyName ?? '') ||
        responder;
      devices.push({
        id,
        name: parsed.friendlyName?.trim(),
        host,
        address: responder,
        location,
        controlUrl: parsed.controlUrl,
        renderingControlUrl: parsed.renderingControlUrl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.debug('failed to parse device description', { location, message });
      if (hostFilter && !matchesHost(hostFilter, location, responder)) {
        continue;
      }
      const id = (usn?.split('::')[0] ?? '').trim() || `${responder}|${location}`;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      devices.push({
        id,
        host: responder,
        address: responder,
        location,
      });
    }
  }
  return devices;
}

async function discover(options: DiscoveryOptions): Promise<DlnaEndpointInfo | null> {
  const responses = await searchSsdp(options);
  const hostFilter = options.host?.toLowerCase();
  for (const { location, responder } of responses) {
    try {
      const description = await fetchWithTimeout(location, options.timeoutMs ?? 1500);
      const parsed = parseDeviceDescription(description, location);
      if (!parsed.controlUrl) {
        continue;
      }
      if (hostFilter && !matchesHost(hostFilter, location, responder, parsed.friendlyName)) {
        continue;
      }
      if (parsed.controlUrl) {
        log.debug('dlna endpoints discovered', { info: parsed });
        return { ...parsed, descriptionUrl: location };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.debug('failed to parse device description', { location, message });
    }
  }
  return null;
}

async function searchSsdp(options: DiscoveryOptions): Promise<SsdpResponse[]> {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const timeout = options.timeoutMs ?? 1500;
  const mx = Math.max(1, Math.min(5, options.mx ?? 2));
  const responses: SsdpResponse[] = [];
  const seen = new Set<string>();

  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(() => resolve());
  });

  const requests = SEARCH_TARGETS.map((target) => buildSearchRequest(mx, target));
  for (const request of requests) {
    socket.send(request, 0, request.length, SSDP_PORT, SSDP_ADDRESS);
  }

  const hostFilter = options.host?.trim();
  if (hostFilter) {
    for (const request of requests) {
      socket.send(request, 0, request.length, SSDP_PORT, hostFilter);
    }
  }

  socket.on('message', (msg, rinfo) => {
    try {
      const headers = parseSsdpResponse(msg.toString());
      const location = headers.location;
      if (!location) {
        return;
      }
      const key = `${rinfo.address}|${location}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      log.debug('ssdp response', {
        responder: rinfo.address,
        st: headers.st ?? headers.nt,
        location,
      });
      responses.push({
        location,
        responder: rinfo.address,
        usn: headers.usn,
        st: headers.st ?? headers.nt,
      });
    } catch (error) {
      log.debug('error parsing ssdp response', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await delay(timeout);
  socket.close();
  return responses;
}

function matchesHost(
  filter: string,
  location: string,
  responder: string,
  friendlyName?: string,
): boolean {
  const normalizedFilter = normalizeHost(filter);
  const locationHost = normalizeHost(new URL(location).hostname);
  const responderHost = normalizeHost(responder);
  if (normalizedFilter && (normalizedFilter === locationHost || normalizedFilter === responderHost)) {
    return true;
  }
  if (friendlyName) {
    const friendly = normalizeHost(friendlyName);
    if (
      friendly === normalizedFilter ||
      friendly.replace(/\s+/g, '') === normalizedFilter ||
      normalizedFilter.replace(/\s+/g, '') === friendly
    ) {
      return true;
    }
  }
  return false;
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
}

function buildSearchRequest(mx: number, target: string): Buffer {
  const payload = [
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    `MX: ${mx}`,
    `ST: ${target}`,
    '',
    '',
  ].join('\r\n');
  return Buffer.from(payload, 'utf-8');
}

function parseSsdpResponse(raw: string): Record<string, string> {
  const lines = raw.split(/\r?\n/);
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) {
      continue;
    }
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[key] = value;
  }
  return headers;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs).unref();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function parseDeviceDescription(xml: string, location: string): DlnaEndpointInfo {
  const services = extractServices(xml);
  const urlBase = extractTag(xml, 'URLBase');
  let base: URL;
  try {
    base = urlBase ? new URL(urlBase, location) : new URL(location);
  } catch {
    base = new URL(location);
  }
  const getUrl = (value?: string): string | undefined => {
    if (!value) {
      return undefined;
    }
    try {
      return new URL(value, base).toString();
    } catch {
      return undefined;
    }
  };
  const avTransport = selectService(services, 'avtransport');
  const rendering = selectService(services, 'renderingcontrol');
  return {
    friendlyName: extractTag(xml, 'friendlyName'),
    controlUrl: getUrl(avTransport?.controlUrl),
    renderingControlUrl: getUrl(rendering?.controlUrl),
  };
}

interface ServiceEntry {
  type: string;
  controlUrl: string;
}

function extractServices(xml: string): ServiceEntry[] {
  const map: ServiceEntry[] = [];
  const serviceRegex = /<(?:\w+:)?service>([\s\S]*?)<\/(?:\w+:)?service>/gi;
  let match: RegExpExecArray | null;
  while ((match = serviceRegex.exec(xml)) !== null) {
    const block = match[1];
    const type = extractTag(block, 'serviceType');
    const control = extractTag(block, 'controlURL');
    if (type && control) {
      map.push({ type: type.trim(), controlUrl: control.trim() });
    }
  }
  return map;
}

function selectService(services: ServiceEntry[], keyword: string): ServiceEntry | undefined {
  const target = keyword.toLowerCase();
  return services.find(({ type }) => type.toLowerCase().includes(target));
}

function extractTag(block: string, tag: string): string | undefined {
  const regex = new RegExp(`<(?:\\w+:)?${tag}>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, 'i');
  const match = block.match(regex);
  return match?.[1]?.trim();
}
