import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '@/shared/logging/logger';
import { defaultLocalIp } from '@/shared/utils/net';
import type { LineInBridgeConfig, LineInInputConfig } from '@/domain/config/types';
import type { LineInMetadataService } from '@/adapters/inputs/linein/lineInMetadataService';
import { resolveLineInIngestResampler, resolveLineInSampleRate } from '@/adapters/inputs/linein/lineInConstants';
import type { ConfigPort } from '@/ports/ConfigPort';

type LineInSummary = {
  id: string;
  name: string;
};

type BridgeCaptureDevice = {
  id: string;
  name?: string;
  channels?: number;
  sample_rates?: number[];
};

type BridgeRegistrationPayload = {
  bridge_id?: string;
  hostname?: string;
  version?: string;
  ip?: string;
  mac?: string;
  capture_devices?: BridgeCaptureDevice[];
};

type BridgeStatusPayload = {
  state?: string;
  device?: string;
  rate?: number;
  channels?: number;
  format?: string;
  rms_db?: number | null;
  last_error?: string | null;
  track_change?: boolean;
  capture_devices?: BridgeCaptureDevice[];
};

type BridgeStatusSnapshot = {
  payload: BridgeStatusPayload;
  receivedAt: number;
};

type BridgeRecord = {
  bridgeId: string;
  hostname?: string;
  version?: string;
  ip?: string;
  mac?: string;
  captureDevices: BridgeCaptureDevice[];
  lastSeen: number;
};

const LINEIN_ID_START = 1000001;
const DEFAULT_LINEIN_NAME = 'LineIn';
const STATUS_STALE_MS = 15000;

export class LineInApiHandler {
  private readonly log = createLogger('Http', 'LineInApi');
  private readonly statusByBridgeId = new Map<string, BridgeStatusSnapshot>();
  private readonly bridgesById = new Map<string, BridgeRecord>();
  private readonly configPort: ConfigPort;
  private readonly metadataService: LineInMetadataService;

  constructor(configPort: ConfigPort, metadataService: LineInMetadataService) {
    this.configPort = configPort;
    this.metadataService = metadataService;
  }

  public matches(pathname: string): boolean {
    return pathname.startsWith('/api/linein');
  }

