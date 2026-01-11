import { API_BASE } from '../config/apiConfig';

export async function getConfig(): Promise<unknown> {
  const res = await fetch(`${API_BASE}/config`);
  if (!res.ok) throw new Error('Failed to fetch configuration');
  return res.json();
}

export async function clearServerConfig(): Promise<void> {
  const res = await fetch(`${API_BASE}/config/clear`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to clear configuration');
}

export async function importServerConfig(config: unknown): Promise<void> {
  const res = await fetch(`${API_BASE}/config/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to import configuration');
  }
}

export async function reinitializeServer(): Promise<void> {
  const res = await fetch(`${API_BASE}/setup/reinitialize`, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to reinitialize');
  }
}

export async function updateAudioServerMacId(macId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/config/system`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audioserver: { macId } }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to update macId');
  }
}

export async function updateAudioServerIp(ip: string): Promise<void> {
  const res = await fetch(`${API_BASE}/config/system`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audioserver: { ip } }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to update ip');
  }
}
