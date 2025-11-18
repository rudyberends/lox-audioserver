/**
 * Typesafe API client for Admin UI.
 * Mirrors original apiClient.js behavior, but with TypeScript types.
 */
import type { Zone, Group, Config, LogEntry } from './types';

const API_PREFIX = '/admin/api';

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

interface RequestOptions<TBody extends JsonValue | undefined = undefined> {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: TBody;
}

/**
 * Generic JSON request helper with strict typing.
 * Accepts JSON body and returns parsed JSON or string for non-JSON payloads.
 */
async function request<TResponse = unknown, TBody extends JsonValue | undefined = undefined>(
  path: string,
  { method = 'GET', body }: RequestOptions<TBody> = {}
): Promise<TResponse> {
  const url = `${API_PREFIX}${path}`;

  const init: RequestInit = {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };

  const response = await fetch(url, init);
  const text = await response.text();

  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && payload !== null && 'message' in (payload as any)
        ? String((payload as any).message)
        : `HTTP ${response.status}`;
    throw new Error(message);
  }

  return payload as TResponse;
}

/* ----------------------------- API functions ----------------------------- */

export function getConfig(): Promise<Config> {
  return request<Config>('/config');
}

export function saveConfig(config: Config): Promise<{ ok: true } | Config | unknown> {
  // Original returned payload is passed through; keep type flexible on response.
  return request<{ ok: true } | Config | unknown, { config: Config }>('/config', {
    method: 'POST',
    body: { config },
  });
}

export function reloadConfig(): Promise<{ ok: true } | unknown> {
  return request<{ ok: true } | unknown>('/config/reload', { method: 'POST' });
}

export function clearConfig(): Promise<{ ok: true } | unknown> {
  return request<{ ok: true } | unknown>('/config/clear', { method: 'POST' });
}

export function connectZoneApi(playerId: string, zone: string | number): Promise<{ ok: true } | unknown> {
  return request<{ ok: true } | unknown, { playerId: string; zone: string | number }>('/zones/connect', {
    method: 'POST',
    body: { playerId, zone },
  });
}

export function validateAdapterConfig(type: string, parameters: Record<string, unknown>): Promise<{ valid: boolean; message?: string } | unknown> {
  return request<{ valid: boolean; message?: string } | unknown, { type: string; parameters: Record<string, unknown> }>(
    '/adapters/validate',
    { method: 'POST', body: { type, parameters } }
  );
}

export function fetchZoneStatesApi(): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>('/zones/states');
}

export function fetchMusicAssistantPlayersApi(payload: Record<string, unknown>): Promise<unknown> {
  return request<unknown, Record<string, unknown>>('/musicassistant/players', { method: 'POST', body: payload });
}

export function fetchLogsApi(): Promise<LogEntry[]> {
  return request<LogEntry[]>('/logs');
}

export function updateLogLevelApi(level: string): Promise<{ ok: true } | unknown> {
  return request<{ ok: true } | unknown, { level: string }>('/logs/level', { method: 'POST', body: { level } });
}

export function openLogsStream(): EventSource {
  return new EventSource(`${API_PREFIX}/logs/stream`);
}

/* Convenience exports for zones, groups if needed in future:
 * If your backend exposes /zones and /groups endpoints returning arrays, you can add:
 *
 * export function getZones(): Promise<Zone[]> { return request<Zone[]>('/zones'); }
 * export function getGroups(): Promise<Group[]> { return request<Group[]>('/groups'); }
 */