  public async handle(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const normalized = this.normalizePath(pathname);
    if (!normalized) {
      this.sendJson(res, 404, { error: 'not-found' });
      return;
    }

    if (normalized === '/api/linein') {
      if (req.method !== 'GET') {
        this.sendJson(res, 405, { error: 'method-not-allowed' });
        return;
      }
      this.sendJson(res, 200, this.resolveLineIns());
      return;
    }

    if (normalized === '/api/linein/bridges') {
      if (req.method !== 'GET') {
        this.sendJson(res, 405, { error: 'method-not-allowed' });
        return;
      }
      this.sendJson(res, 200, this.listBridges());
      return;
    }

    if (normalized === '/api/linein/bridges/register') {
      if (req.method !== 'POST') {
        this.sendJson(res, 405, { error: 'method-not-allowed' });
        return;
      }
      const body = (await this.readJsonBody(req)) as BridgeRegistrationPayload | null;
      const bridgeId = (body?.bridge_id ?? '').trim();
      if (!bridgeId) {
        this.sendJson(res, 400, { error: 'missing-bridge-id' });
        return;
      }
      this.registerBridge(bridgeId, body ?? {});
      this.log.info('line-in bridge registered', {
        bridgeId,
        hostname: body?.hostname,
        ip: body?.ip,
        mac: body?.mac,
      });
      await this.persistBridgeRecord(bridgeId, body ?? {}, false);
      this.sendJson(res, 200, this.buildBridgeConfigResponse(bridgeId, req));
      return;
    }

    const bridgeStatusMatch = normalized.match(/^\/api\/linein\/bridges\/([^/]+)\/status$/);
    if (bridgeStatusMatch) {
      if (req.method !== 'POST') {
        this.sendJson(res, 405, { error: 'method-not-allowed' });
        return;
      }
      const bridgeId = decodeURIComponent(bridgeStatusMatch[1] ?? '').trim();
      if (!bridgeId) {
        this.sendJson(res, 400, { error: 'missing-bridge-id' });
        return;
      }
      const body = await this.readJsonBody(req);
      if (!body || typeof body !== 'object') {
        this.sendJson(res, 400, { error: 'invalid-body' });
        return;
      }
      this.upsertBridgeStatus(bridgeId, body as BridgeStatusPayload);
      if ((body as BridgeStatusPayload).track_change === true) {
        const inputId = this.resolveBridgeAssignments().get(bridgeId) ?? null;
        if (inputId) {
          this.metadataService.handleTrackChange(inputId);
        }
      }
      this.log.spam('line-in bridge status', {
        bridgeId,
        state: (body as BridgeStatusPayload).state,
        device: (body as BridgeStatusPayload).device,
      });
      if (Array.isArray((body as BridgeStatusPayload).capture_devices)) {
        await this.persistBridgeRecord(bridgeId, body as BridgeStatusPayload, true);
      }
      this.sendJson(res, 200, this.buildBridgeConfigResponse(bridgeId, req));
      return;
    }

    const bridgeDeleteMatch = normalized.match(/^\/api\/linein\/bridges\/([^/]+)$/);
    if (bridgeDeleteMatch) {
      if (req.method !== 'DELETE') {
        this.sendJson(res, 405, { error: 'method-not-allowed' });
        return;
      }
      const bridgeId = decodeURIComponent(bridgeDeleteMatch[1] ?? '').trim();
      if (!bridgeId) {
        this.sendJson(res, 400, { error: 'missing-bridge-id' });
        return;
      }
      const assignments = this.resolveBridgeAssignments();
      if (assignments.has(bridgeId)) {
        this.sendJson(res, 409, { error: 'bridge-assigned' });
        return;
      }
      await this.configPort.updateConfig((cfg) => {
        if (!cfg.inputs?.lineIn?.bridges) return;
        cfg.inputs.lineIn.bridges = cfg.inputs.lineIn.bridges.filter(
          (bridge) => bridge.bridge_id !== bridgeId,
        );
      });
      this.bridgesById.delete(bridgeId);
      this.statusByBridgeId.delete(bridgeId);
      res.writeHead(204);
      res.end();
      return;
    }

    const ingestMatch = normalized.match(/^\/api\/linein\/([^/]+)\/ingest$/);
    if (ingestMatch) {
      if (req.method !== 'GET') {
        this.sendJson(res, 405, { error: 'method-not-allowed' });
        return;
      }
      const inputId = decodeURIComponent(ingestMatch[1] ?? '').trim();
      if (!inputId) {
        this.sendJson(res, 400, { error: 'missing-linein-id' });
        return;
      }
      const entry = this.findLineInById(inputId);
      if (!entry) {
        this.sendJson(res, 404, { error: 'linein-not-found' });
        return;
      }
      const ingest = this.resolveIngestTarget(req);
      const vad = this.resolveVadConfig(entry);
      this.sendJson(res, 200, { linein_id: inputId, ...ingest, ...vad });
      return;
    }

    const statusMatch = normalized.match(/^\/api\/linein\/([^/]+)\/bridge-status$/);
    if (statusMatch) {
      if (req.method === 'GET') {
        const inputId = decodeURIComponent(statusMatch[1] ?? '').trim();
        if (!inputId) {
          this.sendJson(res, 400, { error: 'missing-linein-id' });
          return;
        }
        if (!this.resolveLineIns().some((entry) => entry.id === inputId)) {
          this.sendJson(res, 404, { error: 'linein-not-found' });
          return;
        }
        this.sendJson(res, 200, this.buildStatusResponse(inputId));
        return;
      }
      if (req.method !== 'POST') {
        this.sendJson(res, 405, { error: 'method-not-allowed' });
        return;
      }
      const inputId = decodeURIComponent(statusMatch[1] ?? '').trim();
      if (!inputId) {
        this.sendJson(res, 400, { error: 'missing-linein-id' });
        return;
      }
      if (!this.resolveLineIns().some((entry) => entry.id === inputId)) {
        this.sendJson(res, 404, { error: 'linein-not-found' });
        return;
      }
      const body = await this.readJsonBody(req);
      if (!body || typeof body !== 'object') {
        this.sendJson(res, 400, { error: 'invalid-body' });
        return;
      }
      this.statusByBridgeId.set(inputId, {
        payload: body as BridgeStatusPayload,
        receivedAt: Date.now(),
      });
      if ((body as BridgeStatusPayload).track_change === true) {
          this.metadataService.handleTrackChange(inputId);
      }
      this.sendJson(res, 200, this.buildLineInConfigResponse(inputId, req));
      return;
    }

    this.sendJson(res, 404, { error: 'not-found' });
  }

