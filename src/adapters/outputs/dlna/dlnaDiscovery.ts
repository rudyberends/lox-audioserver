import dgram from 'node:dgram';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';
import { createLogger } from '@/shared/logging/logger';

export interface DlnaEndpointInfo {
  controlUrl?: string;
  renderingControlUrl?: string;
  /** GENA event subscription endpoint for AVTransport (transport state / track changes). */
  avTransportEventUrl?: string;
  /** GENA event subscription endpoint for RenderingControl (volume / mute). */
  renderingControlEventUrl?: string;
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

// Some renderers (notably a few B&O/Samsung models) answer SSDP unreliably, so a single scan
// randomly misses them. We remember devices seen recently and merge them back in, so a device
// that was visible moments ago doesn't flicker out of the list on one dropped burst.
const RECENT_DEVICE_TTL_MS = 90_000;
const recentDevices = new Map<string, { device: DlnaDiscoveredDevice; lastSeen: number }>();

function pruneRecentDevices(now: number): void {
  for (const [id, entry] of recentDevices) {
    if (now - entry.lastSeen > RECENT_DEVICE_TTL_MS) {
      recentDevices.delete(id);
    }
  }
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

  // A host-scoped probe is a targeted lookup, not a "browse everything" — don't let it
  // touch the recent-device cache (it would only ever hold the one device).
  if (hostFilter) {
    return devices;
  }

  const now = Date.now();
  pruneRecentDevices(now);
  // Refresh the cache with everything we saw this round.
  for (const device of devices) {
    recentDevices.set(device.id, { device, lastSeen: now });
  }
  // Merge back any recently-seen device that this particular scan happened to miss.
  for (const [id, entry] of recentDevices) {
    if (!seen.has(id)) {
      seen.add(id);
      devices.push(entry.device);
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
  // SSDP over UDP multicast is lossy and renderers answer spread randomly across the MX
  // window, so a single burst reliably misses devices (and misses different ones each run).
  // We keep the socket open for the whole window, re-send the M-SEARCH bursts a few times,
  // and only close once the window has fully elapsed (>= MX so late responders still land).
  const mx = Math.max(1, Math.min(5, options.mx ?? 2));
  const totalWindowMs = Math.max(options.timeoutMs ?? 4000, mx * 1000 + 500);
  const responses: SsdpResponse[] = [];
  const seen = new Set<string>();

  // Register the listener BEFORE binding/sending so fast responders can't answer into a void.
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

  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(() => resolve());
  });

  const requests = SEARCH_TARGETS.map((target) => buildSearchRequest(mx, target));
  const hostFilter = options.host?.trim();
  const sendBurst = (): void => {
    for (const request of requests) {
      socket.send(request, 0, request.length, SSDP_PORT, SSDP_ADDRESS);
      if (hostFilter) {
        socket.send(request, 0, request.length, SSDP_PORT, hostFilter);
      }
    }
  };

  // Repeat the burst roughly every second so a dropped packet gets another chance and slow
  // renderers still get pinged; the loop naturally stops when the window elapses.
  const burstIntervalMs = 1000;
  let elapsed = 0;
  sendBurst();
  while (elapsed + burstIntervalMs < totalWindowMs) {
    await delay(burstIntervalMs);
    elapsed += burstIntervalMs;
    sendBurst();
  }
  await delay(Math.max(0, totalWindowMs - elapsed));
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
  return value.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? '';
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
    avTransportEventUrl: getUrl(avTransport?.eventSubUrl),
    renderingControlEventUrl: getUrl(rendering?.eventSubUrl),
  };
}

interface ServiceEntry {
  type: string;
  controlUrl: string;
  eventSubUrl?: string;
}

function extractServices(xml: string): ServiceEntry[] {
  const map: ServiceEntry[] = [];
  const serviceRegex = /<(?:\w+:)?service>([\s\S]*?)<\/(?:\w+:)?service>/gi;
  let match: RegExpExecArray | null;
  while ((match = serviceRegex.exec(xml)) !== null) {
    const block = match[1] ?? '';
    const type = extractTag(block, 'serviceType');
    const control = extractTag(block, 'controlURL');
    const eventSub = extractTag(block, 'eventSubURL');
    if (type && control) {
      map.push({
        type: type.trim(),
        controlUrl: control.trim(),
        eventSubUrl: eventSub?.trim() || undefined,
      });
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
