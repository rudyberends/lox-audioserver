import dgram from 'node:dgram';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createLogger } from '@/shared/logging/logger';

export interface SonosDiscoveredDevice {
  host: string;
  name?: string;
  roomName?: string;
  udn?: string;
  householdId?: string;
}

interface DiscoveryOptions {
  preferredName?: string;
  householdId?: string;
  allowNetworkScan?: boolean;
  timeoutMs?: number;
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
  'urn:schemas-upnp-org:device:ZonePlayer:1',
  'urn:schemas-upnp-org:device:MediaRenderer:1',
  'ssdp:all',
];
const log = createLogger('Transport', 'SonosDiscovery');

export async function discoverSonosDevice(
  options: DiscoveryOptions = {},
): Promise<SonosDiscoveredDevice | null> {
  const candidates = await discoverSonosDevices(options);
  if (!candidates.length) {
    return null;
  }
  const preferredName = options.preferredName?.toLowerCase();
  if (preferredName) {
    const match = candidates.find((device) => {
      const name = device.name?.toLowerCase();
      const room = device.roomName?.toLowerCase();
      return name === preferredName || room === preferredName;
    });
    if (match) {
      return match;
    }
  }
  return candidates[0] ?? null;
}

export async function discoverSonosDevices(
  options: DiscoveryOptions = {},
): Promise<SonosDiscoveredDevice[]> {
  const timeoutMs = options.timeoutMs ?? 1500;
  const responses = await searchSsdp(timeoutMs);
  const devices: SonosDiscoveredDevice[] = [];
  const seen = new Set<string>();
  for (const { location, responder } of responses) {
    try {
      const device = await resolveDeviceFromLocation(location, responder, options.householdId);
      if (!device) {
        continue;
      }
      const key = `${device.host}|${device.udn ?? ''}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      devices.push(device);
    } catch (err) {
      log.debug('sonos ssdp parse failed', {
        location,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (devices.length || !options.allowNetworkScan) {
    return devices;
  }

  const scanned = await scanNetworkForSonos(options.householdId, timeoutMs);
  for (const device of scanned) {
    const key = `${device.host}|${device.udn ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    devices.push(device);
  }
  return devices;
}

async function resolveDeviceFromLocation(
  location: string,
  responder: string,
  householdId?: string,
): Promise<SonosDiscoveredDevice | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1800);
  timeout.unref();
  try {
    const response = await fetch(location, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    const xml = await response.text();
    if (!xml.includes('Sonos')) {
      return null;
    }
    const host = normalizeHost(responder) || extractHost(location);
    if (!host) {
      return null;
    }
    const name = matchTag(xml, 'friendlyName');
    const udn = matchTag(xml, 'UDN')?.replace(/^uuid:/i, '');
    const status = await fetchStatus(host, householdId);
    return {
      host,
      name: name ?? status?.roomName ?? undefined,
      roomName: status?.roomName,
      udn,
      householdId: status?.householdId,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchStatus(
  host: string,
  householdId?: string,
): Promise<{ roomName?: string; householdId?: string } | null> {
  const url = `http://${host}:1400/status/zp`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  timeout.unref();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    const xml = await response.text();
    const household = matchTag(xml, 'HouseholdControlID');
    if (householdId && household && householdId !== household) {
      return null;
    }
    return {
      roomName: matchTag(xml, 'RoomName') ?? matchTag(xml, 'ZoneName') ?? undefined,
      householdId: household ?? undefined,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function scanNetworkForSonos(
  householdId: string | undefined,
  timeoutMs: number,
): Promise<SonosDiscoveredDevice[]> {
  const hosts = buildLocalScanHosts();
  if (!hosts.length) {
    return [];
  }
  const concurrency = 40;
  const devices: SonosDiscoveredDevice[] = [];
  let index = 0;
  const worker = async (): Promise<void> => {
    while (index < hosts.length) {
      const host = hosts[index];
      index += 1;
      try {
        const status = await fetchStatus(host, householdId);
        if (!status) {
          continue;
        }
        devices.push({
          host,
          name: status.roomName,
          roomName: status.roomName,
          householdId: status.householdId,
        });
      } catch {
        /* ignore */
      }
      await delay(5);
    }
  };
  const workers = Array.from({ length: concurrency }, worker);
  await Promise.race([Promise.all(workers), delay(timeoutMs)]);
  return devices;
}

async function searchSsdp(timeoutMs: number): Promise<SsdpResponse[]> {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const responses: SsdpResponse[] = [];
  const seen = new Set<string>();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(() => resolve());
  });
  const requests = SEARCH_TARGETS.map((target) => buildSearchRequest(2, target));
  for (const request of requests) {
    socket.send(request, 0, request.length, SSDP_PORT, SSDP_ADDRESS);
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
      responses.push({
        location,
        responder: rinfo.address,
        usn: headers.usn,
        st: headers.st ?? headers.nt,
      });
    } catch {
      /* ignore */
    }
  });
  await delay(timeoutMs);
  socket.close();
  return responses;
}

function parseSsdpResponse(payload: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const lines = payload.split(/\r?\n/);
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key) {
      headers[key] = value;
    }
  }
  return headers;
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
  return Buffer.from(payload);
}

function matchTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`, 'i'));
  return match?.[1]?.trim() ?? null;
}

function extractHost(location: string): string {
  try {
    const parsed = new URL(location);
    return normalizeHost(parsed.hostname);
  } catch {
    return '';
  }
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
}

function buildLocalScanHosts(): string[] {
  const interfaces = os.networkInterfaces();
  const hosts = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4') {
        continue;
      }
      if (entry.internal) {
        continue;
      }
      const parts = entry.address.split('.');
      if (parts.length !== 4) {
        continue;
      }
      const base = parts.slice(0, 3).join('.');
      for (let i = 1; i <= 254; i += 1) {
        hosts.add(`${base}.${i}`);
      }
    }
  }
  return Array.from(hosts);
}
