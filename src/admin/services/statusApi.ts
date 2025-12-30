import { API_BASE } from '../config/apiConfig';

export interface StatusResponse {
  version?: string;
  uptime?: number;
  name?: string;
  serial?: string;
  firmwareVersion?: string;
  apiVersion?: string;
  zones?: number;
  activeAdapters?: number;
  paired?: boolean;
}

export async function fetchStatus(signal?: AbortSignal): Promise<StatusResponse> {
  const res = await fetch(`${API_BASE}/info`, { signal });
  if (!res.ok) {
    throw new Error(`Failed to fetch status (${res.status})`);
  }
  return (await res.json()) as StatusResponse;
}
