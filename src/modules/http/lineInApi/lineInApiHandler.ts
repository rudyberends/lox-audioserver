import type { IncomingMessage, ServerResponse } from 'node:http';
import { defaultLocalIp } from '@/core/utils/net';
import { getConfig } from '@/domain/config/configStore';
import type { LineInInputConfig } from '@/domain/config/types';

type LineInSummary = {
  id: string;
  name: string;
};

type BridgeStatusPayload = {
  state?: string;
  device?: string;
  rate?: number;
  channels?: number;
  format?: string;
  rms_db?: number | null;
  last_error?: string | null;
};

type BridgeStatusSnapshot = {
  payload: BridgeStatusPayload;
  receivedAt: number;
};

const LINEIN_ID_START = 1000001;
const DEFAULT_LINEIN_NAME = 'LineIn';
const STATUS_STALE_MS = 15000;

export class LineInApiHandler {
  private readonly statusById = new Map<string, BridgeStatusSnapshot>();

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
      this.statusById.set(inputId, {
        payload: body as BridgeStatusPayload,
        receivedAt: Date.now(),
      });
      res.writeHead(204);
      res.end();
      return;
    }

    this.sendJson(res, 404, { error: 'not-found' });
  }

  private resolveLineIns(): LineInSummary[] {
    const config = getConfig();
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
    const config = getConfig();
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

  private resolveMacId(): string {
    const macId = getConfig()?.system?.audioserver?.macId?.trim().toUpperCase();
    return macId || 'UNKNOWN';
  }

  private resolveIngestTarget(req: IncomingMessage): { ingest_tcp_host: string; ingest_tcp_port: number } {
    const hostFromConfig = getConfig()?.system?.audioserver?.ip?.trim();
    const hostFromHeader = (req.headers.host ?? '').split(':')[0]?.trim();
    const ingest_tcp_host = hostFromConfig || hostFromHeader || defaultLocalIp();
    return { ingest_tcp_host, ingest_tcp_port: 7080 };
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
    connected: boolean;
    state: string | null;
    received_at: string | null;
  } {
    const snapshot = this.statusById.get(inputId) ?? null;
    const receivedAt = snapshot?.receivedAt ?? 0;
    const connected = receivedAt > 0 && Date.now() - receivedAt <= STATUS_STALE_MS;
    return {
      linein_id: inputId,
      connected,
      state: snapshot?.payload?.state ?? null,
      received_at: receivedAt ? new Date(receivedAt).toISOString() : null,
    };
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }
}
