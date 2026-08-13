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

/**
 * Interfaces that carry container/VM traffic rather than LAN traffic. Node reports these as
 * `internal: false`, so they are indistinguishable from a real NIC by that flag alone, and picking
 * one hands out an address no device on the LAN can reach.
 */
const VIRTUAL_IFACE_PATTERN = /^(docker|br-|veth|virbr|vmnet|tap|tun|zt|wg|tailscale|cni|flannel|kube|podman|lxcbr|lxdbr)/i;

/**
 * Address ranges that are never a useful contact address to hand out: link-local (no DHCP answered)
 * and carrier-grade NAT. Docker's own default pools live inside 172.16/12, but that whole range is
 * legitimate private LAN space too, so it is filtered by interface name above rather than by prefix
 * -- refusing 172.16/12 outright would break anyone running their LAN there.
 */
function isUnusableIpv4(address: string): boolean {
  return address.startsWith('169.254.') || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address);
}

/**
 * Every IPv4 address a LAN client could plausibly use to reach us, best first.
 *
 * Ordering matters: whatever comes first becomes the address we advertise over mDNS, so a container
 * address landing here sends a remote device to an unroutable IP -- or worse, to a 172.x host that
 * happens to exist on its own side of the network.
 */
export function localIpv4Candidates(): string[] {
  const { preferred, fallback } = groupLocalIpv4();
  return [...preferred, ...fallback];
}

/**
 * The addresses a LAN client could plausibly reach us on, excluding container/VM bridges.
 *
 * Distinct from {@link localIpv4Candidates}, which appends bridge addresses as a last resort so a
 * caller that needs *some* address still gets one. Advertising must not do that: handing out a
 * bridge address alongside a real one lets a client pick the unroutable half, and mDNS address sets
 * are unordered so it is a coin flip. Empty when we have nothing but bridges.
 */
export function advertisableIpv4Addresses(): string[] {
  return groupLocalIpv4().preferred;
}

function groupLocalIpv4(): { preferred: string[]; fallback: string[] } {
  let nets: ReturnType<typeof networkInterfaces>;
  try {
    nets = networkInterfaces();
  } catch {
    // Some restricted runtimes (tests/containers) can throw here; fall back to empty.
    return { preferred: [], fallback: [] };
  }
  const preferred: string[] = [];
  const fallback: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (!net || net.internal || net.family !== 'IPv4' || !net.address) {
        continue;
      }
      if (isUnusableIpv4(net.address)) {
        continue;
      }
      if (VIRTUAL_IFACE_PATTERN.test(name)) {
        fallback.push(net.address);
      } else {
        preferred.push(net.address);
      }
    }
  }
  return { preferred, fallback };
}

export function defaultLocalIp(): string {
  return localIpv4Candidates()[0] ?? '';
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

/**
 * The SRV target to advertise: a `.local` hostname, never a bare IP address.
 *
 * bonjour-service uses this value for both the SRV target and the *name* of every A/AAAA record, so
 * passing an IP publishes an A-record called `192.168.1.209` -- not a hostname, and nothing a strict
 * resolver can follow. Clients that insist on tying SRV to an address record (mdns-sd, avahi-resolve)
 * then fail with NXDOMAIN and never see the service at all, while looser clients that read the
 * address set directly still work. That split is why it went unnoticed.
 *
 * Returning undefined lets the library fall back to os.hostname(), which is correct: it publishes
 * `<hostname>.local` with our addresses attached.
 */
export function resolveMdnsHost(host?: string, preferredIp?: string): string | undefined {
  const candidate = (preferredIp?.trim() || host || '').trim();
  if (!candidate || candidate === '0.0.0.0' || isIpAddress(candidate)) {
    return undefined;
  }
  // A name is passed through as-is: the library uses it verbatim as the SRV target, and appending
  // `.local` ourselves would claim a second name for the host that avahi already answers for.
  return candidate;
}

function isIpAddress(value: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.includes(':');
}
