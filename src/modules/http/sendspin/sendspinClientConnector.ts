import type { IncomingMessage } from 'node:http';
import Bonjour from 'bonjour-service';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import { createLogger } from '@/core/logging/logger';
import { sendspinCore } from '@/modules/http/sendspin/sendspinCore';

type MdnsService = {
  name?: string;
  host?: string;
  port: number;
  addresses?: string[];
  txt?: Record<string, unknown>;
};

interface Endpoint {
  url: string;
  serviceName?: string;
  candidateMatch: boolean;
  reason: 'discovery' | 'playback';
}

/**
 * Discovers Sendspin clients via mDNS and establishes outbound WebSocket connections
 * so playback can be pushed without manually starting the client with a URL.
 */
class SendspinClientConnector {
  private readonly log = createLogger('Sendspin', 'Connector');
  private readonly desiredClientIds = new Set<string>();
  private readonly desiredReasons = new Map<string, 'discovery' | 'playback'>();
  private readonly activeSockets = new Map<string, WebSocket>();
  private readonly socketReason = new Map<string, 'discovery' | 'playback'>();
  private readonly clientSocketUrl = new Map<string, string>();
  private readonly directEndpoints = new Map<string, string>();
  private readonly failures = new Map<string, { count: number; lastError: string | null; suppressedUntil: number | null }>();
  private readonly lastAttempts = new Map<string, number>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly knownServices = new Map<string, MdnsService>();
  private bonjour: Bonjour | null = null;
  private browser: ReturnType<Bonjour['find']> | null = null;
  private serverService: ReturnType<Bonjour['publish']> | null = null;

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
    this.ensureBonjour();
    if (this.serverService) {
      try {
        this.serverService.stop?.();
      } catch {
        /* ignore */
      }
      this.serverService = null;
    }
    const service = this.bonjour!.publish({
      name: options.name || 'Lox Audio Server',
      type: 'sendspin-server',
      protocol: 'tcp',
      port: options.port,
      host: options.host,
      txt: { path: this.normalizePathValue(options.path) },
    });
    service.start?.();
    this.serverService = service;
    this.log.info('Sendspin server advertised via mDNS', {
      name: service.name,
      host: options.host,
      port: options.port,
      path: this.normalizePathValue(options.path),
    });
  }

  public stopAdvertising(): void {
    if (this.serverService) {
      try {
        this.serverService.stop?.();
      } catch {
        /* ignore */
      }
      this.serverService = null;
    }
  }

  private ensureBrowser(): void {
    const bonjour = this.ensureBonjour();
    if (this.browser) {
      return;
    }
    this.browser = bonjour.find(
      { type: 'sendspin', protocol: 'tcp' },
      (service) => this.handleService(service),
    );
    this.browser.start();
  }

  private ensureBonjour(): Bonjour {
    if (!this.bonjour) {
      this.bonjour = new Bonjour();
    }
    return this.bonjour;
  }

  private retryKnownServices(): void {
    for (const service of this.knownServices.values()) {
      this.handleService(service);
    }
  }

  private handleService(service: MdnsService): void {
    const key = this.serviceKey(service);
    this.knownServices.set(key, service);
    if (!this.desiredClientIds.size) {
      return;
    }

    const candidateMatch = [...this.desiredClientIds].some((id) => this.serviceMatches(service, id));
    if (!candidateMatch) {
      return;
    }

    const endpoint = this.toEndpoint(service, candidateMatch);
    if (endpoint) {
      this.connect(endpoint);
    }
  }

  private connect(endpoint: Endpoint): void {
    if (this.activeSockets.has(endpoint.url)) {
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
      const reason = endpoint.reason ?? 'discovery';
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
      if (desiredReason === 'playback' && socketReason !== 'playback') {
        ws.close();
      }
    });

    ws.on('close', () => {
      this.activeSockets.delete(endpoint.url);
      this.socketReason.delete(endpoint.url);
      this.scheduleRetry(endpoint, matchedDesired || endpoint.candidateMatch);
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

  private toEndpoint(service: MdnsService, candidateMatch: boolean): Endpoint | null {
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
      candidateMatch,
      reason: this.resolveReasonForService(service),
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
    };
  }

  private pickAddress(service: MdnsService): string | null {
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

  private serviceMatches(service: MdnsService, clientId: string): boolean {
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

  private resolveReasonForService(service: MdnsService): 'discovery' | 'playback' {
    for (const id of this.desiredClientIds) {
      if (this.serviceMatches(service, id) && this.desiredReasons.get(id) === 'playback') {
        return 'playback';
      }
    }
    return 'discovery';
  }

  private serviceKey(service: MdnsService): string {
    return `${service.name || service.host || 'unknown'}:${service.port}`;
  }
}

export const sendspinClientConnector = new SendspinClientConnector();