  private resolveLineIns(): LineInSummary[] {
    const config = this.configPort.getConfig();
    const entries = Array.isArray(config.inputs?.lineIn?.inputs)
      ? config.inputs!.lineIn!.inputs!
      : [];
    const macId = this.resolveMacId();
    return entries.map((entry, index) => {
      const record = entry && typeof entry === 'object' ? (entry as LineInInputConfig) : {};
      const id = typeof record.id === 'string' && record.id.trim()
        ? record.id.trim()
        : `${macId}#${LINEIN_ID_START + index}`;
      const name = typeof record.name === 'string' && record.name.trim()
        ? record.name.trim()
        : `${DEFAULT_LINEIN_NAME}${index + 1}`;
      return { id, name };
    });
  }

  private findLineInById(id: string): LineInInputConfig | null {
    const config = this.configPort.getConfig();
    const entries = Array.isArray(config.inputs?.lineIn?.inputs)
      ? config.inputs!.lineIn!.inputs!
      : [];
    const resolved = this.resolveLineIns();
    const index = resolved.findIndex((entry) => entry.id === id);
    if (index < 0) return null;
    return (entries[index] ?? null) as LineInInputConfig | null;
  }

  private resolveVadConfig(entry: LineInInputConfig): { vad_threshold_db?: number; vad_hold_ms?: number } {
    const source = entry.source && typeof entry.source === 'object' ? (entry.source as Record<string, unknown>) : {};
    const vad_threshold_db =
      typeof source.vad_threshold_db === 'number' ? source.vad_threshold_db : undefined;
    const vad_hold_ms = typeof source.vad_hold_ms === 'number' ? source.vad_hold_ms : undefined;
    return { vad_threshold_db, vad_hold_ms };
  }

  private resolveCaptureDevice(entry: LineInInputConfig): { capture_device?: string } {
    const source = entry.source && typeof entry.source === 'object' ? (entry.source as Record<string, unknown>) : {};
    const capture_device =
      typeof source.capture_device === 'string' && source.capture_device.trim()
        ? source.capture_device.trim()
        : undefined;
    return { capture_device };
  }

  private resolveMacId(): string {
    const macId = this.configPort.getConfig()?.system?.audioserver?.macId?.trim().toUpperCase();
    return macId || 'UNKNOWN';
  }

  private resolveIngestTarget(req: IncomingMessage): { ingest_tcp_host: string; ingest_tcp_port: number } {
    const hostFromConfig = this.configPort.getConfig()?.system?.audioserver?.ip?.trim();
    const hostFromHeader = (req.headers.host ?? '').split(':')[0]?.trim();
    const ingest_tcp_host = hostFromConfig || hostFromHeader || defaultLocalIp();
    return { ingest_tcp_host, ingest_tcp_port: 7080 };
  }

  private buildLineInConfigResponse(
    inputId: string,
    req: IncomingMessage,
  ): {
    linein_id: string;
    ingest_tcp_host: string;
    ingest_tcp_port: number;
    ingest_sample_rate?: number;
    ingest_resampler?: string;
    capture_device?: string;
    vad_threshold_db?: number;
    vad_hold_ms?: number;
  } {
    const entry = this.findLineInById(inputId);
    const ingest = this.resolveIngestTarget(req);
    const vad = entry ? this.resolveVadConfig(entry) : {};
    const capture = entry ? this.resolveCaptureDevice(entry) : {};
    return {
      linein_id: inputId,
      ...ingest,
      ingest_sample_rate: resolveLineInSampleRate(entry),
      ingest_resampler: resolveLineInIngestResampler(entry),
      ...capture,
      ...vad,
    };
  }


  private normalizePath(pathname: string): string | null {
    const raw = (pathname.split('?')[0] ?? '').trim();
    if (!raw.startsWith('/api/linein')) {
      return null;
    }
    return raw.replace(/\/+$/, '') || '/api/linein';
  }

