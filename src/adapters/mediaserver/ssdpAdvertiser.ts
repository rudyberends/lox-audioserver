import dgram from 'node:dgram';
import { createLogger } from '@/shared/logging/logger';
import { DEVICE_DESCRIPTION_PATH } from '@/adapters/mediaserver/deviceDescription';

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const ADVERTISE_INTERVAL_MS = 30_000;
const MAX_AGE_SECONDS = 1800;

/**
 * SSDP presence for the MediaServer — the responder side that dlnaDiscovery.ts
 * (a control point) deliberately never implements.
 *
 * It does two things:
 *   - answers M-SEARCH requests targeting our device/service types with unicast
 *     replies carrying the LOCATION of our device description, and
 *   - periodically multicasts NOTIFY ssdp:alive, plus ssdp:byebye on shutdown,
 *
 * so controllers (BubbleUPnP, B&O, Samsung, VLC) discover us without a manual
 * poll. USNs follow the standard triple: root device, device type, and each
 * service type, all under one UDN.
 */
export class SsdpAdvertiser {
  private readonly log = createLogger('MediaServer', 'SSDP');
  private socket?: dgram.Socket;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly params: {
      udn: string; // e.g. uuid:xxxxxxxx-...
      /** Absolute http origin, e.g. http://192.168.1.10:7090 */
      baseUrl: () => string;
      serverHeader?: string;
    },
  ) {}

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

    // Announce presence immediately, then on an interval.
    this.sendAlive();
    this.timer = setInterval(() => this.sendAlive(), ADVERTISE_INTERVAL_MS);
    this.timer.unref?.();
    this.log.info('ssdp advertiser started', { udn: this.params.udn });
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

  private notificationTypes(): Array<{ nt: string; usnSuffix: string }> {
    return [
      { nt: 'upnp:rootdevice', usnSuffix: '::upnp:rootdevice' },
      { nt: this.params.udn, usnSuffix: '' },
      {
        nt: 'urn:schemas-upnp-org:device:MediaServer:1',
        usnSuffix: '::urn:schemas-upnp-org:device:MediaServer:1',
      },
      {
        nt: 'urn:schemas-upnp-org:service:ContentDirectory:1',
        usnSuffix: '::urn:schemas-upnp-org:service:ContentDirectory:1',
      },
      {
        nt: 'urn:schemas-upnp-org:service:ConnectionManager:1',
        usnSuffix: '::urn:schemas-upnp-org:service:ConnectionManager:1',
      },
    ];
  }

  private location(): string {
    return `${this.params.baseUrl()}${DEVICE_DESCRIPTION_PATH}`;
  }

  private serverHeader(): string {
    return this.params.serverHeader ?? 'Linux/5 UPnP/1.0 SonnAudio/1.0';
  }

  private sendAlive(): void {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    const location = this.location();
    for (const { nt, usnSuffix } of this.notificationTypes()) {
      const usn = `${this.params.udn}${usnSuffix}`;
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
    const socket = this.socket;
    if (!socket) {
      return;
    }
    for (const { nt, usnSuffix } of this.notificationTypes()) {
      const usn = `${this.params.udn}${usnSuffix}`;
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
    const targets = this.matchingTargets(st);
    if (!targets.length) {
      return;
    }
    // Honour MX (spread replies a little) but keep it simple: reply quickly.
    for (const { nt, usnSuffix } of targets) {
      this.sendSearchResponse(nt, usnSuffix, rinfo);
    }
  }

  private matchingTargets(st: string): Array<{ nt: string; usnSuffix: string }> {
    const all = this.notificationTypes();
    if (st === 'ssdp:all') {
      return all;
    }
    return all.filter((t) => t.nt === st);
  }

  private sendSearchResponse(
    nt: string,
    usnSuffix: string,
    rinfo: dgram.RemoteInfo,
  ): void {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    const usn = `${this.params.udn}${usnSuffix}`;
    const message =
      'HTTP/1.1 200 OK\r\n' +
      `CACHE-CONTROL: max-age=${MAX_AGE_SECONDS}\r\n` +
      'EXT:\r\n' +
      `LOCATION: ${this.location()}\r\n` +
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
