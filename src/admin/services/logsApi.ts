import { API_BASE } from '../config/apiConfig';

export interface LogsResponse {
  log?: string;
  limit?: number;
  missing?: boolean;
  updatedAt?: string;
  size?: number;
  truncated?: boolean;
  consoleLevel?: string;
}

export async function fetchLogs(): Promise<LogsResponse> {
  const res = await fetch(`${API_BASE}/logs`);
  if (!res.ok) {
    throw new Error('Failed to fetch logs');
  }
  return res.json() as Promise<LogsResponse>;
}

export function openLogsStream(): EventSource | null {
  if (typeof EventSource === 'undefined') return null;
  return new EventSource(`${API_BASE}/logs/stream`);
}

export async function updateLogLevel(level: string): Promise<void> {
  const res = await fetch(`${API_BASE}/logs/level`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ level }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to update log level');
  }
}
