import { API_BASE } from '../config/apiConfig';

export type AlertFile = {
  id: string;
  filename: string;
  url: string;
  hasBackup?: boolean;
};

type AlertListResponse = {
  alerts?: AlertFile[];
};

export async function fetchAlertFiles(): Promise<AlertListResponse> {
  const res = await fetch(`${API_BASE}/alerts/files`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to load alerts');
  }
  return (await res.json()) as AlertListResponse;
}

export async function uploadAlertFile(alertId: string, base64Data: string): Promise<void> {
  const res = await fetch(`${API_BASE}/alerts/files/${encodeURIComponent(alertId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: base64Data }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to update alert');
  }
}

export async function revertAlertFile(alertId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/alerts/files/${encodeURIComponent(alertId)}/revert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to revert alert');
  }
}
