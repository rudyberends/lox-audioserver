import dgram from 'node:dgram';
import { createLogger } from '@/shared/logging/logger';

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const ADVERTISE_INTERVAL_MS = 30_000;
const MAX_AGE_SECONDS = 1800;

/**
 * One SSDP device we announce: a UDN, a device type, its service types, and the
 * absolute URL of its device description. A single UDP socket on :1900 can only
 * be bound once, so ALL our UPnP devices (the MediaServer plus one MediaRenderer
 * per zone) share one advertiser and are registered as devices here.
 */
export type SsdpDevice = {
  /** Stable id, e.g. `uuid:xxxxxxxx-...`. */
  udn: string;
  /** e.g. `urn:schemas-upnp-org:device:MediaRenderer:1`. */
  deviceType: string;
  /** Full service type URNs, e.g. `urn:schemas-upnp-org:service:AVTransport:1`. */
  serviceTypes: string[];
  /** Returns the absolute LOCATION of this device's description (per-call so IP can change). */
  location: () => string;
};

/**
 * SSDP presence for our UPnP devices — the responder side that dlnaDiscovery.ts
 * (a control point) deliberately never implements.
 *
 *   - answers M-SEARCH requests targeting any registered device/service type with
 *     unicast replies carrying that device's LOCATION, and
 *   - periodically multicasts NOTIFY ssdp:alive per registered device, plus
 *     ssdp:byebye on shutdown / device removal,
 *
 * so controllers (BubbleUPnP, B&O, Samsung, VLC) discover us without a manual
 * poll. USNs follow the standard triple per device: root device, device type,
 * and each service type, all under that device's UDN.
 */
export class SsdpAdvertiser {
  private readonly log = createLogger('MediaServer', 'SSDP');
  private socket?: dgram.Socket;
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly devices = new Map<string, SsdpDevice>();

  constructor(
    private readonly params: {
      serverHeader?: string;
    } = {},
  ) {}

  /** Register (or replace) a device and announce it immediately if running. */
  public addDevice(device: SsdpDevice): void {
    this.devices.set(device.udn, device);
    if (this.running) {
      this.sendAliveFor(device);
    }
  }

  /** Remove a device and send byebye for it. */
  public removeDevice(udn: string): void {
    const device = this.devices.get(udn);
    if (!device) {
      return;
    }
    this.devices.delete(udn);
    if (this.running) {
      this.sendByebyeFor(device);
    }
  }

  public hasDevices(): boolean {
    return this.devices.size > 0;
  }

  public async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('message', (msg, rinfo) => this.handleMessage(msg, rinfo));
    socket.on('error', (error) => {
      this.log.warn('ssdp socket error', { message: error.message });
    });

    await new Promise<void>((resolve) => {
      socket.bind(SSDP_PORT, () => {
        try {
          socket.addMembership(SSDP_ADDRESS);
        } catch (error) {
          this.log.warn('ssdp addMembership failed', {
            message: error instanceof Error ? error.message : String(error),
          });
        }
        resolve();
      });
    });

    // Announce all registered devices immediately, then on an interval.
    this.sendAlive();
    this.timer = setInterval(() => this.sendAlive(), ADVERTISE_INTERVAL_MS);
    this.timer.unref?.();
    this.log.info('ssdp advertiser started', { devices: this.devices.size });
  }

  public async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    try {
      this.sendByebye();
    } catch {
      /* best effort */
    }
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      await new Promise<void>((resolve) => {
        try {
          socket.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
  }

  /** The standard NT/USN pairs a device advertises: root, device type, each service. */
  private notificationTypes(device: SsdpDevice): Array<{ nt: string; usnSuffix: string }> {
    return [
      { nt: 'upnp:rootdevice', usnSuffix: '::upnp:rootdevice' },
      { nt: device.udn, usnSuffix: '' },
      { nt: device.deviceType, usnSuffix: `::${device.deviceType}` },
      ...device.serviceTypes.map((svc) => ({ nt: svc, usnSuffix: `::${svc}` })),
    ];
  }

  private serverHeader(): string {
    return this.params.serverHeader ?? 'Linux/5 UPnP/1.0 SonnAudio/1.0';
  }

  private sendAlive(): void {
    for (const device of this.devices.values()) {
      this.sendAliveFor(device);
    }
  }

  private sendAliveFor(device: SsdpDevice): void {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    const location = device.location();
    for (const { nt, usnSuffix } of this.notificationTypes(device)) {
      const usn = `${device.udn}${usnSuffix}`;
      const message =
        'NOTIFY * HTTP/1.1\r\n' +
        `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\n` +
        `CACHE-CONTROL: max-age=${MAX_AGE_SECONDS}\r\n` +
        `LOCATION: ${location}\r\n` +
        'NTS: ssdp:alive\r\n' +
        `NT: ${nt}\r\n` +
        `SERVER: ${this.serverHeader()}\r\n` +
        `USN: ${usn}\r\n` +
        '\r\n';
      const buf = Buffer.from(message, 'ascii');
      socket.send(buf, 0, buf.length, SSDP_PORT, SSDP_ADDRESS);
    }
  }

  private sendByebye(): void {
    for (const device of this.devices.values()) {
      this.sendByebyeFor(device);
    }
  }

  private sendByebyeFor(device: SsdpDevice): void {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    for (const { nt, usnSuffix } of this.notificationTypes(device)) {
      const usn = `${device.udn}${usnSuffix}`;
      const message =
        'NOTIFY * HTTP/1.1\r\n' +
        `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\n` +
        'NTS: ssdp:byebye\r\n' +
        `NT: ${nt}\r\n` +
        `USN: ${usn}\r\n` +
        '\r\n';
      const buf = Buffer.from(message, 'ascii');
      socket.send(buf, 0, buf.length, SSDP_PORT, SSDP_ADDRESS);
    }
  }

  private handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    const text = msg.toString('ascii');
    if (!text.startsWith('M-SEARCH')) {
      return;
    }
    const headers = parseHeaders(text);
    if ((headers.man ?? '').replace(/"/g, '') !== 'ssdp:discover') {
      return;
    }
    const st = (headers.st ?? '').trim();
    // Reply once per matching (device, target).
    for (const device of this.devices.values()) {
      for (const { nt, usnSuffix } of this.matchingTargets(device, st)) {
        this.sendSearchResponse(device, nt, usnSuffix, rinfo);
      }
    }
  }

  private matchingTargets(
    device: SsdpDevice,
    st: string,
  ): Array<{ nt: string; usnSuffix: string }> {
    const all = this.notificationTypes(device);
    if (st === 'ssdp:all') {
      return all;
    }
    return all.filter((t) => t.nt === st);
  }

  private sendSearchResponse(
    device: SsdpDevice,
    nt: string,
    usnSuffix: string,
    rinfo: dgram.RemoteInfo,
  ): void {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    const usn = `${device.udn}${usnSuffix}`;
    const message =
      'HTTP/1.1 200 OK\r\n' +
      `CACHE-CONTROL: max-age=${MAX_AGE_SECONDS}\r\n` +
      'EXT:\r\n' +
      `LOCATION: ${device.location()}\r\n` +
      `SERVER: ${this.serverHeader()}\r\n` +
      `ST: ${nt}\r\n` +
      `USN: ${usn}\r\n` +
      '\r\n';
    const buf = Buffer.from(message, 'ascii');
    socket.send(buf, 0, buf.length, rinfo.port, rinfo.address);
  }
}

function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) {
      continue;
    }
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key) {
      headers[key] = value;
    }
  }
  return headers;
}