  private async readJsonBody(req: IncomingMessage): Promise<unknown | null> {
    const chunks: Buffer[] = [];
    return new Promise((resolve) => {
      req.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(null);
        }
      });
      req.on('error', () => resolve(null));
    });
  }

  private buildStatusResponse(inputId: string): {
    linein_id: string;
    bridge_id: string | null;
    connected: boolean;
    state: string | null;
    received_at: string | null;
    device: string | null;
  } {
    const bridgeId = this.resolveBridgeIdForInput(inputId);
    const snapshot = this.statusByBridgeId.get(bridgeId ?? inputId) ?? null;
    const receivedAt = snapshot?.receivedAt ?? 0;
    const connected = receivedAt > 0 && Date.now() - receivedAt <= STATUS_STALE_MS;
    return {
      linein_id: inputId,
      bridge_id: bridgeId,
      connected,
      state: snapshot?.payload?.state ?? null,
      received_at: receivedAt ? new Date(receivedAt).toISOString() : null,
      device: snapshot?.payload?.device ?? null,
    };
  }

  private resolveBridgeIdForInput(inputId: string): string | null {
    const entry = this.findLineInById(inputId);
    if (!entry?.source || typeof entry.source !== 'object') {
      return null;
    }
    const bridgeId = String((entry.source as Record<string, unknown>).bridge_id ?? '').trim();
    return bridgeId || null;
  }

  private registerBridge(bridgeId: string, payload: BridgeRegistrationPayload): void {
    const record = this.bridgesById.get(bridgeId) ?? {
      bridgeId,
      captureDevices: [],
      lastSeen: 0,
    };
    record.hostname = payload.hostname ?? record.hostname;
    record.version = payload.version ?? record.version;
    record.ip = payload.ip ?? record.ip;
    record.mac = payload.mac ?? record.mac;
    if (Array.isArray(payload.capture_devices) && payload.capture_devices.length > 0) {
      record.captureDevices = payload.capture_devices;
    }
    record.lastSeen = Date.now();
    this.bridgesById.set(bridgeId, record);
  }

  private upsertBridgeStatus(bridgeId: string, payload: BridgeStatusPayload): void {
    const record = this.bridgesById.get(bridgeId) ?? {
      bridgeId,
      captureDevices: [],
      lastSeen: 0,
    };
    record.lastSeen = Date.now();
    if (Array.isArray(payload.capture_devices) && payload.capture_devices.length > 0) {
      record.captureDevices = payload.capture_devices;
    }
    this.bridgesById.set(bridgeId, record);
    this.statusByBridgeId.set(bridgeId, { payload, receivedAt: Date.now() });
  }

  private listBridges(): Array<{
    bridge_id: string;
    hostname?: string;
    version?: string;
    ip?: string;
    mac?: string;
    assigned_input_id: string | null;
    last_seen: string | null;
    capture_devices: BridgeCaptureDevice[];
  }> {
    const assignments = this.resolveBridgeAssignments();
    const configBridges = this.readBridgeConfigs();
    const seen = new Set<string>();
    const merged: BridgeRecord[] = [];

    configBridges.forEach((cfg) => {
      const bridgeId = cfg.bridge_id;
      const live = this.bridgesById.get(bridgeId);
      const liveDevices = live?.captureDevices ?? [];
      const configDevices = cfg.capture_devices ?? [];
      merged.push({
        bridgeId,
        hostname: live?.hostname ?? cfg.hostname,
        version: live?.version ?? cfg.version,
        ip: live?.ip ?? cfg.ip,
        mac: live?.mac ?? cfg.mac,
        captureDevices: liveDevices.length ? liveDevices : configDevices,
        lastSeen: live?.lastSeen ?? (cfg.last_seen ? Date.parse(cfg.last_seen) : 0),
      });
      seen.add(bridgeId);
    });

    this.bridgesById.forEach((bridge) => {
      if (seen.has(bridge.bridgeId)) {
        return;
      }
      merged.push(bridge);
    });

    return merged
      .sort((a, b) => a.bridgeId.localeCompare(b.bridgeId))
      .map((bridge) => ({
        bridge_id: bridge.bridgeId,
        hostname: bridge.hostname,
        version: bridge.version,
        ip: bridge.ip,
        mac: bridge.mac,
        assigned_input_id: assignments.get(bridge.bridgeId) ?? null,
        last_seen: bridge.lastSeen ? new Date(bridge.lastSeen).toISOString() : null,
        capture_devices: bridge.captureDevices,
      }));
  }

  private resolveBridgeAssignments(): Map<string, string> {
    const config = this.configPort.getConfig();
    const entries = Array.isArray(config.inputs?.lineIn?.inputs)
      ? config.inputs!.lineIn!.inputs!
      : [];
    const resolved = this.resolveLineIns();
    const result = new Map<string, string>();
    entries.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') return;
      const source = entry.source && typeof entry.source === 'object' ? entry.source : null;
      if (!source) return;
      const bridgeId = String((source as Record<string, unknown>).bridge_id ?? '').trim();
      if (!bridgeId) return;
      const inputId = resolved[index]?.id;
      if (!inputId) return;
      if (!result.has(bridgeId)) {
        result.set(bridgeId, inputId);
      }
    });
    return result;
  }

  private buildBridgeConfigResponse(
    bridgeId: string,
    req: IncomingMessage,
  ): {
    bridge_id: string;
    assigned_input_id: string | null;
    ingest_tcp_host?: string;
    ingest_tcp_port?: number;
    ingest_sample_rate?: number;
    ingest_resampler?: string;
    capture_device?: string;
    vad_threshold_db?: number;
    vad_hold_ms?: number;
  } {
    const assignments = this.resolveBridgeAssignments();
    const inputId = assignments.get(bridgeId) ?? null;
    if (!inputId) {
      return { bridge_id: bridgeId, assigned_input_id: null };
    }
    const entry = this.findLineInById(inputId);
    const ingest = this.resolveIngestTarget(req);
    const vad = entry ? this.resolveVadConfig(entry) : {};
    const capture = entry ? this.resolveCaptureDevice(entry) : {};
    return {
      bridge_id: bridgeId,
      assigned_input_id: inputId,
      ...ingest,
      ingest_sample_rate: resolveLineInSampleRate(entry),
      ingest_resampler: resolveLineInIngestResampler(entry),
      ...capture,
      ...vad,
    };
  }

  private readBridgeConfigs(): LineInBridgeConfig[] {
    const config = this.configPort.getConfig();
    const bridges = config.inputs?.lineIn?.bridges;
    return Array.isArray(bridges) ? bridges : [];
  }

  private async persistBridgeRecord(
    bridgeId: string,
    payload: BridgeRegistrationPayload | BridgeStatusPayload,
    updateDevicesOnly: boolean,
  ): Promise<void> {
    await this.configPort.updateConfig((cfg) => {
      if (!cfg.inputs) cfg.inputs = {};
      if (!cfg.inputs.lineIn) cfg.inputs.lineIn = { inputs: [], bridges: [] };
      if (!Array.isArray(cfg.inputs.lineIn.bridges)) {
        cfg.inputs.lineIn.bridges = [];
      }
      const bridges = cfg.inputs.lineIn.bridges;
      const idx = bridges.findIndex((b) => b.bridge_id === bridgeId);
      const current: LineInBridgeConfig =
        idx >= 0 ? bridges[idx] : { bridge_id: bridgeId };
      const next: LineInBridgeConfig = {
        bridge_id: bridgeId,
        hostname: updateDevicesOnly ? current.hostname : ('hostname' in payload ? payload.hostname : current.hostname),
        version: updateDevicesOnly ? current.version : ('version' in payload ? payload.version : current.version),
        ip: updateDevicesOnly ? current.ip : ('ip' in payload ? payload.ip : current.ip),
        mac: updateDevicesOnly ? current.mac : ('mac' in payload ? payload.mac : current.mac),
        capture_devices: Array.isArray((payload as BridgeRegistrationPayload).capture_devices) &&
          (payload as BridgeRegistrationPayload).capture_devices!.length > 0
          ? (payload as BridgeRegistrationPayload).capture_devices
          : current.capture_devices ?? [],
        last_seen: current.last_seen,
      };
      if (idx >= 0) {
        bridges[idx] = next;
      } else {
        bridges.push(next);
      }
    });
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }
}
