import { networkInterfaces } from 'node:os';
import type { IncomingMessage } from 'node:http';

/**
 * True when the request originates from this host — loopback or one of our own
 * non-loopback interface addresses. Used to keep localhost-only proxy routes
 * unreachable from the LAN even though the gateway binds on 0.0.0.0.
 */
export function isLocalRequest(req: IncomingMessage): boolean {
  const remote = req.socket?.remoteAddress ?? '';
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') {
    return true;
  }
  let nets: ReturnType<typeof networkInterfaces>;
  try {
    nets = networkInterfaces();
  } catch {
    return false;
  }
  for (const entries of Object.values(nets)) {
    for (const net of entries ?? []) {
      if (!net?.address || net.internal) {
        continue;
      }
      if (remote === net.address || remote === `::ffff:${net.address}`) {
        return true;
      }
    }
  }
  return false;
}

export function defaultLocalIp(): string {
  let nets: ReturnType<typeof networkInterfaces>;
  try {
    nets = networkInterfaces();
  } catch {
    // Some restricted runtimes (tests/containers) can throw here; fall back to empty.
    return '';
  }
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (!net || net.internal) {
        continue;
      }
      if (net.family === 'IPv4' && net.address) {
        return net.address;
      }
    }
  }
  return '';
}

/**
 * Resolve the host clients should use to fetch locally-served artwork (the
 * `/music` and `/collage` routes on :7090). Prefers a configured, non-loopback
 * `audioserver.ip`, then the first non-loopback IPv4, then 127.0.0.1.
 */
export function resolveCoverHost(configuredIp?: string): string {
  const configured = configuredIp?.trim();
  if (configured && configured !== '0.0.0.0' && !configured.startsWith('127.')) {
    return configured;
  }
  return defaultLocalIp() || configured || '127.0.0.1';
}

export function resolveMdnsHost(host?: string, preferredIp?: string): string | undefined {
  const preferred = preferredIp?.trim();
  if (preferred && preferred !== '0.0.0.0') {
    return preferred;
  }
  const candidate = host && host !== '0.0.0.0' ? host : defaultLocalIp();
  if (!candidate || candidate === '0.0.0.0') {
    return undefined;
  }
  return candidate;
}
