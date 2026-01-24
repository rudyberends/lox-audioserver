import type { IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import { createLogger } from '@/shared/logging/logger';
import { ConnectionReason, sendspinCore } from '@lox-audioserver/node-sendspin';
import type { MdnsBrowser, MdnsPort, MdnsRegistration, MdnsServiceRecord } from '@/ports/MdnsPort';

interface Endpoint {
  url: string;
  serviceName?: string;
  candidateMatch: boolean;
  reason: 'discovery' | 'playback';
  clientId?: string;
}

/**
 * Discovers Sendspin clients via mDNS and establishes outbound WebSocket connections
 * so playback can be pushed without manually starting the client with a URL.
 */
export class SendspinClientConnector {
  private readonly log = createLogger('Sendspin', 'Connector');
  private readonly desiredClientIds = new Set<string>();
  private readonly desiredReasons = new Map<string, 'discovery' | 'playback'>();
  private readonly activeSockets = new Map<string, WebSocket>();
  private readonly socketReason = new Map<string, ConnectionReason>();
  private readonly clientSocketUrl = new Map<string, string>();
  private readonly directEndpoints = new Map<string, string>();
  private readonly failures = new Map<string, { count: number; lastError: string | null; suppressedUntil: number | null }>();
  private readonly lastAttempts = new Map<string, number>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly knownServices = new Map<string, MdnsServiceRecord>();
  private readonly inboundClients = new Set<string>();
  private browser: MdnsBrowser | null = null;
  private serverRegistration: MdnsRegistration | null = null;

  constructor(private readonly mdns: MdnsPort) {}

  public watchClient(clientId: string): () => void {
    const normalized = clientId.trim();
    if (!normalized) {
      return () => {};
    }
    this.desiredClientIds.add(normalized);
    if (!this.desiredReasons.has(normalized)) {
      this.desiredReasons.set(normalized, 'discovery');
    }
    this.maybeConnectDirect(normalized);
    this.ensureBrowser();
    this.retryKnownServices();
    return () => this.unwatchClient(normalized);
  }

  /** Elevate a target client to playback priority (for reclaim during active playback). */
  public requestPlaybackPriority(clientId: string): void {
    const normalized = clientId.trim();
    if (!normalized) {
      return;
    }
    this.desiredReasons.set(normalized, 'playback');
    const url = this.clientSocketUrl.get(normalized);
    if (url) {
      this.lastAttempts.delete(url);
    }
    this.maybeConnectDirect(normalized);
    this.retryKnownServices();
    if (url) {
      const socket = this.activeSockets.get(url);
      socket?.close();
    }
  }

  private unwatchClient(clientId: string): void {
    this.desiredClientIds.delete(clientId);
    this.desiredReasons.delete(clientId);
    const url = this.clientSocketUrl.get(clientId);
    if (url) {
      this.clientSocketUrl.delete(clientId);
    }
    this.directEndpoints.delete(clientId);
  }

  public advertiseServer(options: { port: number; host?: string; name?: string; path?: string }): void {
    this.stopAdvertising();
    this.serverRegistration = this.mdns.publish({
      name: options.name || 'Lox Audio Server',
      type: 'sendspin-server',
      protocol: 'tcp',
      port: options.port,
      host: options.host,
      txt: { path: this.normalizePathValue(options.path) },
    });
    this.log.info('Sendspin server advertised via mDNS', {
      name: options.name || 'Lox Audio Server',
      host: options.host,
      port: options.port,
      path: this.normalizePathValue(options.path),
    });
  }

  public stopAdvertising(): void {
    this.serverRegistration?.stop();
    this.serverRegistration = null;
  }

  private ensureBrowser(): void {
    if (this.browser) {
      return;
    }
    this.browser = this.mdns.browse(
      { type: 'sendspin', protocol: 'tcp' },
      (service) => this.handleService(service),
    );
  }

  private retryKnownServices(): void {
    for (const service of this.knownServices.values()) {
      this.handleService(service);
    }
  }

  private handleService(service: MdnsServiceRecord): void {
    const key = this.serviceKey(service);
    this.knownServices.set(key, service);
    if (!this.desiredClientIds.size) {
      return;
    }

    const matchedClientId = [...this.desiredClientIds].find((id) => this.serviceMatches(service, id));
    if (!matchedClientId) {
      return;
    }

    const endpoint = this.toEndpoint(service, matchedClientId);
    if (endpoint) {
      this.connect(endpoint);
    }
  }

  private connect(endpoint: Endpoint): void {
    if (this.activeSockets.has(endpoint.url)) {
      return;
    }
    if (endpoint.clientId && this.inboundClients.has(endpoint.clientId)) {
      return;
    }
    if (!this.desiredClientIds.size) {
      return;
    }

    const now = Date.now();
    const failureMeta = this.failures.get(endpoint.url);
    if (failureMeta?.suppressedUntil && now < failureMeta.suppressedUntil) {
      return;
    }
    const lastAttempt = this.lastAttempts.get(endpoint.url) ?? 0;
    const minIntervalMs = endpoint.reason === 'playback' ? 0 : 3_000;
    if (now - lastAttempt < minIntervalMs) {
      return;
    }
    this.lastAttempts.set(endpoint.url, now);

    this.log.info('Sendspin dialing client', {
      url: endpoint.url,
      service: endpoint.serviceName,
    });

    let upgradeReq: IncomingMessage | null = null;
    let matchedDesired = false;
    const ws = new WebSocket(endpoint.url);
    ws.on('upgrade', (req) => {
      upgradeReq = req;
    });

    ws.once('open', () => {
      this.activeSockets.set(endpoint.url, ws);
      const reason =
        endpoint.reason === 'playback' ? ConnectionReason.PLAYBACK : ConnectionReason.DISCOVERY;
      this.socketReason.set(endpoint.url, reason);
      // Pass the intended connection reason to the session.
      sendspinCore.handleConnection(ws, upgradeReq, reason);
    });

    ws.on('message', (data, isBinary) => {
      if (matchedDesired || isBinary) {
        return;
      }
      const clientId = this.extractClientId(data);
      if (!clientId) {
        return;
      }
      matchedDesired = this.desiredClientIds.has(clientId);
      if (!matchedDesired) {
        this.log.info('Sendspin client not in config; closing connection', {
          clientId,
          url: endpoint.url,
        });
        ws.close();
        return;
      }
      this.log.info('Sendspin client connected', { clientId, url: endpoint.url });
      this.clientSocketUrl.set(clientId, endpoint.url);
      // Upgrade reason if this was a playback-priority client but the endpoint used discovery.
      const desiredReason = this.desiredReasons.get(clientId);
      const socketReason = this.socketReason.get(endpoint.url);
      if (desiredReason === 'playback' && socketReason !== ConnectionReason.PLAYBACK) {
        ws.close();
      }
    });

    ws.on('close', (_code, reasonBuf) => {
      this.activeSockets.delete(endpoint.url);
      this.socketReason.delete(endpoint.url);
      const reason = reasonBuf ? reasonBuf.toString() : '';
      const goodbyeReason = this.parseGoodbyeReason(reason);
      const shouldRetry =
        (matchedDesired || endpoint.candidateMatch) &&
        !this.shouldSuppressRetry(goodbyeReason);
      this.scheduleRetry(endpoint, shouldRetry);
    });

    ws.on('error', (err) => {
      this.log.debug('Sendspin socket error', {
        url: endpoint.url,
        message: (err as Error).message,
      });
      this.recordFailure(endpoint.url, (err as Error).message);
    });
  }

  private scheduleRetry(endpoint: Endpoint, shouldRetry: boolean): void {
    if (!shouldRetry || !this.desiredClientIds.size) {
      return;
    }
    if (endpoint.clientId && this.inboundClients.has(endpoint.clientId)) {
      return;
    }
    if (this.retryTimers.has(endpoint.url)) {
      return;
    }
    const delayMs = endpoint.reason === 'playback' ? 500 : 5_000;
    const failureMeta = this.failures.get(endpoint.url);
    const suppressedUntil = failureMeta?.suppressedUntil ?? null;
    if (suppressedUntil && Date.now() < suppressedUntil) {
      return;
    }
    const timer = setTimeout(() => {
      this.retryTimers.delete(endpoint.url);
      const failureMeta = this.failures.get(endpoint.url);
      if (failureMeta?.suppressedUntil && Date.now() < failureMeta.suppressedUntil) {
        return;
      }
      this.connect(endpoint);
    }, delayMs);
    this.retryTimers.set(endpoint.url, timer);
  }

  private recordFailure(url: string, message: string | null): void {
    const meta = this.failures.get(url) ?? { count: 0, lastError: null, suppressedUntil: null };
    const nextCount = (meta.count || 0) + 1;
    const normalizedMsg = message ? message.toLowerCase() : null;
    let suppressedUntil: number | null = meta.suppressedUntil ?? null;
    // If DNS lookup failed repeatedly, back off longer to avoid log spam.
    if (normalizedMsg && normalizedMsg.includes('enotfound') && nextCount >= 3) {
      suppressedUntil = Date.now() + 60_000; // 60s suppression
      this.log.info('Sendspin direct endpoint suppressed after repeated DNS failures', {
        url,
        attempts: nextCount,
        retryAfterMs: 60_000,
      });
    }
    this.failures.set(url, { count: nextCount, lastError: message, suppressedUntil });
  }

  private extractClientId(raw: RawData): string | null {
    try {
      const msg = JSON.parse(raw.toString());
      return msg?.payload?.client_id || msg?.payload?.clientId || null;
    } catch {
      return null;
    }
  }

  private toEndpoint(service: MdnsServiceRecord, clientId: string): Endpoint | null {
    const address = this.pickAddress(service);
    if (!address || !service.port) {
      this.log.debug('Sendspin mDNS entry missing address/port', { service: service.name });
      return null;
    }
    const path = this.normalizePathFromTxt(service.txt);
    const url = `ws://${address}:${service.port}${path}`;
    return {
      url,
      serviceName: service.name,
      candidateMatch: true,
      reason: this.desiredReasons.get(clientId) ?? 'discovery',
      clientId,
    };
  }

  private maybeConnectDirect(clientId: string): void {
    const endpoint = this.buildDirectEndpoint(clientId);
    if (!endpoint) {
      return;
    }
    this.directEndpoints.set(clientId, endpoint.url);
    this.connect(endpoint);
  }

  private buildDirectEndpoint(clientId: string): Endpoint | null {
    const reason = this.desiredReasons.get(clientId) ?? 'discovery';
    const trimmed = clientId.trim();
    if (!trimmed) {
      return null;
    }

    // If a full WebSocket URL is provided, use it verbatim.
    const hasScheme = /^wss?:\/\//i.test(trimmed);
    let url = trimmed;

    if (!hasScheme) {
      const hostPort = trimmed.includes(':') ? trimmed : `${trimmed}:8927`;
      url = `ws://${hostPort}/sendspin`;
    }

    try {
      // Validate URL; will throw if invalid.

      new URL(url);
    } catch {
      return null;
    }

    return {
      url,
      serviceName: 'direct',
      candidateMatch: true,
      reason,
      clientId: trimmed,
    };
  }

  private pickAddress(service: MdnsServiceRecord): string | null {
    const addresses = (service.addresses || []).filter(Boolean) as string[];
    const ipv4 = addresses.find((addr) => addr.includes('.'));
    if (ipv4) {
      return ipv4;
    }
    if (service.host) {
      return service.host;
    }
    if (service.name) {
      return service.name;
    }
    return null;
  }

  private normalizePathFromTxt(txt?: Record<string, unknown>): string {
    return this.normalizePathValue(typeof txt?.path === 'string' ? txt.path : undefined);
  }

  private normalizePathValue(path?: string): string {
    const raw = path || '/sendspin';
    return raw.startsWith('/') ? raw : `/${raw}`;
  }

  private serviceMatches(service: MdnsServiceRecord, clientId: string): boolean {
    const id = clientId.toLowerCase();
    const values = [
      service.name,
      service.host,
      ...(service.addresses || []),
    ]
      .filter(Boolean)
      .map((v) => (v as string).toLowerCase());
    return values.some((val) => val === id || val.startsWith(id) || id.startsWith(val));
  }

  private resolveReasonForService(service: MdnsServiceRecord): 'discovery' | 'playback' {
    for (const id of this.desiredClientIds) {
      if (this.serviceMatches(service, id) && this.desiredReasons.get(id) === 'playback') {
        return 'playback';
      }
    }
    return 'discovery';
  }

  private serviceKey(service: MdnsServiceRecord): string {
    return `${service.name || service.host || 'unknown'}:${service.port}`;
  }

  public markInboundConnected(clientId: string): void {
    const normalized = clientId.trim();
    if (!normalized) {
      return;
    }
    this.inboundClients.add(normalized);
  }

  public markInboundDisconnected(clientId: string): void {
    const normalized = clientId.trim();
    if (!normalized) {
      return;
    }
    this.inboundClients.delete(normalized);
  }

  private parseGoodbyeReason(reason: string): string | null {
    const prefix = 'client goodbye:';
    if (!reason || !reason.startsWith(prefix)) {
      return null;
    }
    return reason.slice(prefix.length).trim() || null;
  }

  private shouldSuppressRetry(reason: string | null): boolean {
    if (!reason) {
      return false;
    }
    return reason === 'another_server' || reason === 'shutdown' || reason === 'user_request';
  }
}
